import assert from "node:assert/strict";
import test from "node:test";
import { ChatbotEngineService } from "../src/modules/chatbot/services/chatbot-engine.service.ts";
import { ChatbotRepository } from "../src/repositories/chatbot.repository.ts";
import { prisma } from "../src/lib/prisma.ts";
import { GIOVANA_AGENT_ID, GIOVANA_RECOMMENDED_PLAN_ID, giovanaPlans } from "../src/config/giovana.ts";
import { leadSourceLabel } from "../src/modules/leads/types/lead-source.ts";
import { ConversationService } from "../src/modules/chatbot/services/conversation.service.ts";
import { handleZapiWebhook } from "../src/modules/chatbot/services/zapi-webhook.ts";

const agent = { id: GIOVANA_AGENT_ID, name: "Giovana", rules: { recommendedPlanId: GIOVANA_RECOMMENDED_PLAN_ID }, flow: {} };
const catalog = giovanaPlans.map((plan) => ({ ...plan, description: null }));
const input = (state, message, memory = {}) => ({ phone: "5511000000000", state, message, memory, agent });
const engine = () => new ChatbotEngineService({}, { async listActivePlans(id) { assert.equal(id, GIOVANA_AGENT_ID); return catalog; } }, {}, {});

for (const message of ["Ok", "Está", "Está tudo correto!", "Sim, pode continuar", "Confirmo ✅"]) {
  test(`summary confirmation completes with ${message} without relying on AI`, async () => {
    let created = 0;
    const service = new ChatbotEngineService({}, {
      async createLeadFromChat(data) { created++; assert.equal(data.source, "chatbot:giovana"); return { id: "lead" }; },
    }, {}, { async interpretFlowMessage() { throw new Error("Explicit confirmation should not need AI"); } });
    const result = await service.nextResponse(input("CONFIRM_DATA", message, { name: "Ana Souza", planId: catalog[1].id }));
    assert.equal(result.state, "FINISHED");
    assert.equal(created, 1);
  });
}

for (const message of ["Ok, mas o endereco esta errado", "Está correto?", "Nao confirmo", "Sim, mas quanto custa cancelar?"]) {
  test(`qualified or ambiguous confirmation cannot create a lead: ${message}`, async () => {
    const service = new ChatbotEngineService({}, {
      async createLeadFromChat() { throw new Error("Must not create lead"); },
      async listActivePlans() { return catalog; },
    }, {}, { async interpretFlowMessage() { return { intent: "answer", value: message, question: null }; } });
    const result = await service.nextResponse(input("CONFIRM_DATA", message));
    assert.notEqual(result.state, "FINISHED");
  });
}

function mockPrisma(t, delegate, method, implementation) {
  const original = delegate[method];
  delegate[method] = implementation;
  t.after(() => { delegate[method] = original; });
}

test("Giovana recommends 600Mb for 69.90 rather than the Cris 500Mb combo", async () => {
  const result = await engine().runFlow(input("ASK_EMAIL", "teste@example.com", { name: "Ana Souza" }));
  assert.equal(result.memory.recommendedPlanId, GIOVANA_RECOMMENDED_PLAN_ID);
  assert.match(result.reply, /Oferta Especial 600Mb por R\$\s*69,90/);
  const confirmed = await engine().runFlow(input("RECOMMEND_PLAN", "sim", result.memory));
  assert.equal(confirmed.memory.planId, GIOVANA_RECOMMENDED_PLAN_ID);
  assert.equal(confirmed.state, "CONFIRM_DATA");
});

for (const [message, index] of [["350mb", 0], ["600mb", 1], ["oferta especial", 1], ["500 mega com celular", 2], ["1 giga com celular", 3]]) {
  test(`Giovana accepts ${message}`, async () => {
    const result = await engine().runFlow(input("CHOOSE_PLAN", message));
    assert.equal(result.memory.planId, catalog[index].id);
    assert.equal(result.state, "CONFIRM_DATA");
  });
}

test("Giovana does not accept an unavailable plan", async () => {
  const result = await engine().runFlow(input("CHOOSE_PLAN", "250mb"));
  assert.equal(result.state, "CHOOSE_PLAN");
  assert.equal(result.memory.planId, undefined);
  assert.doesNotMatch(result.reply, /250Mb|SUPER COMBO|159,70|99,90/);
});

test("foreign or edited plans are excluded from Giovana catalog", async () => {
  const service = new ChatbotEngineService({}, { async listActivePlans() { return [...catalog, { id: "foreign", name: "Plano 250Mb", price: 59.9 }, { ...catalog[0], price: 1 }]; } }, {}, {});
  assert.deepEqual(await service.getPlans(agent), catalog);
});

test("Cris retains his existing recommendation", async () => {
  const plans = [{ id: "cris-500", name: "Plano 500Mb (Wi-Fi) + 60Gb (Celular)", speed: "500Mb", price: 129.9 }, { id: "cris-1gb", name: "Plano 1Gb", speed: "1Gb", price: 179.9 }];
  const service = new ChatbotEngineService({}, { async listActivePlans() { return plans; } }, {}, {});
  const result = await service.runFlow({ ...input("ASK_EMAIL", "teste@example.com"), agent: { id: "cris", name: "Cris", rules: {} } });
  assert.equal(result.memory.recommendedPlanId, "cris-500");
});

