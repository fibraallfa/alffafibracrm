import type { Prisma } from "@prisma/client";
import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { ZapiService } from "@/services/zapi/zapi.service";

type ConversationMemory = {
  tags?: string[];
  [key: string]: unknown;
};

export class ConversationService {
  constructor(
    private readonly chatbotRepository = new ChatbotRepository(),
    private readonly zapiService = new ZapiService(),
  ) {}

  async list() {
    const conversations = await this.chatbotRepository.listConversations();

    return conversations.map((conversation) => {
      const memory = this.parseMemory(conversation.memory);
      const lastMessage = conversation.messages[0] ?? null;

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
    });
  }

  async getDetail(conversationId: string) {
    const conversation = await this.chatbotRepository.getConversationById(conversationId);
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

  async assignOwner(conversationId: string, ownerUserId: string | null) {
    await this.chatbotRepository.assignConversationOwner(conversationId, ownerUserId);
    return this.getDetail(conversationId);
  }

  async toggleBotControl(conversationId: string, ownerUserId: string | null) {
    const detail = await this.getDetail(conversationId);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    await this.chatbotRepository.assignConversationOwner(conversationId, detail.botActive ? ownerUserId : null);
    return this.getDetail(conversationId);
  }

  async updateTags(conversationId: string, tags: string[]) {
    const detail = await this.getDetail(conversationId);
    if (!detail) {
      throw new Error("Conversa não encontrada.");
    }

    const memory = {
      ...(detail.memory ?? {}),
      tags: normalizeTags(tags),
    };

    await this.chatbotRepository.updateConversationMemory(conversationId, memory as Prisma.InputJsonValue);
    return this.getDetail(conversationId);
  }

  async sendManualMessage(params: { conversationId: string; content: string }) {
    const conversation = await this.chatbotRepository.getConversationById(params.conversationId);
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

    return this.getDetail(conversation.id);
  }

  async sendManualMedia(params: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    caption?: string;
  }) {
    const conversation = await this.chatbotRepository.getConversationById(params.conversationId);
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

    return this.getDetail(conversation.id);
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

  private parseMemory(memory: unknown): ConversationMemory {
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
      return {};
    }

    const record = memory as Record<string, unknown>;
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return {
      ...record,
      tags,
    };
  }
}

function normalizeTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 20);
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
