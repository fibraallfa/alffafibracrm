import type { Prisma, User } from "@prisma/client";

export type LeadAccessUser = Pick<User, "id" | "role"> & Partial<Pick<User, "permissions">>;
export type LeadAgentScope = "cris" | "giovana" | "both";

export function getLeadAgentScope(value: unknown): LeadAgentScope {
  const flags = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (flags["leads.onlyCris"] === true && flags["leads.onlyGiovana"] !== true) return "cris";
  if (flags["leads.onlyGiovana"] === true && flags["leads.onlyCris"] !== true) return "giovana";
  return "both";
}

export function leadSourceWhere(user?: LeadAccessUser): Prisma.LeadWhereInput {
  if (user?.role !== "EMPLOYEE") return {};
  const scope = getLeadAgentScope(user.permissions);
  if (scope === "cris") return { source: { in: ["chatbot", "chatbot:cris"] } };
  if (scope === "giovana") return { source: "chatbot:giovana" };
  return {};
}
