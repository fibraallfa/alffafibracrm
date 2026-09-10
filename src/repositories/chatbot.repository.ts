import { Prisma, type User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishConversationEvent } from "@/server/realtime/conversation-events";
import { withInboundLock } from "@/server/realtime/inbound-lock";

export class ChatbotRepository {
  withInboundLock<T>(phone: string, work: () => Promise<T>) {
    return withInboundLock(phone, work);
  }

  async hasResponseToProviderId(conversationId: string, providerId: string) {
    return Boolean(await prisma.chatMessage.findFirst({
      where: { conversationId, direction: "outbound", rawPayload: { path: ["responseToProviderId"], equals: providerId } },
      select: { id: true },
    }));
  }

  async saveBotReply(input: { conversationId: string; body: string; responseToProviderId?: string; state: string; memory: Prisma.InputJsonValue; leadId?: string }) {
    // Persist reply receipt and state together so retries cannot see only half the update.
    await prisma.$transaction([
      prisma.chatMessage.create({ data: { conversationId: input.conversationId, direction: "outbound", body: input.body,
        rawPayload: input.responseToProviderId ? { responseToProviderId: input.responseToProviderId } : {},
      } }),
      prisma.chatConversation.update({ where: { id: input.conversationId }, data: {
        state: input.state, memory: input.memory, leadId: input.leadId, updatedAt: new Date(),
      } }),
    ]);
    await publishConversationEvent({ conversationId: input.conversationId, type: "outbound_message" });
  }
  async findMessageByProviderId(providerId: string) {
    return prisma.chatMessage.findFirst({
      where: { providerId },
      select: { id: true, conversationId: true, createdAt: true },
    });
  }

  async hasOutboundResponseAfter(conversationId: string, receivedAt: Date) {
    const response = await prisma.chatMessage.findFirst({
      where: {
        conversationId,
        direction: "outbound",
        createdAt: { gte: receivedAt },
      },
      select: { id: true },
    });

    return Boolean(response);
  }

