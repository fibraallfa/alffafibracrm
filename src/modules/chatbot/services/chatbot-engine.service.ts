import type { Prisma } from "@prisma/client";
import { CepRepository } from "@/repositories/cep.repository";
import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { OpenAiService } from "@/services/openai/openai.service";
import type { ExtractedCustomerData } from "@/services/openai/openai.service";
import { ZapiService } from "@/services/zapi/zapi.service";
import { onlyDigits } from "@/utils/mask";

const VALID_BILLING_DAYS = [5, 8, 10, 15, 20, 25];

export class ChatbotEngineService {
  constructor(
    private readonly cepRepository = new CepRepository(),
    private readonly chatbotRepository = new ChatbotRepository(),
    private readonly zapiService = new ZapiService(),
    private readonly openAiService = new OpenAiService(),
  ) {}

  async validateCoverage(cep: string) {
    return this.cepRepository.findByCep(cep);
  }

  async handleIncomingCall(input: {
    phone: string;
    providerId?: string;
    rawPayload?: Prisma.InputJsonValue;
    instanceId?: string;
  }) {
    const phone = normalizeWhatsappPhone(input.phone);
    const agent = await this.chatbotRepository.getAgentByInstance(input.instanceId);
    const conversation = await this.chatbotRepository.findOrCreateConversation(phone, agent?.id);
    const eventId = input.providerId ? `call:${input.providerId}` : undefined;

    if (eventId) {
      const existing = await this.chatbotRepository.findMessageByProviderId(eventId);
      if (existing) return { state: conversation.state, replied: false, duplicated: true };
      const claimed = await this.chatbotRepository.claimInboundMessage({
        conversationId: conversation.id,
        body: "[Ligação recebida]",
        providerId: eventId,
        rawPayload: input.rawPayload ?? {},
      });
      if (!claimed) return { state: conversation.state, replied: false, duplicated: true };
    } else {
      await this.chatbotRepository.saveMessage({
        conversationId: conversation.id,
        direction: "inbound",
        body: "[Ligação recebida]",
        rawPayload: input.rawPayload ?? {},
      });
    }

    const memory = normalizeMemory(conversation.memory);
    const resumePrompt = callResumePrompt(conversation.state, memory, agent);
    const reply = `Não consigo atender ligações por aqui, mas continuo com você pelo WhatsApp. 😊\n\n${resumePrompt}`;
    await this.zapiService.sendText({ phone, message: reply, config: agentConfig(agent) });
    await this.chatbotRepository.saveMessage({
      conversationId: conversation.id,
      direction: "outbound",
      body: reply,
    });

    return { state: conversation.state, replied: true, duplicated: false };
  }

  async processIncomingMessage(input: {
    phone: string;
    message: string;
    providerId?: string;
    rawPayload?: Prisma.InputJsonValue;
    instanceId?: string;
    extractedData?: ExtractedCustomerData;
  }) {
    const phone = normalizeWhatsappPhone(input.phone);
    let alreadyReceived = false;

    if (input.providerId) {
      const existingMessage = await this.chatbotRepository.findMessageByProviderId(input.providerId);
      if (existingMessage) {
        const alreadyReplied = await this.chatbotRepository.hasOutboundResponseAfter(
          existingMessage.conversationId,
          existingMessage.createdAt,
        );
        if (alreadyReplied) {
          return { state: "DUPLICATED", replied: false, delayMs: 0 };
        }
        alreadyReceived = true;
      }
    }

    const agent = await this.chatbotRepository.getAgentByInstance(input.instanceId);
    const conversation = await this.chatbotRepository.findOrCreateConversation(phone, agent?.id);

    if (!alreadyReceived && input.providerId) {
      const claimed = await this.chatbotRepository.claimInboundMessage({
        conversationId: conversation.id,
        body: input.message,
        providerId: input.providerId,
        rawPayload: input.rawPayload ?? {},
      });
      if (!claimed) {
        return { state: "DUPLICATED", replied: false, delayMs: 0 };
      }
    } else if (!alreadyReceived) {
      await this.chatbotRepository.saveMessage({
        conversationId: conversation.id,
        direction: "inbound",
        body: input.message,
        rawPayload: input.rawPayload ?? {},
      });
    }

    if (conversation.ownerUserId) {
      return { state: conversation.state, replied: false, delayMs: 0 };
    }

    if (input.providerId) {
      await this.zapiService.markAsRead(input.providerId, phone, agentConfig(agent));
    }

    const next = await this.nextResponse({
      phone,
      message: input.message,
      state: conversation.state,
      memory: normalizeMemory(conversation.memory),
      agent,
      extractedData: input.extractedData,
    });

    const minTyping = agent?.minTypingSeconds ?? 2;
    const maxTyping = agent?.maxTypingSeconds ?? 4;
    const delaySeconds = randomDelaySeconds(minTyping, maxTyping);
    const typingEnabled =
      (agent?.enableReplyDelay ?? true) && (agent?.enableTyping ?? true);

    await this.zapiService.sendText({
      phone,
      message: next.reply,
      delayTypingSeconds: typingEnabled ? delaySeconds : undefined,
      config: agentConfig(agent),
    });
    await this.chatbotRepository.saveMessage({
      conversationId: conversation.id,
      direction: "outbound",
      body: next.reply,
    });
    await this.chatbotRepository.updateConversation({
      id: conversation.id,
      state: next.state,
      memory: next.memory as Prisma.InputJsonValue,
      leadId: next.leadId,
    });

    return { state: next.state, replied: true, delayMs: typingEnabled ? delaySeconds * 1000 : 0 };
  }

