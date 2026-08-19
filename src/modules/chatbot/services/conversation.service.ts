import type { Prisma, User } from "@prisma/client";
import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { ZapiService } from "@/services/zapi/zapi.service";

type ConversationMemory = {
  tags?: ConversationTag[];
  awaitingFlowState?: string;
  followUpStage?: number;
  followUpLastSentAt?: string;
  followUpClosedAt?: string;
  [key: string]: unknown;
};

export type ConversationTag = {
  label: string;
  color: string;
};

const DEFAULT_TAG_COLOR = "sky";

export class ConversationService {
  constructor(
    private readonly chatbotRepository = new ChatbotRepository(),
    private readonly zapiService = new ZapiService(),
  ) {}

  async list(params?: {
    offset?: number;
    limit?: number;
    user?: Pick<User, "id" | "role">;
    filter?: "all" | "unavailable" | "finished" | "stalled";
  }) {
    const filter = params?.filter ?? "all";
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 25;
    const summaryRows = await this.chatbotRepository.listConversationSummaries(params?.user);
    const summary = buildConversationSummary(summaryRows.map((row) => ({
      state: row.state,
      memory: this.parseMemory(row.memory),
    })));

    const shouldFilterManually = filter !== "all";
    const conversations = await this.chatbotRepository.listConversations({
      skip: shouldFilterManually ? 0 : offset,
      take: shouldFilterManually ? 500 : limit,
      user: params?.user,
    });

    const allItems = conversations.map((conversation) => {
      const memory = this.parseMemory(conversation.memory);
      const lastMessage = conversation.messages[0] ?? null;
      const latestInboundAt = conversation.messages.find((message) => message.direction === "inbound")?.createdAt ?? null;
      const latestOutboundAt = conversation.messages.find((message) => message.direction === "outbound")?.createdAt ?? null;
      const hasPendingCustomerMessage = Boolean(
        latestInboundAt && (!latestOutboundAt || latestInboundAt.getTime() > latestOutboundAt.getTime()),
      );

      return {
        id: conversation.id,
        phone: conversation.phone,
        state: conversation.state,
        updatedAt: conversation.updatedAt.toISOString(),
        lead: conversation.lead ? { id: conversation.lead.id, name: conversation.lead.name } : null,
        agent: conversation.agent ? { id: conversation.agent.id, name: conversation.agent.name } : null,
        owner: conversation.owner ? { id: conversation.owner.id, name: conversation.owner.name, role: conversation.owner.role } : null,
        tags: memory.tags ?? [],
        botActive: !conversation.ownerUserId,
        isStalled: Boolean(memory.followUpClosedAt),
        hasPendingCustomerMessage,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              direction: lastMessage.direction,
              body: lastMessage.body,
              createdAt: lastMessage.createdAt.toISOString(),
            }
          : null,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          direction: message.direction,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
        })),
      };
    }).filter((conversation) => matchesConversationFilter(conversation, filter));

    const items = shouldFilterManually ? allItems.slice(offset, offset + limit) : allItems;
    const total = shouldFilterManually ? allItems.length : summaryRows.length;

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total,
      summary,
    };
  }

  async getDetail(conversationId: string, user?: Pick<User, "id" | "role">) {
    const conversation = await this.chatbotRepository.getConversationById(conversationId, user);
    if (!conversation) return null;

    const memory = this.parseMemory(conversation.memory);

    return {
      id: conversation.id,
      phone: conversation.phone,
      state: conversation.state,
      updatedAt: conversation.updatedAt.toISOString(),
      lead: conversation.lead
        ? {
            id: conversation.lead.id,
            name: conversation.lead.name,
            email: conversation.lead.email,
            cep: conversation.lead.cep,
            city: conversation.lead.city,
            state: conversation.lead.state,
          }
        : null,
      agent: conversation.agent ? { id: conversation.agent.id, name: conversation.agent.name } : null,
      owner: conversation.owner ? { id: conversation.owner.id, name: conversation.owner.name, role: conversation.owner.role } : null,
      ownerUserId: conversation.ownerUserId,
      tags: memory.tags ?? [],
      memory,
      botActive: !conversation.ownerUserId,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  async listAssignableUsers() {
    return this.chatbotRepository.listAssignableUsers();
  }

  async assignOwner(conversationId: string, ownerUserId: string | null, user?: Pick<User, "id" | "role">) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.assignConversationOwner(conversationId, ownerUserId);
    return this.getDetail(conversationId, user);
  }

  async toggleBotControl(conversationId: string, ownerUserId: string | null, user?: Pick<User, "id" | "role">) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.assignConversationOwner(conversationId, detail.botActive ? ownerUserId : null);
    return this.getDetail(conversationId, user);
  }

  async updateTags(conversationId: string, tags: ConversationTag[], user?: Pick<User, "id" | "role">) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    const memory = {
      ...(detail.memory ?? {}),
      tags: normalizeTags(tags),
    };

    await this.chatbotRepository.updateConversationMemory(conversationId, memory as Prisma.InputJsonValue);
    return this.getDetail(conversationId, user);
  }

  async sendManualMessage(params: { conversationId: string; content: string; user?: Pick<User, "id" | "role"> }) {
    const conversation = await this.chatbotRepository.getConversationById(params.conversationId, params.user);
    if (!conversation) {
      throw new Error("Conversa não encontrada.");
    }

    await this.zapiService.sendText({
      phone: conversation.phone,
      message: params.content,
      config: agentConfig(conversation.agent),
    });

    await this.chatbotRepository.saveMessage({
      conversationId: conversation.id,
      direction: "outbound",
      body: params.content,
      sentAt: new Date(),
    });

    const memory = this.parseMemory(conversation.memory);
    await this.chatbotRepository.updateConversationMemory(
      conversation.id,
      clearConversationFollowUp(memory) as Prisma.InputJsonValue,
    );

    return this.getDetail(conversation.id, params.user);
  }

  async sendManualMedia(params: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    caption?: string;
    user?: Pick<User, "id" | "role">;
  }) {
    const conversation = await this.chatbotRepository.getConversationById(params.conversationId, params.user);
    if (!conversation) {
      throw new Error("Conversa não encontrada.");
    }

    const config = agentConfig(conversation.agent);

    if (params.mimeType.startsWith("image/")) {
      await this.zapiService.sendImage({
        phone: conversation.phone,
        image: params.dataUrl,
        caption: params.caption,
        config,
      });
    } else if (params.mimeType.startsWith("audio/")) {
      await this.zapiService.sendAudio({
        phone: conversation.phone,
        audio: params.dataUrl,
        config,
      });
    } else if (params.mimeType.startsWith("video/")) {
      await this.zapiService.sendVideo({
        phone: conversation.phone,
        video: params.dataUrl,
        caption: params.caption,
        config,
      });
    } else {
      await this.zapiService.sendDocument({
        phone: conversation.phone,
        document: params.dataUrl,
        fileName: params.fileName,
        caption: params.caption,
        config,
      });
    }

    await this.chatbotRepository.saveMessage({
      conversationId: conversation.id,
      direction: "outbound",
      body: params.caption?.trim() || params.fileName,
      rawPayload: {
        fileName: params.fileName,
        mimeType: params.mimeType,
        kind: "manual-media",
      } as Prisma.InputJsonValue,
      sentAt: new Date(),
    });

    const memory = this.parseMemory(conversation.memory);
    await this.chatbotRepository.updateConversationMemory(
      conversation.id,
      clearConversationFollowUp(memory) as Prisma.InputJsonValue,
    );

    return this.getDetail(conversation.id, params.user);
  }

  async startConversation(params: { phone: string; ownerUserId?: string | null; leadName?: string; firstMessage?: string }) {
    const normalizedPhone = params.phone.replace(/\D/g, "");
    if (!normalizedPhone || normalizedPhone.length < 12) {
      throw new Error("Informe um WhatsApp com DDD e DDI 55.");
    }

    const agent = await this.chatbotRepository.getDefaultAgent();
    const conversation = await this.chatbotRepository.findOrCreateConversation(normalizedPhone, agent?.id);

    if (params.ownerUserId !== undefined) {
      await this.chatbotRepository.assignConversationOwner(conversation.id, params.ownerUserId);
    }

    if (params.firstMessage?.trim()) {
      await this.sendManualMessage({
        conversationId: conversation.id,
        content: params.firstMessage.trim(),
      });
    } else {
      await this.chatbotRepository.touchConversation(conversation.id);
    }

    return this.getDetail(conversation.id);
  }

  async deleteConversation(conversationId: string, user?: Pick<User, "id" | "role">) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.softDeleteConversation(conversationId);
    return { success: true };
  }

  async processAutoFollowUps(secret?: string) {
    if (process.env.CRIS_FOLLOWUP_CRON_SECRET && process.env.CRIS_FOLLOWUP_CRON_SECRET !== secret) {
      throw new Error("Não autorizado.");
    }

    const conversations = await this.chatbotRepository.listAutoFollowUpCandidates();
    const now = new Date();
    let processed = 0;

    for (const conversation of conversations) {
      const memory = this.parseMemory(conversation.memory);
      const nextStep = getNextFollowUpStep(memory, now);
      if (!nextStep) continue;

      const message = buildFollowUpMessage(nextStep.stage, memory.awaitingFlowState ?? conversation.state);
      if (!message) continue;

      await this.zapiService.sendText({
        phone: conversation.phone,
        message,
        config: agentConfig(conversation.agent),
      });

      await this.chatbotRepository.saveMessage({
        conversationId: conversation.id,
        direction: "outbound",
        body: message,
        sentAt: now,
      });

      const nextMemory: ConversationMemory = {
        ...memory,
        followUpStage: nextStep.stage,
        followUpLastSentAt: now.toISOString(),
      };

      if (nextStep.stage >= 4) {
        nextMemory.followUpClosedAt = now.toISOString();
        delete nextMemory.awaitingFlowState;
      }

      await this.chatbotRepository.updateConversationMemory(conversation.id, nextMemory as Prisma.InputJsonValue);
      processed += 1;
    }

    return { processed };
  }

  private parseMemory(memory: unknown): ConversationMemory {
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
      return {};
    }

    const record = memory as Record<string, unknown>;
    const tags = Array.isArray(record.tags)
      ? record.tags
          .map((tag) => normalizeTag(tag))
          .filter((tag): tag is ConversationTag => Boolean(tag))
      : [];
    return {
      ...record,
      tags,
    };
  }
}