  async findOrCreateConversation(phone: string, agentId?: string) {
    const existingForAgent = agentId
      ? await prisma.chatConversation.findFirst({
        where: { phone, agentId, deletedAt: null },
        include: { messages: { orderBy: { createdAt: "desc" }, take: 10 }, owner: true, lead: true, agent: true },
        orderBy: { updatedAt: "desc" },
      })
      : null;

    if (existingForAgent) {
      return existingForAgent;
    }

    const existing = await prisma.chatConversation.findFirst({
      where: { phone, deletedAt: null },
      include: { messages: { orderBy: { createdAt: "desc" }, take: 10 }, owner: true, lead: true, agent: true },
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      if (!existing.agentId && agentId) {
        return prisma.chatConversation.update({
          where: { id: existing.id },
          data: { agentId },
          include: { messages: { orderBy: { createdAt: "desc" }, take: 10 }, owner: true, lead: true, agent: true },
        });
      }
      return existing;
    }

    return prisma.chatConversation.create({
      data: { phone, agentId, state: "START", memory: {} },
      include: { messages: true, owner: true, lead: true, agent: true },
    });
  }

  async saveMessage(input: {
    conversationId: string;
    direction: "inbound" | "outbound";
    body: string;
    providerId?: string;
    sentAt?: Date;
    rawPayload?: Prisma.InputJsonValue;
  }) {
    const message = await prisma.chatMessage.create({
      data: input,
    });

    await prisma.chatConversation.update({
      where: { id: input.conversationId },
      data: { updatedAt: new Date() },
    });

    await publishConversationEvent({
      conversationId: input.conversationId,
      type: input.direction === "inbound" ? "inbound_message" : "outbound_message",
    });

    return message;
  }

  async claimInboundMessage(input: {
    conversationId: string;
    body: string;
    providerId: string;
    rawPayload?: Prisma.InputJsonValue;
  }) {
    try {
      await prisma.chatMessage.create({
        data: {
          ...input,
          direction: "inbound",
        },
      });
      await prisma.chatConversation.update({
        where: { id: input.conversationId },
        data: { updatedAt: new Date() },
      });
      await publishConversationEvent({
        conversationId: input.conversationId,
        type: "inbound_message",
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false;
      }
      throw error;
    }
  }

  async updateConversation(input: {
    id: string;
    state: string;
    memory: Prisma.InputJsonValue;
    leadId?: string;
    ownerUserId?: string | null;
  }) {
    const conversation = await prisma.chatConversation.update({
      where: { id: input.id },
      data: {
        state: input.state,
        memory: input.memory,
        leadId: input.leadId,
        ownerUserId: input.ownerUserId,
      },
    });

    await publishConversationEvent({
      conversationId: input.id,
      type: "conversation_updated",
    });

    return conversation;
  }

  async createLeadFromChat(input: {
    name: string;
    phone: string;
    email?: string;
    cpfCnpj?: string;
    birthDate?: Date;
    cep?: string;
    address?: string;
    streetNumber?: string;
    complement?: string;
    city?: string;
    state?: string;
    neighborhood?: string;
    billingDueDay?: number;
    planId?: string;
    planName?: string;
    expectedValue?: number;
    notes?: string;
  }) {
    const existing = await prisma.lead.findFirst({
      where: { phone: input.phone, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });

    const data = {
      name: input.name,
      phone: input.phone,
      email: input.email,
      cpfCnpj: input.cpfCnpj,
      birthDate: input.birthDate,
      cep: input.cep,
      address: input.address,
      streetNumber: input.streetNumber,
      complement: input.complement,
      city: input.city,
      state: input.state,
      neighborhood: input.neighborhood,
      billingDueDay: input.billingDueDay,
      planId: input.planId,
      planName: input.planName,
      planValue: input.expectedValue,
      expectedValue: input.expectedValue,
      source: "chatbot",
      notes: input.notes,
    };

    if (existing) {
      return prisma.lead.update({
        where: { id: existing.id },
        data: {
          ...data,
          status: existing.status === "LOST" ? "NEW" : existing.status,
        },
      });
    }

    return prisma.lead.create({
      data: {
        ...data,
        cep: input.cep,
      },
    });
  }

  async getDefaultAgent() {
    return prisma.agent.findFirst({
      where: { active: true, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  async getAgentByInstance(instanceId?: string) {
    if (instanceId) {
      const agent = await prisma.agent.findFirst({
        where: { zapiInstanceId: instanceId, active: true, deletedAt: null },
        include: { plans: { where: { active: true, deletedAt: null }, orderBy: [{ order: "asc" }, { price: "asc" }] } },
      });
      if (agent) return agent;
    }
    return prisma.agent.findFirst({
      where: { active: true, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { plans: { where: { active: true, deletedAt: null }, orderBy: [{ order: "asc" }, { price: "asc" }] } },
    });
  }

  async listActivePlans(agentId?: string) {
    return prisma.plan.findMany({
      where: { active: true, deletedAt: null, agents: agentId ? { some: { id: agentId } } : undefined },
      orderBy: [{ order: "asc" }, { price: "asc" }],
    });
  }

  async countConversations(user?: Pick<User, "id" | "role">) {
    return prisma.chatConversation.count({
      where: buildConversationAccessWhere(user),
    });
  }

  async listConversations(params?: { skip?: number; take?: number; ids?: string[]; user?: Pick<User, "id" | "role"> }) {
    return prisma.chatConversation.findMany({
      where: { ...buildConversationAccessWhere(params?.user), ...(params?.ids ? { id: { in: params.ids } } : {}) },
      select: {
        id: true,
        phone: true,
        state: true,
        updatedAt: true,
        ownerUserId: true,
        memory: true,
        lead: {
          select: {
            id: true,
            name: true,
          },
        },
        agent: {
          select: {
            id: true,
            name: true,
          },
        },
        owner: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
        messages: {
          select: {
            id: true,
            direction: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 2,
        },
      },
      orderBy: { updatedAt: "desc" },
      skip: params?.skip ?? 0,
      take: params?.take ?? 25,
    });
  }

  async listConversationSummaries(user?: Pick<User, "id" | "role">) {
    return prisma.chatConversation.findMany({
      where: buildConversationAccessWhere(user),
      select: {
        id: true,
        state: true,
        ownerUserId: true,
        updatedAt: true,
        messages: {
          select: {
            id: true,
            direction: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async listAutoFollowUpCandidates() {
    return prisma.chatConversation.findMany({
      where: {
        deletedAt: null,
        ownerUserId: null,
        state: {
          notIn: ["START", "FINISHED", "FINISHED_UNAVAILABLE", "HUMAN_HANDOFF"],
        },
      },
      include: {
        agent: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
  }

  async getConversationById(
    id: string,
    user?: Pick<User, "id" | "role">,
    messages?: { skip?: number; take?: number },
  ) {
    return prisma.chatConversation.findFirst({
      where: { id, ...buildConversationAccessWhere(user) },
      select: {
        id: true,
        phone: true,
        state: true,
        updatedAt: true,
        ownerUserId: true,
        memory: true,
        lead: true,
        agent: true,
        owner: true,
        _count: {
          select: {
            messages: true,
          },
        },
        messages: {
          select: {
            id: true,
            direction: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          skip: messages?.skip ?? 0,
          take: messages?.take ?? 40,
        },
      },
    });
  }

  async assignConversationOwner(conversationId: string, ownerUserId: string | null) {
    const conversation = await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { ownerUserId },
    });

    await publishConversationEvent({
      conversationId,
      type: ownerUserId ? "conversation_assumed" : "conversation_returned",
    });

    return conversation;
  }

  async updateConversationMemory(conversationId: string, memory: Prisma.InputJsonValue) {
    const conversation = await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { memory },
    });

    await publishConversationEvent({
      conversationId,
      type: "conversation_updated",
    });

    return conversation;
  }

  async touchConversation(conversationId: string) {
    const conversation = await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    await publishConversationEvent({
      conversationId,
      type: "conversation_updated",
    });

    return conversation;
  }

  async listAssignableUsers() {
    return prisma.user.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        role: true,
      },
    });
  }

  async softDeleteConversation(conversationId: string) {
    const conversation = await prisma.chatConversation.update({
      where: { id: conversationId },
      data: {
        deletedAt: new Date(),
      },
    });

    await publishConversationEvent({
      conversationId,
      type: "conversation_deleted",
    });

    return conversation;
  }
}

function buildConversationAccessWhere(user?: Pick<User, "id" | "role">): Prisma.ChatConversationWhereInput {
  if (user?.role === "EMPLOYEE") {
    return {
      deletedAt: null,
      ownerUserId: user.id,
    };
  }

  return {
    deletedAt: null,
  };
}