  private async nextResponse(input: {
    phone: string;
    message: string;
    state: string;
    memory: ChatMemory;
    agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>;
    extractedData?: ExtractedCustomerData;
  }): Promise<NextBotResponse> {
    const originalText = input.message.trim();
    const text = extractedValueForState(input.state, input.extractedData) ?? originalText;
    const memory = { ...input.memory };
    const firstName = getFirstName(memory.name);
    const messageFor = (state: string, fallback: string) => interpolate(
      flowMessage(input.agent?.flow, state, fallback),
      memory,
      input.agent?.name,
    );

    if (isRestartRequest(text)) {
      return {
        state: "ASK_CEP",
        memory: {},
        reply: messageFor("START", `Olá 👋! Eu sou o ${input.agent?.name ?? "Cris"}, consultor da Claro. Estou aqui pra facilitar seu atendimento. Pode me informar o CEP da instalação?`),
      };
    }

    if (isHandoffRequest(text)) {
      memory.handoff = true;
      return {
        state: "HUMAN_HANDOFF",
        memory,
        reply: "Combinado, vou sinalizar para um consultor humano continuar seu atendimento por aqui. 😊",
      };
    }

    if (input.extractedData && text === originalText) {
      return {
        state: input.state,
        memory,
        reply: `Recebi o arquivo ou áudio, mas não consegui identificar com segurança o dado necessário. Envie novamente com boa qualidade ou escreva a informação, por favor. 😊\n\n${promptForState(input.state, firstName)}`,
      };
    }

    if (asksForExplicitPlanRecommendation(text)) {
      const plans = await this.getPlans(input.agent);
      const recommended = findRecommendedPlan(plans);
      const recommendation = recommended
        ? `Para essa necessidade, recomendo o ${recommended.name} por ${formatMoney(Number(recommended.price))} + Globoplay (GRÁTIS). É a opção mais completa entre os planos disponíveis. 😊`
        : "No momento não há planos ativos vinculados a este atendimento.";
      return {
        state: input.state,
        memory,
        reply: `${recommendation}\n\n${promptForState(input.state, firstName)}`,
      };
    }

    if (asksForPlanList(text) || isExplicitPlanCatalogQuestion(text)) {
      const plans = await this.getPlans(input.agent);
      return {
        state: input.state,
        memory,
        reply: `Claro! 😊 Estes são os planos disponíveis:\n\n${formatPlanList(plans)}\n\n${promptForState(input.state, firstName)}`,
      };
    }

    const billingQuestion = this.tryHandleBillingQuestion({
      text,
      state: input.state,
      memory,
      firstName,
    });
    if (billingQuestion) {
      return billingQuestion;
    }

    if (shouldAnswerOutsideFlow(text, input.state)) {
      const answer = await this.answerOutsideFlow({
        message: text,
        state: input.state,
        agent: input.agent,
        customerName: memory.name,
        memory,
      });
      return {
        state: input.state,
        memory,
        reply: `${answer}\n\n${promptForState(input.state, firstName)}`,
      };
    }

    if (input.state === "START") {
      const cepFromStart = parseCep(text);
      if (cepFromStart) {
        return this.handleCepStep({
          cep: cepFromStart,
          text,
          memory,
        });
      }

      return {
        state: "ASK_CEP",
        memory,
        reply: messageFor("START", `Olá 👋! Eu sou o ${input.agent?.name ?? "Cris"}, consultor da Claro. Estou aqui pra facilitar seu atendimento. Pode me informar o CEP da instalação?`),
      };
    }

    if (input.state === "ASK_CEP") {
      const cep = parseCep(text);
      if (!cep) {
        if (shouldUseAiFallbackForState("ASK_CEP", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_CEP",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_CEP", firstName)}`,
          };
        }

        return {
          state: "ASK_CEP",
          memory,
          reply: "Esse CEP parece incompleto. Pode me enviar os 8 números do CEP da instalação, por favor? 😊",
        };
      }

      return this.handleCepStep({ cep, text, memory });
    }

    if (input.state === "ASK_NAME") {
      const correctedCep = parseCep(text);
      if (correctedCep && (looksLikeAddressCorrection(text) || looksLikeCepOnlyMessage(text))) {
        return this.handleCepStep({
          cep: correctedCep,
          text,
          memory,
        });
      }

      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_NAME",
          memory,
          reply: "Sem problema 😊 Fico por aqui. Quando puder, me envie seu nome completo para continuarmos.",
        };
      }

      if (looksLikeAddressCorrection(text)) {
        return {
          state: "ASK_NAME",
          memory,
          reply: "Sem problema 😊 Me envie o CEP correto da instalação para eu atualizar o endereço e continuar seu atendimento.",
        };
      }

      const fullName = parseFullName(text);
      if (!fullName) {
        if (shouldUseAiFallbackForState("ASK_NAME", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_NAME",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_NAME", firstName)}`,
          };
        }

        return { state: "ASK_NAME", memory, reply: "Pode me informar seu nome completo, por favor? 😊" };
      }
      memory.name = fullName;
      return {
        state: "ASK_DOCUMENT",
        memory,
        reply: `Ótimo, ${getFirstName(memory.name)}! 😊 Agora, por favor, me informe o seu CPF ou CNPJ.`,
      };
    }

    if (input.state === "ASK_DOCUMENT") {
      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_DOCUMENT",
          memory,
          reply: `${getFirstName(memory.name) || "Perfeito"} 😊 Fico no aguardo. Quando puder, me envie seu CPF ou CNPJ para seguirmos.`,
        };
      }

      const document = parseDocument(text);
      if (!document.valid) {
        if (shouldUseAiFallbackForState("ASK_DOCUMENT", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_DOCUMENT",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_DOCUMENT", firstName)}`,
          };
        }

        return {
          state: "ASK_DOCUMENT",
          memory,
          reply: "Esse CPF ou CNPJ não parece válido. Pode conferir e me enviar novamente, por favor? 😊",
        };
      }
      memory.cpfCnpj = document.formatted;
      memory.documentType = document.type;
      return {
        state: "ASK_BIRTH_DATE",
        memory,
        reply: `${document.type} válido! ✅ Agora, por favor, me informe a sua data de nascimento.`,
      };
    }

    if (input.state === "ASK_BIRTH_DATE") {
      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_BIRTH_DATE",
          memory,
          reply: "Tranquilo 😊 Quando puder, me envie sua data de nascimento no formato 26/01/1998 para continuarmos.",
        };
      }

      const birthDate = parseBirthDate(text);
      if (!birthDate) {
        if (shouldUseAiFallbackForState("ASK_BIRTH_DATE", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_BIRTH_DATE",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_BIRTH_DATE", firstName)}`,
          };
        }

        return {
          state: "ASK_BIRTH_DATE",
          memory,
          reply: "Não consegui identificar a data. Pode enviar no formato 26/01/1998, por favor? 😊",
        };
      }
      memory.birthDate = birthDate.toISOString();
      return {
        state: "ASK_STREET_NUMBER",
        memory,
        reply: `Data de nascimento aceita! 🎉 Para confirmar, você nasceu no dia ${formatDate(birthDate)}. Agora, por favor, me informe o número da sua residência.`,
      };
    }

    if (input.state === "ASK_STREET_NUMBER") {
      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_STREET_NUMBER",
          memory,
          reply: "Tudo certo 😊 Quando puder, me informe só o número da residência para eu seguir com o cadastro.",
        };
      }

      const streetNumber = parseSimpleNumber(text);
      if (!streetNumber) {
        if (shouldUseAiFallbackForState("ASK_STREET_NUMBER", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_STREET_NUMBER",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_STREET_NUMBER", firstName)}`,
          };
        }

        return {
          state: "ASK_STREET_NUMBER",
          memory,
          reply: "Pode me informar somente o número da residência, por favor? 😊",
        };
      }
      memory.streetNumber = streetNumber;
      return {
        state: "ASK_COMPLEMENT",
        memory,
        reply: "Perfeito! Agora, você poderia me informar se há algum complemento para o endereço?",
      };
    }

    if (input.state === "ASK_COMPLEMENT") {
      if (looksLikeAddressCorrection(text)) {
        const correctedCep = parseCep(text);
        if (correctedCep) {
          return this.handleCepStep({
            cep: correctedCep,
            text,
            memory,
          });
        }

        return {
          state: "ASK_NAME",
          memory,
          reply: "Perfeito 😊 Me envie o CEP correto da instalação para eu atualizar o endereço e seguir com você.",
        };
      }

      if (shouldUseAiFallbackForState("ASK_COMPLEMENT", text)) {
        const answer = await this.answerOutsideFlow({
          message: text,
          state: input.state,
          agent: input.agent,
          customerName: memory.name,
          memory,
        });
        return {
          state: "ASK_COMPLEMENT",
          memory,
          reply: `${answer}\n\n${promptForState("ASK_COMPLEMENT", firstName)}`,
        };
      }

      memory.complement = normalizeComplement(text);
      return {
        state: "ASK_BILLING_DUE_DAY",
        memory,
        reply: `Ótimo, ${getFirstName(memory.name)}! 😊 Então, até agora temos:\n\n🏠 Endereço: ${formatFullAddress(memory)}\n\nAgora, por favor, me informe a data de vencimento. Pode ser 5, 8, 10, 15, 20 ou 25 do mês.`,
      };
    }

    if (input.state === "ASK_BILLING_DUE_DAY") {
      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_BILLING_DUE_DAY",
          memory,
          reply: "Sem problema 😊 Quando decidir, me diga qual vencimento você prefere: 5, 8, 10, 15, 20 ou 25.",
        };
      }

      const billingDay = parseBillingDay(text);
      if (!billingDay) {
        if (shouldUseAiFallbackForState("ASK_BILLING_DUE_DAY", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_BILLING_DUE_DAY",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_BILLING_DUE_DAY", firstName)}`,
          };
        }

        return {
          state: "ASK_BILLING_DUE_DAY",
          memory,
          reply: "A data de vencimento pode ser 5, 8, 10, 15, 20 ou 25. Qual você prefere? 📅",
        };
      }
      memory.billingDueDay = billingDay;
      return {
        state: "ASK_EMAIL",
        memory,
        reply: `Data de vencimento registrada como ${billingDay}. 📅\n\nAgora, preciso do seu e-mail, por favor! 😊`,
      };
    }

    if (input.state === "ASK_EMAIL") {
      if (looksLikeWaitMessage(text)) {
        return {
          state: "ASK_EMAIL",
          memory,
          reply: "Fico por aqui 😊 Quando puder, me envie seu e-mail para eu concluir essa etapa do cadastro.",
        };
      }

      const email = parseEmail(text);
      if (!email) {
        if (shouldUseAiFallbackForState("ASK_EMAIL", text)) {
          const answer = await this.answerOutsideFlow({
            message: text,
            state: input.state,
            agent: input.agent,
            customerName: memory.name,
            memory,
          });
          return {
            state: "ASK_EMAIL",
            memory,
            reply: `${answer}\n\n${promptForState("ASK_EMAIL", firstName)}`,
          };
        }

        return { state: "ASK_EMAIL", memory, reply: "Esse e-mail não parece válido. Pode me enviar novamente, por favor? 😊" };
      }
      memory.email = email;
      const plans = await this.getPlans(input.agent);
      const recommended = findRecommendedPlan(plans);
      memory.recommendedPlanId = recommended?.id;
      return {
        state: "RECOMMEND_PLAN",
        memory,
        reply: `Perfeito, ${getFirstName(memory.name)}! O e-mail registrado é: ${email}.\nAgora, vamos falar sobre o plano! Eu recomendo o ${recommended ? `${recommended.name} por ${formatMoney(Number(recommended.price))} + Globoplay (GRÁTIS)` : "melhor combo disponível"} 🚀. Você gostaria de seguir com esse plano ou prefere outra opção?`,
      };
    }

    if (input.state === "RECOMMEND_PLAN") {
      const plans = await this.getPlans(input.agent);
      const recommended = plans.find((plan) => plan.id === memory.recommendedPlanId) ?? findRecommendedPlan(plans);

      if (isPositive(text) && recommended) {
        return this.selectPlanAndConfirm({ memory, plan: recommended });
      }

      if (asksForPlanList(text) || isAlternativeRequest(text)) {
        return {
          state: "CHOOSE_PLAN",
          memory,
          reply: `Claro! 😊 Aqui estão as opções disponíveis:\n\n${formatPlanList(plans)}\n\nQual deles você gostaria de escolher?`,
        };
      }

      const selectedPlan = selectPlan(text, plans);
      if (selectedPlan) {
        return this.selectPlanAndConfirm({ memory, plan: selectedPlan });
      }

      if (isPlanRefusal(text)) {
        return this.handlePlanObjection({ text, state: "RECOMMEND_PLAN", memory, plans, agent: input.agent });
      }

      return {
        state: "CHOOSE_PLAN",
        memory,
        reply: `Sem problema 😊 Aqui estão as opções disponíveis:\n\n${formatPlanList(plans)}\n\nQual plano você prefere?`,
      };
    }

    if (input.state === "CHOOSE_PLAN") {
      const plans = await this.getPlans(input.agent);
      const selectedPlan = selectPlan(text, plans);

      if (!selectedPlan) {
        if (isPlanRefusal(text)) {
          return this.handlePlanObjection({ text, state: "CHOOSE_PLAN", memory, plans, agent: input.agent });
        }
        return {
          state: "CHOOSE_PLAN",
          memory,
          reply: `Claro! 😊 Estas são as opções disponíveis:\n\n${formatPlanList(plans)}\n\nMe diga o nome, velocidade ou número do plano que você quer contratar.`,
        };
      }

      return this.selectPlanAndConfirm({ memory, plan: selectedPlan });
    }

    if (input.state === "CONFIRM_DATA") {
      if (isPositive(text)) {
        const lead = await this.chatbotRepository.createLeadFromChat({
          name: memory.name ?? "Lead WhatsApp",
          phone: input.phone,
          email: memory.email,
          cpfCnpj: memory.cpfCnpj,
          birthDate: memory.birthDate ? new Date(memory.birthDate) : undefined,
          cep: memory.cep,
          address: memory.address,
          streetNumber: memory.streetNumber,
          complement: memory.complement,
          city: memory.city,
          state: memory.state,
          neighborhood: memory.neighborhood,
          billingDueDay: memory.billingDueDay,
          planId: memory.planId,
          planName: memory.planName,
          expectedValue: memory.planValue,
          notes: "Lead finalizado pelo fluxo do chatbot Cris.",
        });

        return {
          state: "FINISHED",
          memory,
          leadId: lead.id,
          reply: "Perfeito! 🎉 Seus dados foram confirmados.\n\nVou cadastrar aqui, deixa o celular ligado 📱, porque aprovando você receberá uma ligação da nossa central. Você precisa confirmar as informações do seu plano contratado, tudo bem?\n\nObrigado por escolher a Claro! 🚀 Se precisar de qualquer coisa, é só me chamar!",
        };
      }

      if (isNegative(text)) {
        return {
          state: "CORRECTION",
          memory,
          reply: "Entendi 😊, tudo bem! O que você gostaria de corrigir?",
        };
      }

      return {
        state: "CONFIRM_DATA",
        memory,
        reply: `${buildSummary(memory)}\n\nEstá tudo correto? ✅`,
      };
    }

    if (input.state === "CORRECTION") {
      const corrected = await this.applyCorrection(text, memory, input.agent);
      return {
        state: "CONFIRM_DATA",
        memory: corrected,
        reply: `${buildSummary(corrected)}\n\nEstá tudo correto? ✅`,
      };
    }

    if (input.state === "FINISHED_UNAVAILABLE") {
      return {
        state: "FINISHED_UNAVAILABLE",
        memory,
        reply: "Esse atendimento foi finalizado porque ainda não temos cobertura nesse CEP. Se quiser consultar outro endereço, envie reiniciar. 😊",
      };
    }

    if (input.state === "FINISHED") {
      const answer = await this.answerOutsideFlow({
        message: text,
        state: input.state,
        agent: input.agent,
        customerName: memory.name,
        memory,
      });
      return {
        state: "FINISHED",
        memory,
        reply: answer || "Sigo por aqui como seu consultor da Claro. Se quiser, posso te ajudar com outra dúvida, retomar a contratação ou consultar outro endereço. 😊",
      };
    }

    if (input.state === "HUMAN_HANDOFF") {
      return {
        state: "HUMAN_HANDOFF",
        memory,
        reply: "Seu atendimento está sinalizado para um consultor. Assim que possível, nossa equipe continua por aqui. 😊",
      };
    }

    return {
      state: "ASK_CEP",
      memory: {},
      reply: messageFor("START", `Olá 👋! Eu sou o ${input.agent?.name ?? "Cris"}, consultor da Claro. Estou aqui pra facilitar seu atendimento. Pode me informar o CEP da instalação?`),
    };
  }

  private async getPlans(agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>) {
    if (!agent) return this.chatbotRepository.listActivePlans();
    return this.chatbotRepository.listActivePlans(agent.id);
  }

  private async handleCepStep(input: {
    cep: string;
    text: string;
    memory: ChatMemory;
  }): Promise<NextBotResponse> {
    const memory = { ...input.memory, cep: input.cep };
    const [coverage, viaCep] = await Promise.all([this.validateCoverage(input.cep), fetchViaCep(input.cep)]);

    applyAddress(memory, {
      street: coverage?.street ?? viaCep?.street,
      neighborhood: coverage?.neighborhood ?? viaCep?.neighborhood,
      city: coverage?.city ?? viaCep?.city,
      state: coverage?.state ?? viaCep?.state,
    });
    applyAddressDetailsFromMessage(memory, input.text);

    if (!coverage) {
      return {
        state: "FINISHED_UNAVAILABLE",
        memory,
        reply: `Encontrei seu endereço 😊,📍 CEP ${formatCep(input.cep)}, localizado ${formatAddressShort(memory)}. No momento a Claro ainda não possui disponibilidade para instalação nessa região. Assim que houver expansão de cobertura, teremos prazer em atendê-lo. Obrigado pelo seu interesse! 💙`,
      };
    }

    return {
      state: "ASK_NAME",
      memory,
      reply: `Boa notícia 🎉! Temos viabilidade no CEP ${formatCep(input.cep)}, localizado ${formatAddressShort(memory)}. Consigo te atender com a Claro 🚀. Para seguir com a contratação, preciso coletar alguns dados seus.\n\nQual é o seu nome completo?`,
    };
  }

  private selectPlanAndConfirm(input: { memory: ChatMemory; plan: PlanCandidate }): NextBotResponse {
    const memory = {
      ...input.memory,
      planId: input.plan.id,
      planName: input.plan.name,
      planValue: Number(input.plan.price),
    };

    return {
      state: "CONFIRM_DATA",
      memory,
      reply: `Ótima escolha, ${getFirstName(memory.name)}! 🎉 Você optou pelo ${input.plan.name} por ${formatMoney(Number(input.plan.price))} + Globoplay (GRÁTIS).\n${buildSummary(memory)}\n\nEstá tudo correto? ✅`,
    };
  }

  private async handlePlanObjection(input: {
    text: string;
    state: string;
    memory: ChatMemory;
    plans: PlanCandidate[];
    agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>;
  }): Promise<NextBotResponse> {
    const memory = { ...input.memory, objectionCount: (input.memory.objectionCount ?? 0) + 1 };

    if (memory.objectionCount >= 3) {
      return {
        state: input.state,
        memory,
        reply: "Entendo! Se mudar de ideia ou precisar de alguma informação é só me avisar. 😁",
      };
    }

    const answer = await this.answerPlanQuestion({
      customerMessage: `O cliente apresentou objeção. Tentativa ${memory.objectionCount} de 3: ${input.text}`,
      customerName: memory.name,
      plans: input.plans.map((plan, index) => ({
        order: index + 1,
        name: plan.name,
        speed: plan.speed,
        price: Number(plan.price),
        description: plan.description,
      })),
      agent: input.agent,
    });

    return {
      state: input.state,
      memory,
      reply: answer || "Entendo você 😊 Pela estabilidade da Claro e pelo Globoplay incluso, vale muito a pena garantir agora. Qual plano faz mais sentido pra você?",
    };
  }

  private async applyCorrection(
    text: string,
    memory: ChatMemory,
    agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>,
  ) {
    const corrected = { ...memory };
    const normalized = normalizeText(text);
    const plans = await this.getPlans(agent);
    const selectedPlan = selectPlan(text, plans);
    const billingDay = parseBillingDay(text);
    const email = parseEmail(text);
    const birthDate = parseBirthDate(text);
    const document = parseDocument(text);
    const cep = parseCep(text);

    if (selectedPlan) {
      corrected.planId = selectedPlan.id;
      corrected.planName = selectedPlan.name;
      corrected.planValue = Number(selectedPlan.price);
    } else if (billingDay && /vencimento|dia|boleto|fatura/.test(normalized)) {
      corrected.billingDueDay = billingDay;
    } else if (email) {
      corrected.email = email;
    } else if (birthDate) {
      corrected.birthDate = birthDate.toISOString();
    } else if (document.valid) {
      corrected.cpfCnpj = document.formatted;
      corrected.documentType = document.type;
    } else if (cep) {
      corrected.cep = cep;
      const [coverage, viaCep] = await Promise.all([this.validateCoverage(cep), fetchViaCep(cep)]);
      applyAddress(corrected, {
        street: coverage?.street ?? viaCep?.street,
        neighborhood: coverage?.neighborhood ?? viaCep?.neighborhood,
        city: coverage?.city ?? viaCep?.city,
        state: coverage?.state ?? viaCep?.state,
      });
      applyAddressDetailsFromMessage(corrected, text);
    } else if (/numero|n[uú]mero|casa|residencia|residência/.test(normalized)) {
      corrected.streetNumber = parseSimpleNumber(text) ?? corrected.streetNumber;
    } else if (/complemento|apto|apartamento|casa|bloco|fundos/.test(normalized)) {
      corrected.complement = normalizeComplement(text.replace(/complemento/gi, "").trim());
    } else if (/nome/.test(normalized) || text.split(/\s+/).length >= 2) {
      corrected.name = toTitleCase(text.replace(/nome/gi, "").trim());
    }

    return corrected;
  }

  private async answerPlanQuestion(input: {
    customerMessage: string;
    customerName?: string;
    plans: Array<{ order: number; name: string; speed: string; price: number; description: string | null }>;
    agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>;
  }) {
    try {
      const planLines = input.plans
        .map((plan) => `${plan.order}. ${plan.name} ${plan.speed} - ${formatMoney(plan.price)}${plan.description ? ` - ${plan.description}` : ""}`)
        .join("\n");

      return await this.openAiService.answerCommercialQuestion(
        [
          `Voce e ${input.agent?.name ?? "Cris"}, Consultor Comercial da Claro em um atendimento pelo WhatsApp.`,
          `Personalidade: ${input.agent?.personality ?? "Vendedor humano, simpatico, persuasivo e objetivo."}`,
          `Regras personalizadas:\n${formatAgentRules(input.agent?.rules)}`,
          "Responda em portugues do Brasil, de forma breve, vendedora e natural.",
          "Nunca invente preco, cobertura ou plano. Use somente os planos listados.",
          "Use no maximo um emoji.",
          "Depois de responder, conduza o cliente para escolher um plano.",
          `Cliente: ${input.customerName ?? "cliente"}`,
          `Planos disponiveis:\n${planLines || "Valores ainda nao cadastrados."}`,
          `Mensagem do cliente: ${input.customerMessage}`,
        ].join("\n\n"),
      );
    } catch {
      return "";
    }
  }

  private async answerOutsideFlow(input: {
    message: string;
    state: string;
    customerName?: string;
    agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>;
    memory: ChatMemory;
  }) {
    try {
      const plans = await this.getPlans(input.agent);
      const planLines = plans
        .map((plan, index) => `${index + 1}. ${plan.name} ${plan.speed} - ${formatMoney(Number(plan.price))}${plan.description ? ` - ${plan.description}` : ""}`)
        .join("\n");

      return await this.openAiService.answerCommercialQuestion(
        [
          `Voce e ${input.agent?.name ?? "Cris"}, consultor comercial da Claro, falando com o cliente no WhatsApp.`,
          `Personalidade: ${input.agent?.personality ?? "Consultor humano, persuasivo, divertido, cordial e objetivo."}`,
          `Regras:\n${formatAgentRules(input.agent?.rules)}`,
          `O funil esta na etapa ${input.state}. Responda a mensagem do cliente, trate objecoes com postura comercial e depois retome exatamente para a etapa atual sem pular o fluxo.`,
          "Voce nunca pode dizer que e IA, robo, automacao ou assistente virtual.",
          "Voce sempre fala como consultor da Claro.",
          "Se o cliente demonstrar objecao, falta de interesse, cancelamento ou desconfiança, tente reverter com argumento comercial leve, humano e seguro.",
          "Responda primeiro a pergunta real do cliente de forma util, natural e convincente. Nao desvie para lista de planos se isso nao foi pedido.",
          "So liste planos ou valores de forma organizada quando o cliente pedir opcoes, planos disponiveis, comparacao, velocidade ou preco.",
          "Quando a pergunta for sobre uso pratico, estabilidade, trabalho, aplicativos, qualidade, instalacao ou confianca, responda como uma consultora humana explicando com clareza e seguranca.",
          "Se precisar falar de planos, use somente os planos listados abaixo.",
          "Se precisar falar de endereco ou cobertura, use apenas os dados ja conhecidos nesta conversa.",
          "Nao responda temas politicos, religiosos ou fora do contexto comercial.",
          "Use humor leve e natural quando combinar com a conversa, sem exagerar.",
          "Use no maximo dois emojis.",
          "Depois de responder, feche puxando o cliente de volta para a etapa atual do fluxo.",
          `Contexto conhecido do cliente:\n${summarizeMemoryForAi(input.memory)}`,
          `Planos disponiveis:\n${planLines || "Nenhum plano ativo encontrado no momento."}`,
          `Cliente: ${input.customerName ?? "cliente"}`,
          `Pergunta: ${input.message}`,
        ].join("\n\n"),
      );
    } catch {
      return "Posso te orientar sobre os planos e a contratação da Claro. 😊";
    }
  }

  private tryHandleBillingQuestion(input: {
    text: string;
    state: string;
    memory: ChatMemory;
    firstName?: string;
  }): NextBotResponse | null {
    if (!asksAboutBillingOrFirstPayment(input.text)) {
      return null;
    }

    const dayList = "5, 8, 10, 15, 20 ou 25";
    const chosenDay = input.memory.billingDueDay;
    const resume = promptForState(input.state, input.firstName);
    const answer = chosenDay
      ? `O vencimento que ficou registrado até agora é o dia ${chosenDay}. Se quiser alterar, eu também posso ajustar para 5, 8, 10, 15, 20 ou 25. 📅`
      : `Você pode escolher o vencimento para os dias ${dayList} do mês. Assim que me disser qual prefere, eu sigo com seu cadastro. 📅`;

    return {
      state: input.state,
      memory: input.memory,
      reply: `${answer}\n\n${resume}`,
    };
  }
}

