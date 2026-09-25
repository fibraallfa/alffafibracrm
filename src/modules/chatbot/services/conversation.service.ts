import type { Prisma } from "@prisma/client";
import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { writeTechnicalLog } from "@/lib/logger";
import { ZapiService } from "@/services/zapi/zapi.service";
import type { LeadAccessUser } from "@/lib/lead-source-access";

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
    user?: LeadAccessUser;
    filter?: "all" | "unavailable" | "finished" | "stalled";
    includeSummary?: boolean;
  }) {
    const filter = params?.filter ?? "all";
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 25;
    const shouldFilterManually = filter !== "all";
    // First-page requests do not need to scan the entire inbox for badge counts.
    const summaryRows = shouldFilterManually || params?.includeSummary !== false
      ? await this.getSummaryRows(params?.user)
      : null;
    const summary = summaryRows ? buildConversationSummary(summaryRows) : undefined;
    const matchingRows = shouldFilterManually ? summaryRows!.filter((row) => matchesConversationFilter({
      state: row.state, isStalled: getConversationFlowStatus(row).isStalled,
    }, filter)) : null;
    const [conversations, total] = await Promise.all([
      this.chatbotRepository.listConversations({
        skip: shouldFilterManually ? 0 : offset,
        take: limit,
        ...(matchingRows ? { ids: matchingRows.slice(offset, offset + limit).map((row) => row.id) } : {}),
        user: params?.user,
      }),
      matchingRows ? Promise.resolve(matchingRows.length)
        : summaryRows ? Promise.resolve(summaryRows.length)
        : this.chatbotRepository.countConversations(params?.user),
    ]);

    const allItems = conversations.map((conversation) => {
      const memory = this.parseMemory(conversation.memory);
      const lastMessage = conversation.messages[0] ?? null;
      const latestInboundAt = conversation.messages.find((message) => message.direction === "inbound")?.createdAt ?? null;
      const latestOutboundAt = conversation.messages.find((message) => message.direction === "outbound")?.createdAt ?? null;
      const hasPendingCustomerMessage = Boolean(
        latestInboundAt && (!latestOutboundAt || latestInboundAt.getTime() > latestOutboundAt.getTime()),
      );
      const liveStatus = getConversationFlowStatus({
        state: conversation.state,
        memory,
        ownerUserId: conversation.ownerUserId,
        updatedAt: conversation.updatedAt.toISOString(),
        messages: conversation.messages.map((message) => ({
          direction: message.direction,
          createdAt: message.createdAt.toISOString(),
        })),
      });

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
        isStalled: liveStatus.isStalled,
        stalledStageLabel: liveStatus.stalledStageLabel,
        hasPendingCustomerMessage,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              direction: lastMessage.direction,
              body: lastMessage.body,
              createdAt: lastMessage.createdAt.toISOString(),
            }
          : null,
      };
    });

    const items = allItems;

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total,
      summary,
    };
  }

  private async getSummaryRows(user?: LeadAccessUser) {
    const rows = await this.chatbotRepository.listConversationSummaries(user);
    return rows.map((row) => ({
      id: row.id, state: row.state, memory: {},
      ownerUserId: row.ownerUserId, updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((message) => ({ direction: message.direction, createdAt: message.createdAt.toISOString() })),
    }));
  }

  async getSummary(user: LeadAccessUser) {
    return buildConversationSummary(await this.getSummaryRows(user));
  }

  async getDetail(
    conversationId: string,
    user?: LeadAccessUser,
    params?: { offset?: number; limit?: number },
  ) {
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 40;
    const conversation = await this.chatbotRepository.getConversationById(conversationId, user, {
      skip: offset,
      take: limit,
    });
    if (!conversation) return null;

    const memory = this.parseMemory(conversation.memory);
    const chronologicalMessages = [...conversation.messages]
      .reverse()
      .map((message) => ({
        id: message.id,
        direction: message.direction,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      }));

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
      messages: chronologicalMessages,
      messagesPagination: {
        total: conversation._count.messages,
        offset,
        limit,
        hasMore: offset + chronologicalMessages.length < conversation._count.messages,
      },
    };
  }

  async listAssignableUsers() {
    return this.chatbotRepository.listAssignableUsers();
  }

  async assignOwner(conversationId: string, ownerUserId: string | null, user?: LeadAccessUser) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.assignConversationOwner(conversationId, ownerUserId);
    return this.getDetail(conversationId, user);
  }

  async toggleBotControl(conversationId: string, ownerUserId: string | null, user?: LeadAccessUser) {
    const detail = await this.getDetail(conversationId, user);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.assignConversationOwner(conversationId, detail.botActive ? ownerUserId : null);
    return this.getDetail(conversationId, user);
  }

  async updateTags(conversationId: string, tags: ConversationTag[], user?: LeadAccessUser) {
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

  async sendManualMessage(params: { conversationId: string; content: string; user?: LeadAccessUser }) {
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
    user?: LeadAccessUser;
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

  async deleteConversation(conversationId: string, user?: LeadAccessUser) {
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
    let failed = 0;

    for (const conversation of conversations) {
      const memory = this.parseMemory(conversation.memory);
      const nextStep = getNextFollowUpStep(memory, now);
      if (!nextStep) continue;

      const message = buildFollowUpMessage(nextStep.stage, memory.awaitingFlowState ?? conversation.state);

      if (message) {
        try {
          await this.sendFollowUpMessage({
            phone: conversation.phone,
            message,
            agent: conversation.agent,
          });
        } catch (error) {
          failed += 1;

          await writeTechnicalLog({
            level: "ERROR",
            category: "chatbot",
            message: "Falha ao enviar lembrete automático da Cris.",
            method: "POST",
            endpoint: "cron/conversations-follow-up",
            integration: "zapi",
            metadata: {
              conversationId: conversation.id,
              phone: conversation.phone,
              stage: nextStep.stage,
              state: conversation.state,
              error: error instanceof Error ? error.message : String(error),
            },
          });

          continue;
        }

        await this.chatbotRepository.saveMessage({
          conversationId: conversation.id,
          direction: "outbound",
          body: message,
          sentAt: now,
        });
      }

      const nextMemory: ConversationMemory = {
        ...memory,
        followUpStage: nextStep.stage,
        followUpLastSentAt: now.toISOString(),
      };

      await this.chatbotRepository.updateConversationMemory(conversation.id, nextMemory as Prisma.InputJsonValue);
      processed += 1;
    }

    return { processed, failed };
  }

  private async sendFollowUpMessage(params: {
    phone: string;
    message: string;
    agent?: {
      zapiBaseUrl?: string | null;
      zapiInstanceId?: string | null;
      zapiToken?: string | null;
      zapiClientToken?: string | null;
      zapiWhatsappNumber?: string | null;
    } | null;
  }) {
    const config = agentConfig(params.agent);

    try {
      await this.zapiService.sendText({
        phone: params.phone,
        message: params.message,
        config,
      });
      return;
    } catch (error) {
      if (!shouldRetryWithDefaultConfig(error, config)) {
        throw error;
      }
    }

    await this.zapiService.sendText({
      phone: params.phone,
      message: params.message,
    });
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
  ownerUserId: string | null;
  updatedAt: string;
  messages: Array<{ direction: string; createdAt: string }>;
};

function buildConversationSummary(rows: ConversationSummaryRow[]) {
  let unavailable = 0;
  let finished = 0;
  let stalled = 0;

  for (const row of rows) {
    const liveStatus = getConversationFlowStatus(row);
    if (row.state === "FINISHED_UNAVAILABLE") unavailable += 1;
    if (row.state === "FINISHED") finished += 1;
    if (liveStatus.isStalled) stalled += 1;
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
  if (filter === "stalled") return Boolean(conversation.isStalled);
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

function shouldRetryWithDefaultConfig(error: unknown, config?: ReturnType<typeof agentConfig>) {
  if (!config || !config.instanceId || !config.token) {
    return false;
  }

  // Complete per-agent credentials must never fall back to another WhatsApp account.
  if (/^[a-f0-9]{32}$/i.test(config.instanceId)) return false;

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("instance not found") || message.includes("status=404");
}

function getNextFollowUpStep(memory: ConversationMemory, now: Date) {
  if (!memory.awaitingFlowState || memory.followUpClosedAt || memory.followUpPaused || memory.salesPaused) {
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

function getConversationFlowStatus(input: {
  state: string;
  memory: ConversationMemory;
  ownerUserId: string | null;
  updatedAt: string;
  messages: Array<{ direction: string; createdAt: string }>;
}) {
  if (
    input.ownerUserId ||
    ["START", "FINISHED", "FINISHED_UNAVAILABLE", "HUMAN_HANDOFF"].includes(input.state)
  ) {
    return { isStalled: false, stalledStageLabel: null as string | null };
  }

  const latestInbound = input.messages.find((message) => message.direction === "inbound");
  const latestOutbound = input.messages.find((message) => message.direction === "outbound");
  const outboundAt = latestOutbound ? new Date(latestOutbound.createdAt) : null;
  const inboundAt = latestInbound ? new Date(latestInbound.createdAt) : null;
  const crisWasLastToReply = Boolean(
    outboundAt &&
    (!inboundAt || outboundAt.getTime() >= inboundAt.getTime()),
  );

  if (!crisWasLastToReply) {
    return { isStalled: false, stalledStageLabel: null as string | null };
  }

  return {
    isStalled: true,
    stalledStageLabel: promptLabelForState(input.memory.awaitingFlowState ?? input.state),
  };
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

  if (stage === 4) return "";

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