test("Giovana creates a lead with explicit origin", async () => {
  let saved;
  const service = new ChatbotEngineService({}, { async createLeadFromChat(data) { saved = data; return { id: "lead" }; } }, {}, {});
  const result = await service.runFlow(input("CONFIRM_DATA", "sim", { name: "Ana Souza", planId: catalog[1].id, planName: catalog[1].name, planValue: 69.9 }));
  assert.equal(saved.source, "chatbot:giovana");
  assert.match(saved.notes, /Giovana/);
  assert.equal(result.state, "FINISHED");
  assert.equal(leadSourceLabel(saved.source), "Giovana");
  assert.equal(leadSourceLabel("chatbot"), "Cris");
});

test("same phone never reuses Cris or legacy conversations for Giovana", async (t) => {
  mockPrisma(t, prisma.chatConversation, "findFirst", async ({ where }) => {
    assert.equal(where.agentId, GIOVANA_AGENT_ID);
    return null;
  });
  mockPrisma(t, prisma.chatConversation, "create", async ({ data }) => data);
  const result = await new ChatbotRepository().findOrCreateConversation("5511000000000", GIOVANA_AGENT_ID);
  assert.equal(result.agentId, GIOVANA_AGENT_ID);
  assert.equal(result.state, "START");
});

test("same phone keeps separate lead origins", async (t) => {
  const queries = [];
  mockPrisma(t, prisma.lead, "findFirst", async ({ where }) => { queries.push(where); return null; });
  mockPrisma(t, prisma.lead, "create", async ({ data }) => data);
  const repository = new ChatbotRepository();
  await repository.createLeadFromChat({ phone: "5511000000000", name: "Ana Souza", source: "chatbot:giovana" });
  await repository.createLeadFromChat({ phone: "5511000000000", name: "Ana Souza" });
  assert.equal(queries[0].source, "chatbot:giovana");
  assert.deepEqual(queries[1].source, { not: "chatbot:giovana" });
});

test("Giovana webhook rejects another instance without processing messages", async (t) => {
  mockPrisma(t, prisma.agent, "findFirst", async () => ({ zapiInstanceId: "giovana-instance", zapiToken: "test", zapiClientToken: "test" }));
  const response = await handleZapiWebhook(new Request("http://localhost/api/webhooks/zapi/giovana", {
    method: "POST", body: JSON.stringify({ instanceId: "cris-instance", phone: "5511000000000", text: { message: "oi" } }),
  }), GIOVANA_AGENT_ID);
  assert.equal(response.status, 403);
});

test("Giovana webhook accepts its own instance and ignores outgoing messages", async (t) => {
  mockPrisma(t, prisma.agent, "findFirst", async () => ({ zapiInstanceId: "giovana-instance", zapiToken: "test", zapiClientToken: "test" }));
  const response = await handleZapiWebhook(new Request("http://localhost/api/webhooks/zapi/giovana", {
    method: "POST", body: JSON.stringify({ instanceId: "giovana-instance", fromMe: true }),
  }), GIOVANA_AGENT_ID);
  assert.equal(response.status, 200);
});

test("Giovana follow-up failure never sends from default Cris instance", async () => {
  const calls = [];
  const service = new ConversationService({}, { async sendText(input) { calls.push(input); throw new Error("status=404 instance not found"); } });
  await assert.rejects(service.sendFollowUpMessage({ phone: "5511000000000", message: "teste", agent: {
    zapiInstanceId: "a".repeat(32), zapiToken: "test", zapiClientToken: "test",
  } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.instanceId, "a".repeat(32));
});

test("Giovana namespaces message deduplication and sends with her credentials", async () => {
  let saved, outgoing, readId;
  const repository = {
    async withInboundLock(phone, work) { return work(); },
    async getAgentByInstance() { return { ...agent, zapiInstanceId: "giovana", zapiToken: "test-giovana", zapiClientToken: "test-client" }; },
    async findMessageByProviderId(id) { assert.equal(id, `${GIOVANA_AGENT_ID}:message1`); return null; },
    async findOrCreateConversation(phone, id) { assert.equal(id, GIOVANA_AGENT_ID); return { id: "giovana-chat", state: "START", memory: {}, messages: [] }; },
    async claimInboundMessage(input) { assert.equal(input.providerId, `${GIOVANA_AGENT_ID}:message1`); return true; },
    async saveBotReply(input) { saved = input; },
  };
  const service = new ChatbotEngineService({}, repository, {
    async markAsRead(id) { readId = id; }, async sendText(input) { outgoing = input; },
  }, {});
  service.nextResponse = async () => ({ state: "ASK_CEP", memory: {}, reply: "Sou a Giovana" });
  await service.processIncomingMessage({ phone: "5511000000000", message: "oi", instanceId: "giovana", providerId: "message1" });
  assert.equal(outgoing.config.token, "test-giovana");
  assert.equal(readId, "message1");
  assert.equal(saved.responseToProviderId, `${GIOVANA_AGENT_ID}:message1`);
});
