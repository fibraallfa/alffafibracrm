import type { Prisma, User } from "@prisma/client";
import { GIOVANA_AGENT_ID } from "@/config/giovana";

export type LeadAccessUser = Pick<User, "id" | "role"> & Partial<Pick<User, "permissions">>;
export type LeadAgentScope = "cris" | "giovana" | "both";

export function resolveLeadAgentScope(user: LeadAccessUser | undefined, requested?: unknown): LeadAgentScope {
  const allowed = getLeadAgentScope(user?.permissions);
  if (allowed !== "both") return allowed;
  return requested === "cris" || requested === "giovana" ? requested : "both";
}

export function getLeadAgentScope(value: unknown): LeadAgentScope {
  const flags = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (flags["leads.onlyCris"] === true && flags["leads.onlyGiovana"] !== true) return "cris";
  if (flags["leads.onlyGiovana"] === true && flags["leads.onlyCris"] !== true) return "giovana";
  return "both";
}

export function leadSourceWhere(user?: LeadAccessUser, requestedScope?: unknown): Prisma.LeadWhereInput {
  const scope = resolveLeadAgentScope(user, requestedScope);
  if (scope === "cris") return { source: { in: ["chatbot", "chatbot:cris"] } };
  if (scope === "giovana") return { source: "chatbot:giovana" };
  return {};
}

export function conversationAgentWhere(user?: LeadAccessUser, requestedScope?: unknown): Prisma.ChatConversationWhereInput {
  const scope = resolveLeadAgentScope(user, requestedScope);
  if (scope === "giovana") return { agentId: GIOVANA_AGENT_ID };
  if (scope === "cris") return { OR: [{ agentId: null }, { agentId: { not: GIOVANA_AGENT_ID } }] };
  return {};
}
