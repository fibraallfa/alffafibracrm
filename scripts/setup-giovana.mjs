import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { GIOVANA_AGENT_ID, GIOVANA_RECOMMENDED_PLAN_ID, giovanaPlans } from "../src/config/giovana.ts";

const prisma = new PrismaClient();
const credentialKeys = ["GIOVANA_ZAPI_INSTANCE_ID", "GIOVANA_ZAPI_TOKEN", "GIOVANA_ZAPI_CLIENT_TOKEN", "GIOVANA_ZAPI_WHATSAPP_NUMBER"];
for (const key of credentialKeys) assert(process.env[key], `Variavel obrigatoria: ${key}`);

function personalize(value) {
  if (typeof value === "string") return value.replace(/\bo Cris\b/g, "a Giovana")
    .replace(/\bO Cris\b/g, "A Giovana").replace(/\bCris\b/g, "Giovana")
    .replace(/\bconsultor\b/gi, "consultora").replace(/\bMasculino\b/g, "Feminino");
  if (Array.isArray(value)) return value.map(personalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, personalize(entry)]));
  return value;
}

try {
  await prisma.$transaction(async (tx) => {
    const cris = await tx.agent.findFirst({ where: { name: "Cris", active: true, deletedAt: null }, include: { plans: true } });
    assert(cris, "Agente Cris nao encontrado; cadastro cancelado.");
    const existing = await tx.agent.findFirst({ where: { OR: [{ id: GIOVANA_AGENT_ID }, { name: "Giovana", deletedAt: null }] } });
    assert(!existing, "Giovana ja cadastrada; nenhuma configuracao sera sobrescrita.");
    const conflict = await tx.agent.findFirst({ where: { zapiInstanceId: process.env.GIOVANA_ZAPI_INSTANCE_ID, deletedAt: null } });
    assert(!conflict, "Instancia ja vinculada a outro agente.");
    for (const plan of giovanaPlans) {
      await tx.plan.create({ data: { ...plan, description: "Plano exclusivo do atendimento Giovana.", active: true } });
    }
    await tx.agent.create({ data: {
      id: GIOVANA_AGENT_ID, name: "Giovana", gender: "FEMALE", active: true,
      personality: personalize(cris.personality), flow: personalize(cris.flow),
      rules: { ...personalize(cris.rules), recommendedPlanId: GIOVANA_RECOMMENDED_PLAN_ID,
        catalogoExclusivo: "Use exclusivamente os quatro planos vinculados a Giovana. Nunca mencione, recomende ou aceite planos de outro atendimento. Recomende Oferta Especial 600Mb por R$ 69,90. Se o cliente pedir outro plano, explique que ele nao esta disponivel neste atendimento e apresente apenas as opcoes do catalogo." },
      minTypingSeconds: cris.minTypingSeconds, maxTypingSeconds: cris.maxTypingSeconds,
      enableReadReceipt: cris.enableReadReceipt, enableTyping: cris.enableTyping,
      enableReplyDelay: cris.enableReplyDelay, openAiModel: cris.openAiModel,
      zapiBaseUrl: "https://api.z-api.io", zapiInstanceId: process.env.GIOVANA_ZAPI_INSTANCE_ID,
      zapiToken: process.env.GIOVANA_ZAPI_TOKEN, zapiClientToken: process.env.GIOVANA_ZAPI_CLIENT_TOKEN,
      zapiWhatsappNumber: process.env.GIOVANA_ZAPI_WHATSAPP_NUMBER,
      plans: { connect: giovanaPlans.map(({ id }) => ({ id })) },
    } });
    const after = await tx.agent.findUnique({ where: { id: cris.id }, include: { plans: true } });
    assert.deepEqual(after, cris, "A configuracao do Cris deve permanecer identica.");
  }, { timeout: 30000 });
  console.log("Giovana cadastrada com quatro planos. Configuracao do Cris preservada.");
} finally {
  await prisma.$disconnect();
}