type ConversationSummaryRow = {
  state: string;
  memory: ConversationMemory;
};

function buildConversationSummary(rows: ConversationSummaryRow[]) {
  let unavailable = 0;
  let finished = 0;
  let stalled = 0;

  for (const row of rows) {
    if (row.state === "FINISHED_UNAVAILABLE") unavailable += 1;
    if (row.state === "FINISHED") finished += 1;
    if (typeof row.memory.followUpClosedAt === "string" && row.memory.followUpClosedAt) stalled += 1;
  }

  return {
    unavailable,
    finished,
    stalled,
  };
}

function matchesConversationFilter(
  conversation: { state: string; memory?: ConversationMemory | null; isStalled?: boolean },
  filter: "all" | "unavailable" | "finished" | "stalled",
) {
  if (filter === "unavailable") return conversation.state === "FINISHED_UNAVAILABLE";
  if (filter === "finished") return conversation.state === "FINISHED";
  if (filter === "stalled") return Boolean(conversation.isStalled || conversation.memory?.followUpClosedAt);
  return true;
}

function clearConversationFollowUp(memory: ConversationMemory) {
  const next = { ...memory };
  delete next.awaitingFlowState;
  delete next.followUpStage;
  delete next.followUpLastSentAt;
  delete next.followUpClosedAt;
  return next;
}