type NextBotResponse = {
  state: string;
  memory: ChatMemory;
  reply: string;
  leadId?: string;
};

type ChatMemory = {
  name?: string;
  cep?: string;
  address?: string;
  city?: string;
  state?: string;
  neighborhood?: string;
  streetNumber?: string;
  complement?: string;
  cpfCnpj?: string;
  documentType?: "CPF" | "CNPJ";
  birthDate?: string;
  email?: string;
  billingDueDay?: number;
  planId?: string;
  planName?: string;
  planValue?: number;
  recommendedPlanId?: string;
  handoff?: boolean;
  objectionCount?: number;
};

type PlanCandidate = {
  id: string;
  name: string;
  speed: string;
  price: unknown;
  description: string | null;
};

type ViaCepAddress = {
  street?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
};

function normalizeMemory(memory: unknown): ChatMemory {
  if (memory && typeof memory === "object" && !Array.isArray(memory)) {
    return memory as ChatMemory;
  }
  return {};
}

function randomDelaySeconds(minSeconds: number, maxSeconds: number) {
  const min = Math.max(0, minSeconds);
  const max = Math.max(min + 1, maxSeconds);
  return Math.max(1, Math.floor(Math.random() * (max - min) + min));
}

function normalizeWhatsappPhone(phone: string) {
  const normalized = phone.trim().toLowerCase();
  const digits = onlyDigits(phone).replace(/^00/, "");
  if (normalized.endsWith("@lid")) return `${digits}@lid`;
  if (digits.startsWith("55")) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function parseCep(text: string) {
  const formatted = text.match(/\b\d{5}\s*[-–—.]?\s*\d{3}\b/);
  if (formatted) return formatted[0].replace(/\D/g, "").slice(0, 8);

  const nearCep = text.match(/cep\D{0,20}(\d[\d\s.\-–—]{6,}\d)/i);
  const nearCepDigits = nearCep?.[1]?.replace(/\D/g, "");
  if (nearCepDigits && nearCepDigits.length >= 8) return nearCepDigits.slice(0, 8);

  const digits = onlyDigits(text);
  const withoutSeparators = text.replace(/[\s,.\-–—()/]/g, "");
  const cepLabelNormalized = withoutSeparators.replace(/^cep:?/i, "");
  if (digits.length === 8 && /^[\d\s.\-–—()/]+$/.test(text.trim())) return digits;
  if (digits.length === 8 && withoutSeparators === digits) return digits;
  if (digits.length === 8 && cepLabelNormalized === digits) return digits;

  const byWords = wordsToDigits(text);
  return byWords.length >= 8 ? byWords.slice(0, 8) : "";
}

function parseFullName(text: string) {
  const normalized = normalizeText(text);
  if (!normalized || !parseFullNameLike(text)) return "";

  const cleaned = text
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ");
  if (words.length < 2 || words.length > 7) return "";

  const fillerWords = new Set(["da", "de", "do", "das", "dos", "e"]);
  const relevantWords = words.filter((word) => !fillerWords.has(normalizeText(word)));
  if (relevantWords.length < 2) return "";
  if (relevantWords.some((word) => normalizeText(word).length < 2)) return "";

  return toTitleCase(cleaned);
}

function parseDocument(text: string): { valid: false; type?: never; formatted?: never } | { valid: true; type: "CPF" | "CNPJ"; formatted: string } {
  const digits = onlyDigits(text);
  if (digits.length === 11 && isValidCpf(digits)) {
    return { valid: true, type: "CPF", formatted: digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") };
  }
  if (digits.length === 14 && isValidCnpj(digits)) {
    return { valid: true, type: "CNPJ", formatted: digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") };
  }
  return { valid: false };
}

function isValidCpf(cpf: string) {
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(cpf[index]) * (10 - index);
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let index = 0; index < 10; index += 1) sum += Number(cpf[index]) * (11 - index);
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

function isValidCnpj(cnpj: string) {
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base: string, factors: number[]) => {
    const sum = factors.reduce((total, factor, index) => total + Number(base[index]) * factor, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = calc(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calc(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}

function parseBirthDate(text: string) {
  const normalized = normalizeText(text);
  const monthByName: Record<string, number> = {
    janeiro: 1,
    fevereiro: 2,
    marco: 3,
    abril: 4,
    maio: 5,
    junho: 6,
    julho: 7,
    agosto: 8,
    setembro: 9,
    outubro: 10,
    novembro: 11,
    dezembro: 12,
  };

  let day = 0;
  let month = 0;
  let year = 0;
  const numbers = onlyDigits(text);
  const separated = text.match(/(\d{1,2})[\/.\-\s](\d{1,2})[\/.\-\s](\d{2,4})/);

  if (separated) {
    day = Number(separated[1]);
    month = Number(separated[2]);
    year = normalizeYear(Number(separated[3]));
  } else if (numbers.length === 8) {
    day = Number(numbers.slice(0, 2));
    month = Number(numbers.slice(2, 4));
    year = Number(numbers.slice(4, 8));
  } else {
    const monthName = Object.keys(monthByName).find((name) => normalized.includes(name));
    const parts = normalized.match(/\d+/g)?.map(Number) ?? [];
    if (monthName && parts.length >= 2) {
      day = parts[0];
      month = monthByName[monthName];
      year = normalizeYear(parts[1]);
    }
  }

  if (!day || !month || !year) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (year < 1900 || year > new Date().getFullYear()) return null;
  return date;
}

function normalizeYear(year: number) {
  if (year < 100) return year > 30 ? 1900 + year : 2000 + year;
  return year;
}

function parseSimpleNumber(text: string) {
  const digits = onlyDigits(text);
  return digits || wordsToDigits(text) || "";
}

function parseBillingDay(text: string) {
  const digits = onlyDigits(text);
  const candidates = [Number(digits), Number(wordsToDigits(text))].filter(Boolean);
  return candidates.find((day) => VALID_BILLING_DAYS.includes(day)) ?? null;
}

function parseEmail(text: string) {
  const match = text.trim().match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0].toLowerCase() ?? "";
}

function normalizeComplement(text: string) {
  const normalized = text.trim();
  if (!normalized || /^(nao|não|sem|nenhum|n tem|nao tem|não tem)$/i.test(normalized)) {
    return "Sem complemento";
  }
  return normalized;
}

function applyAddress(memory: ChatMemory, address: ViaCepAddress) {
  memory.address = address.street ?? memory.address;
  memory.neighborhood = address.neighborhood ?? memory.neighborhood;
  memory.city = address.city ?? memory.city;
  memory.state = address.state ?? memory.state;
}

function applyAddressDetailsFromMessage(memory: ChatMemory, text: string) {
  const details = extractAddressDetailsFromMessage(text);
  memory.address = details.street ?? memory.address;
  memory.streetNumber = details.streetNumber ?? memory.streetNumber;
  memory.complement = details.complement ?? memory.complement;
}

function extractAddressDetailsFromMessage(text: string) {
  const cleanLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const withoutCep = text.replace(/\b\d{5}\s*[-–—.]?\s*\d{3}\b/g, " ").trim();
  const streetNumber = findStreetNumber(text);
  const complement = findComplement(text);
  const streetLine = cleanLines.find((line) => {
    const normalized = normalizeText(line);
    return /^(rua|r |avenida|av |estrada|rodovia|travessa|alameda|praca|praça)\b/.test(normalized);
  });
  const beforeNumber = withoutCep
    .split(/(?:numero|número|n[ºo]?\.?)\s*\d+/i)[0]
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(0);
  const street = streetLine ?? beforeNumber;

  return {
    street: street && /\D/.test(street) ? toTitleCase(street) : undefined,
    streetNumber,
    complement,
  };
}

function findStreetNumber(text: string) {
  const match = text.match(/(?:numero|número|n[ºo]?\.?)\s*(\d+[A-Za-z]?)/i);
  return match?.[1] ?? "";
}

function findComplement(text: string) {
  const match = text.match(/\b(casa|apto|apartamento|bloco|fundos|sobrado|lote|quadra)\s*([A-Za-z0-9-]+)?/i);
  if (!match) return "";
  return normalizeComplement([match[1], match[2]].filter(Boolean).join(" "));
}

async function fetchViaCep(cep: string): Promise<ViaCepAddress | null> {
  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as { erro?: boolean; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
    if (data.erro) return null;
    return {
      street: data.logradouro,
      neighborhood: data.bairro,
      city: data.localidade,
      state: data.uf,
    };
  } catch {
    return null;
  }
}

function formatCep(cep?: string) {
  const digits = onlyDigits(cep ?? "");
  return digits.length === 8 ? digits.replace(/(\d{5})(\d{3})/, "$1-$2") : cep ?? "";
}

function formatDate(date: Date) {
  return date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatAddressShort(memory: ChatMemory) {
  const street = memory.address ? `na ${memory.address}` : "no endereço informado";
  const neighborhood = memory.neighborhood ? `, ${memory.neighborhood}` : "";
  const cityState = memory.city || memory.state ? ` – ${[memory.city, memory.state].filter(Boolean).join("/")}` : "";
  return `${street}${neighborhood}${cityState}`;
}

function formatFullAddress(memory: ChatMemory) {
  const base = [
    memory.address ?? "Rua não informada",
    memory.streetNumber ? `nº ${memory.streetNumber}` : "sem número",
    memory.complement && memory.complement !== "Sem complemento" ? memory.complement : "",
    memory.neighborhood,
  ].filter(Boolean).join(", ");
  const cityState = [memory.city, memory.state].filter(Boolean).join("/");
  return cityState ? `${base} – ${cityState}` : base;
}

function buildSummary(memory: ChatMemory) {
  const birthDate = memory.birthDate ? formatDate(new Date(memory.birthDate)) : "Não informado";
  return [
    "Aqui estão os dados que você me passou até agora:",
    `📍 CEP: ${formatCep(memory.cep)}`,
    `👤 Nome: ${memory.name ?? "Não informado"}`,
    `🆔 Documento: ${memory.cpfCnpj ?? "Não informado"}`,
    `🎂 Data de nascimento: ${birthDate}`,
    `🏠 Endereço: ${formatFullAddress(memory)}`,
    `📧 E-mail: ${memory.email ?? "Não informado"}`,
    `📅 Data de vencimento: ${memory.billingDueDay ?? "Não informado"}`,
    `📶 Plano: ${memory.planName ?? "Não informado"}`,
  ].join("\n");
}

function formatPlanList(plans: PlanCandidate[]) {
  if (!plans.length) return "No momento não há planos ativos cadastrados.";
  return plans.map((plan) => `✅ ${plan.name} → ${formatMoney(Number(plan.price))} + Globoplay (GRÁTIS)`).join("\n");
}

function findRecommendedPlan(plans: PlanCandidate[]) {
  const comboHexa = plans.find((plan) => normalizeText(plan.name).includes("combo hexa"));
  if (comboHexa) return comboHexa;

  return plans.reduce<PlanCandidate | undefined>(
    (mostExpensive, plan) =>
      !mostExpensive || Number(plan.price) > Number(mostExpensive.price) ? plan : mostExpensive,
    undefined,
  );
}

function selectPlan(text: string, plans: PlanCandidate[]) {
  const normalized = normalizeText(text);
  const comboHexa = plans.find((plan) => normalizeText(plan.name).includes("combo hexa"));
  if (
    comboHexa &&
    (normalized.includes("combo hexa") ||
      normalized === "hexa" ||
      (normalized.includes("600") && (normalized.includes("chip") || normalized.includes("celular"))) ||
      normalized.includes("139 80"))
  ) {
    return comboHexa;
  }

  const byName = plans.find((plan) => {
    const name = normalizeText(plan.name);
    const speed = normalizeText(plan.speed);
    return normalized.includes(name) || normalized.includes(speed);
  });
  if (byName) return byName;

  const byPrice = selectPlanByPrice(text, plans);
  if (byPrice) return byPrice;

  const aliases = [
    { terms: ["250", "duzentos e cinquenta"], chip: false },
    { terms: ["500", "quinhentos"], chip: false },
    { terms: ["1gb", "1 giga", "um giga", "1000"], chip: false },
    { terms: ["250", "duzentos e cinquenta"], chip: true },
    { terms: ["500", "quinhentos"], chip: true },
    { terms: ["1gb", "1 giga", "um giga", "1000"], chip: true },
  ];
  const wantsChip = normalized.includes("chip") || normalized.includes("celular");
  const alias = aliases.find((item) => item.chip === wantsChip && item.terms.some((term) => normalized.includes(term)));
  if (alias) {
    return plans.find((plan) => {
      const planName = normalizeText(`${plan.name} ${plan.speed}`);
      const hasSpeed = alias.terms.some((term) => planName.includes(normalizeText(term)));
      const hasChip = planName.includes("chip");
      return hasSpeed && hasChip === alias.chip;
    });
  }

  const numericChoice = Number(normalized.match(/\b\d+\b/)?.[0]);
  if (numericChoice >= 1 && numericChoice <= plans.length && !normalized.includes("gb")) {
    return plans[numericChoice - 1];
  }

  return null;
}

function selectPlanByPrice(text: string, plans: PlanCandidate[]) {
  const candidates = extractNumericCandidates(text);

  for (const candidate of candidates) {
    const exact = plans.find((plan) => approximatelyEqual(Number(plan.price), candidate, 0.11));
    if (exact) return exact;

    const integerMatch = plans.find((plan) => Math.floor(Number(plan.price)) === Math.floor(candidate));
    if (integerMatch) return integerMatch;

    const roundedMatch = plans.find((plan) => Math.round(Number(plan.price)) === Math.round(candidate));
    if (roundedMatch) return roundedMatch;
  }

  return null;
}

function extractNumericCandidates(text: string) {
  const matches = text
    .replace(/r\$\s*/gi, "")
    .match(/\d+(?:[.,]\d+)?/g) ?? [];

  return Array.from(
    new Set(
      matches
        .map((value) => Number(value.replace(/\./g, "").replace(",", ".")))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

function approximatelyEqual(left: number, right: number, tolerance: number) {
  return Math.abs(left - right) <= tolerance;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsToDigits(value: string) {
  const digitWords: Record<string, string> = {
    zero: "0",
    um: "1",
    uma: "1",
    dois: "2",
    duas: "2",
    tres: "3",
    quatro: "4",
    cinco: "5",
    seis: "6",
    sete: "7",
    oito: "8",
    nove: "9",
  };
  return normalizeText(value)
    .split(" ")
    .map((word) => digitWords[word] ?? "")
    .join("");
}

function isHandoffRequest(text: string) {
  const normalized = normalizeText(text);
  return ["atendente", "humano", "consultor", "vendedor", "falar com alguem", "falar com uma pessoa"].some((term) => normalized.includes(term));
}

function isRestartRequest(text: string) {
  const normalized = normalizeText(text);
  return ["reiniciar", "recomecar", "comecar de novo", "novo atendimento", "outra consulta"].some((term) => normalized.includes(term));
}

function shouldAnswerOutsideFlow(text: string, state: string) {
  if (["START", "CONFIRM_DATA", "CORRECTION", "FINISHED", "FINISHED_UNAVAILABLE", "HUMAN_HANDOFF"].includes(state)) return false;
  return shouldUseAiFallbackForState(state, text);
}

function shouldUseAiFallbackForState(state: string, text: string) {
  if (!text.trim()) return false;

  if (looksLikeWaitMessage(text) || looksLikeAddressCorrection(text) || asksAboutBillingOrFirstPayment(text)) {
    return true;
  }

  const conversationalDiversion =
    looksLikeQuestion(text) ||
    looksLikeObjection(text) ||
    looksLikeCancellation(text) ||
    looksLikeTopicChange(text);

  if (!conversationalDiversion) return false;

  if (state === "ASK_CEP") return !parseCep(text);
  if (state === "ASK_NAME") return !parseFullNameLike(text);
  if (state === "ASK_DOCUMENT") return !parseDocument(text).valid;
  if (state === "ASK_BIRTH_DATE") return !parseBirthDate(text);
  if (state === "ASK_STREET_NUMBER") return !parseSimpleNumber(text);
  if (state === "ASK_COMPLEMENT") return true;
  if (state === "ASK_BILLING_DUE_DAY") return !parseBillingDay(text);
  if (state === "ASK_EMAIL") return !parseEmail(text);

  return false;
}

function looksLikeQuestion(text: string) {
  const normalized = normalizeText(text);
  return text.includes("?") || /^(como|qual|quais|quanto|quando|onde|por que|porque|tem|voce|voces|pode|posso)\b/.test(normalized);
}

function looksLikeObjection(text: string) {
  const normalized = normalizeText(text);
  return [
    "nao obrigado",
    "claro nao",
    "nao tenho interesse",
    "nao quero",
    "nao gostei",
    "muito caro",
    "ta caro",
    "esta caro",
    "vou pensar",
    "depois eu vejo",
    "nao compensa",
    "nao vale a pena",
    "nao preciso",
    "nao quero continuar",
    "sem interesse",
    "nao concluir pedido",
    "nao vou concluir",
    "fala serio",
  ].some((term) => normalized.includes(term));
}

function looksLikeCancellation(text: string) {
  const normalized = normalizeText(text);
  return [
    "cancelar",
    "cancelamento",
    "desistir",
    "desistencia",
    "encerrar",
    "parar por aqui",
    "nao vou contratar",
    "nao quero contratar",
    "nao vou fechar",
  ].some((term) => normalized.includes(term));
}

function looksLikeTopicChange(text: string) {
  const normalized = normalizeText(text);
  return [
    "plano",
    "internet",
    "fibra",
    "valor",
    "preco",
    "preço",
    "produto",
    "informacao",
    "informacoes",
    "detalhes",
    "beneficios",
    "vantagens",
    "globoplay",
    "chip",
    "atendente",
    "consultor",
    "humano",
    "cobertura",
    "pagamento",
    "vencimento",
    "endereco",
    "cep",
  ].some((term) =>
    normalized.includes(normalizeText(term)),
  );
}

function parseFullNameLike(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (looksLikeObjection(text) || looksLikeCancellation(text) || looksLikeQuestion(text) || looksLikeTopicChange(text)) return false;
  if (/\b(claro|produto|plano|internet|fibra)\b/.test(normalized)) return false;
  if (looksLikeWaitMessage(text) || looksLikeAddressCorrection(text)) return false;
  if (onlyDigits(text).length > 2) return false;

  const cleaned = text
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return false;

  const words = cleaned.split(" ");
  if (words.length < 2 || words.length > 7) return false;

  const fillerWords = new Set(["da", "de", "do", "das", "dos", "e"]);
  const relevantWords = words.filter((word) => !fillerWords.has(normalizeText(word)));
  if (relevantWords.length < 2) return false;

  const forbiddenWords = new Set([
    "data",
    "nascimento",
    "documento",
    "cpf",
    "cnpj",
    "cep",
    "endereco",
    "pagamento",
    "vencimento",
    "produto",
    "plano",
    "internet",
    "claro",
    "final",
    "rua",
  ]);

  if (relevantWords.some((word) => forbiddenWords.has(normalizeText(word)))) return false;

  return relevantWords.every((word) => normalizeText(word).length >= 2);
}

function looksLikeWaitMessage(text: string) {
  const normalized = normalizeText(text);
  return [
    "so um instante",
    "só um instante",
    "um instante",
    "aguarde",
    "so um minuto",
    "só um minuto",
    "ja te mando",
    "já te mando",
    "ja envio",
    "já envio",
    "vou ver",
    "vou conferir",
    "vou pegar",
    "to vendo",
    "tô vendo",
    "to procurando",
    "tô procurando",
    "pera ai",
    "pera aí",
    "so um momento",
    "só um momento",
  ].some((term) => normalized.includes(normalizeText(term)));
}

function asksAboutBillingOrFirstPayment(text: string) {
  const normalized = normalizeText(text);
  return (
    /(primeiro pagamento|primeira mensalidade|quando seria o primeiro pagamento|quando seria o pagamento|quando vence|vencimento|data de vencimento|dia de vencimento|pagamento)/.test(normalized)
      || (looksLikeQuestion(text) && /(boleto|fatura|mensalidade)/.test(normalized))
  );
}

function looksLikeAddressCorrection(text: string) {
  const normalized = normalizeText(text);
  return [
    "nao esse endereco",
    "não esse endereço",
    "esse endereco esta errado",
    "esse endereço está errado",
    "endereco errado",
    "endereço errado",
    "nao e esse endereco",
    "não é esse endereço",
    "esse nao e meu endereco",
    "esse não é meu endereço",
    "nao e meu endereco",
    "não é meu endereço",
    "corrigir endereco",
    "corrigir endereço",
    "cep errado",
  ].some((term) => normalized.includes(normalizeText(term)));
}

function looksLikeCepOnlyMessage(text: string) {
  const cep = parseCep(text);
  return Boolean(cep) && onlyDigits(text).length >= 8 && normalizeText(text).split(" ").length <= 3;
}

function promptForState(state: string, firstName?: string) {
  const name = firstName ? `${firstName}, ` : "";
  const prompts: Record<string, string> = {
    ASK_CEP: "Para eu consultar a cobertura, me envie o CEP da instalação.",
    ASK_NAME: "Qual é o seu nome completo?",
    ASK_DOCUMENT: `${name}agora me informe seu CPF ou CNPJ, por favor.`,
    ASK_BIRTH_DATE: "Agora me informe sua data de nascimento, por favor.",
    ASK_STREET_NUMBER: "Agora me informe o número da sua residência.",
    ASK_COMPLEMENT: "Agora me informe se há complemento para o endereço.",
    ASK_BILLING_DUE_DAY: "Qual vencimento você prefere: 5, 8, 10, 15, 20 ou 25?",
    ASK_EMAIL: "Agora preciso do seu e-mail, por favor.",
    RECOMMEND_PLAN: "Você quer seguir com o plano recomendado ou ver outras opções?",
    CHOOSE_PLAN: "Qual plano você gostaria de escolher?",
  };
  return prompts[state] ?? "Me envie a próxima informação para continuarmos.";
}

function callResumePrompt(
  state: string,
  memory: ChatMemory,
  agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>,
) {
  if (state === "START") {
    return interpolate(
      flowMessage(
        agent?.flow,
        "START",
        `Olá! Eu sou o ${agent?.name ?? "Cris"}, consultor comercial da Claro. Pode me informar o CEP da instalação?`,
      ),
      memory,
      agent?.name,
    );
  }
  if (state === "FINISHED") return "Seu atendimento já está registrado. Se precisar, envie reiniciar para começar novamente.";
  if (state === "HUMAN_HANDOFF") return "Seu atendimento está sinalizado para um consultor humano continuar por aqui.";
  return promptForState(state, getFirstName(memory.name));
}

function extractedValueForState(state: string, data?: ExtractedCustomerData) {
  if (!data) return undefined;
  const values: Record<string, string | undefined> = {
    ASK_CEP: data.cep,
    ASK_NAME: data.fullName,
    ASK_DOCUMENT: data.cpf,
    ASK_BIRTH_DATE: data.birthDate,
    ASK_STREET_NUMBER: data.streetNumber,
    ASK_EMAIL: data.email,
  };
  return values[state];
}

function asksForPlanList(text: string) {
  const normalized = normalizeText(text);
  return ["ver os planos", "quero ver", "opcoes", "opcoes disponiveis", "quais planos", "outros planos"].some((term) => normalized.includes(term));
}

function asksForExplicitPlanRecommendation(text: string) {
  const normalized = normalizeText(text);
  const mentionsPlan = /\b(plano|planos|combo|internet|fibra|mega|giga|velocidade)\b/.test(normalized);
  const requestsRecommendation = [
    "melhor", "recomenda", "recomende", "recomendacao", "indica", "indique", "ideal",
    "para jogar", "para jogos", "para trabalhar", "para estudar", "mais rapido", "mais completa",
  ].some((term) => normalized.includes(term));
  return mentionsPlan && requestsRecommendation;
}

function isExplicitPlanCatalogQuestion(text: string) {
  const normalized = normalizeText(text);
  if (!looksLikeQuestion(text)) return false;

  const asksForCatalog = [
    "quais planos",
    "quais sao os planos",
    "quais são os planos",
    "quais opcoes",
    "quais opções",
    "quero ver os planos",
    "me mostra os planos",
    "me mostra as opcoes",
    "me mostra as opções",
    "quais velocidades",
    "qual o valor",
    "quais valores",
    "qual o preco",
    "qual o preço",
    "quanto custa",
    "quero comparar",
    "me fala os combos",
  ];

  return asksForCatalog.some((term) => normalized.includes(normalizeText(term)));
}

function isAlternativeRequest(text: string) {
  const normalized = normalizeText(text);
  return ["outro", "outra", "outra opcao", "outra opção", "prefiro outro"].some((term) => normalized.includes(normalizeText(term)));
}

function isPositive(text: string) {
  const normalized = normalizeText(text);
  return ["sim", "isso", "esse", "essa", "confirmo", "correto", "ta certo", "esta certo", "pode ser", "fechado", "quero"].some((term) => normalized === term || normalized.includes(term));
}

function isNegative(text: string) {
  const normalized = normalizeText(text);
  return ["nao", "não", "errado", "corrigir", "alterar", "mudar"].some((term) => normalized.includes(normalizeText(term)));
}

function isPlanRefusal(text: string) {
  const normalized = normalizeText(text);
  return [
    "nao quero",
    "nao gostei",
    "nao tenho interesse",
    "nao obrigado",
    "muito caro",
    "ta caro",
    "esta caro",
    "vou pensar",
    "deixa pra la",
    "nenhum plano",
    "nao vou contratar",
  ].some((term) => normalized.includes(term));
}

function getFirstName(name?: string) {
  return name?.split(" ").filter(Boolean)[0] ?? "";
}

function toTitleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function interpolate(template: string, memory: ChatMemory, agentName?: string) {
  return template
    .replaceAll("{{agente}}", agentName || "Cris")
    .replaceAll("{{nome}}", getFirstName(memory.name) || "cliente")
    .replaceAll("{{cep}}", formatCep(memory.cep))
    .replaceAll("{{endereco}}", formatFullAddress(memory));
}

function agentConfig(agent: Awaited<ReturnType<ChatbotRepository["getAgentByInstance"]>>) {
  if (!agent) return undefined;
  return {
    baseUrl: agent.zapiBaseUrl ?? undefined,
    instanceId: agent.zapiInstanceId ?? undefined,
    token: agent.zapiToken ?? undefined,
    clientToken: agent.zapiClientToken ?? undefined,
    whatsappNumber: agent.zapiWhatsappNumber ?? undefined,
  };
}

function flowMessage(flow: unknown, state: string, fallback: string) {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return fallback;
  const steps = (flow as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return fallback;
  const step = steps.find((item) => item && typeof item === "object" && (item as { state?: string }).state === state);
  const message = step && typeof step === "object" ? (step as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function formatAgentRules(rules: unknown) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return "Nenhuma regra adicional configurada.";
  return Object.values(rules)
    .filter((value) => value !== false && value !== null && value !== undefined)
    .map((value) => `- ${String(value)}`)
    .join("\n") || "Nenhuma regra adicional configurada.";
}

function summarizeMemoryForAi(memory: ChatMemory) {
  return [
    `Nome: ${memory.name ?? "nao informado"}`,
    `CEP: ${formatCep(memory.cep) || "nao informado"}`,
    `Endereco: ${formatFullAddress(memory)}`,
    `Documento: ${memory.cpfCnpj ?? "nao informado"}`,
    `Nascimento: ${memory.birthDate ? formatDate(new Date(memory.birthDate)) : "nao informado"}`,
    `E-mail: ${memory.email ?? "nao informado"}`,
    `Vencimento: ${memory.billingDueDay ?? "nao informado"}`,
    `Plano: ${memory.planName ?? "nao informado"}`,
  ].join("\n");
}