function getNextFollowUpStep(memory: ConversationMemory, now: Date) {
  if (!memory.awaitingFlowState || memory.followUpClosedAt) {
    return null;
  }

  const baseTime = new Date(memory.followUpLastSentAt ?? "");
  if (Number.isNaN(baseTime.getTime())) {
    return null;
  }

  const currentStage = Number(memory.followUpStage ?? 0);
  const elapsedMs = now.getTime() - baseTime.getTime();
  const waitByStage = [
    3 * 60_000,
    5 * 60_000,
    10 * 60_000,
    3 * 60_000,
  ];

  const requiredMs = waitByStage[currentStage];
  if (requiredMs === undefined || elapsedMs < requiredMs) {
    return null;
  }

  return { stage: currentStage + 1 };
}

function buildFollowUpMessage(stage: number, flowState: string) {
  const prompt = promptLabelForState(flowState);

  if (stage === 1) {
    return `Olá, você está aí ainda? 🙂\nPara continuarmos, eu preciso que você me informe: ${prompt}.`;
  }

  if (stage === 2) {
    return `Você ainda tem interesse em contratar nossos planos? 😊\nPara dar continuidade, eu preciso que você me informe: ${prompt}.`;
  }

  if (stage === 3) {
    return `Ainda não recebi sua resposta 🤔\nVocê ainda tem interesse em continuar com a contratação do plano? Vamos dar continuidade? Eu preciso que você me informe: ${prompt}.`;
  }

  if (stage === 4) {
    return "Como não tive seu retorno, este atendimento foi encerrado por falta de resposta 🙂\nMas se você ainda tiver interesse no plano, é só me chamar aqui que eu continuo seu atendimento de onde paramos 🚀";
  }

  return "";
}

function promptLabelForState(state: string) {
  const prompts: Record<string, string> = {
    ASK_CEP: "o CEP da instalação",
    ASK_NAME: "o seu nome completo",
    ASK_DOCUMENT: "o seu CPF ou CNPJ",
    ASK_BIRTH_DATE: "a sua data de nascimento",
    ASK_STREET_NUMBER: "o número da sua residência",
    ASK_COMPLEMENT: "o complemento do endereço",
    ASK_BILLING_DUE_DAY: "a data de vencimento escolhida",
    ASK_EMAIL: "o seu e-mail",
    RECOMMEND_PLAN: "se quer seguir com o plano recomendado ou ver outras opções",
    CHOOSE_PLAN: "qual plano você deseja escolher",
    CONFIRM_DATA: "a confirmação dos dados",
    CORRECTION: "a correção dos dados",
  };

  return prompts[state] ?? "a informação pendente do seu cadastro";
}

function normalizeTags(tags: ConversationTag[]) {
  const unique = new Map<string, ConversationTag>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized) continue;
    unique.set(normalized.label.toLowerCase(), normalized);
  }

  return Array.from(unique.values()).slice(0, 20);
}

function normalizeTag(tag: unknown): ConversationTag | null {
  if (typeof tag === "string") {
    const label = tag.trim();
    return label ? { label, color: DEFAULT_TAG_COLOR } : null;
  }

  if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
    return null;
  }

  const record = tag as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const color = typeof record.color === "string" && record.color.trim() ? record.color.trim() : DEFAULT_TAG_COLOR;

  if (!label) return null;

  return {
    label,
    color,
  };
}

function agentConfig(agent?: {
  zapiBaseUrl?: string | null;
  zapiInstanceId?: string | null;
  zapiToken?: string | null;
  zapiClientToken?: string | null;
  zapiWhatsappNumber?: string | null;
} | null) {
  if (!agent) return undefined;

  return {
    baseUrl: agent.zapiBaseUrl ?? undefined,
    instanceId: agent.zapiInstanceId ?? undefined,
    token: agent.zapiToken ?? undefined,
    clientToken: agent.zapiClientToken ?? undefined,
    whatsappNumber: agent.zapiWhatsappNumber ?? undefined,
  };
}
