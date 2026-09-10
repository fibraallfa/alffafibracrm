import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEngineService, enforceLoyaltyGuidance } from '../src/modules/chatbot/services/chatbot-engine.service.ts';

const message = (memory, text = 'não quero') => ({ phone: '5511000000000', state: 'ASK_NAME', message: text, memory, agent: null });
function engineFor(intent, value = null) {
  return new ChatbotEngineService({}, {}, {}, {
    async interpretFlowMessage() { return { intent, value, question: null }; },
  });
}

test('three distinct attempts, fourth refusal pauses with stage and data intact', async () => {
  const engine = engineFor('decline');
  let memory = { cep: '09340450', billingDueDay: 15 };
  const replies = new Set();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = await engine.nextResponse(message(memory));
    assert.equal(next.state, 'ASK_NAME');
    assert.equal(next.memory.objectionCount, attempt);
    assert.equal(next.memory.salesPaused, undefined);
    replies.add(next.reply);
    memory = next.memory;
  }
  assert.equal(replies.size, 3);
  const paused = await engine.nextResponse(message(memory));
  assert.equal(paused.memory.salesPaused, true);
  assert.equal(paused.memory.followUpPaused, true);
  assert.equal(paused.memory.cep, '09340450');
  assert.equal(paused.state, 'ASK_NAME');
});

test('explicit stop works even with unavailable interpreter', async () => {
  const engine = new ChatbotEngineService({}, {}, {}, { async interpretFlowMessage() { throw new Error('Must not call'); } });
  const next = await engine.nextResponse(message({ name: 'Ana Souza', awaitingFlowState: 'ASK_NAME' }, 'Pare de me mandar mensagens'));
  assert.equal(next.memory.salesPaused, true);
  assert.equal(next.memory.awaitingFlowState, undefined);
});

test('return to a paused conversation asks the pending field without resetting collected data', async () => {
  const next = await engineFor('resume').nextResponse(message({ salesPaused: true, followUpPaused: true, objectionCount: 3, cep: '09340450' }, 'quero contratar agora'));
  assert.equal(next.state, 'ASK_NAME');
  assert.equal(next.memory.cep, '09340450');
  assert.equal(next.memory.salesPaused, false);
  assert.equal(next.memory.objectionCount, 0);
  assert.match(next.reply, /nome completo/);
});

test('loyalty claims from model or configured text are replaced', () => {
  const result = enforceLoyaltyGuidance('O plano é sem fidelidade! Podemos continuar?');
  assert.doesNotMatch(result, /sem fidelidade/);
  assert.match(result, /após o cadastro/);
  assert.match(result, /Podemos continuar/);
  assert.doesNotMatch(enforceLoyaltyGuidance(`${result}\nNão tem fidelidade.`), /Não tem fidelidade/);
});

test('unanswered retry is not discarded because a different message got a response', async () => {
  let saved, locked = false, sent = 0;
  const repository = {
    async withInboundLock(phone, work) { locked = true; return work(); },
    async findMessageByProviderId() { assert(locked); return { conversationId: 'c1', createdAt: new Date() }; },
    async hasResponseToProviderId(id, providerId) { assert.equal(providerId, 'in-1'); return false; },
    async hasOutboundResponseAfter() { throw new Error('Timestamp matching must not be used'); },
    async getAgentByInstance() { return null; },
    async findOrCreateConversation() { return { id: 'c1', state: 'ASK_NAME', memory: {}, messages: [], ownerUserId: null }; },
    async saveBotReply(input) { saved = input; },
  };
  const engine = new ChatbotEngineService({}, repository, { async markAsRead() {}, async sendText() { sent++; } }, {});
  engine.nextResponse = async () => ({ state: 'ASK_DOCUMENT', memory: { name: 'Ana Souza' }, reply: 'Informe o CPF.' });
  await engine.processIncomingMessage({ phone: '5511000000000', message: 'Ana Souza', providerId: 'in-1' });
  assert.equal(sent, 1);
  assert.equal(saved.responseToProviderId, 'in-1');
  assert.equal(saved.state, 'ASK_DOCUMENT');
});

test('already answered provider ID is ignored without generating a new response', async () => {
  const engine = new ChatbotEngineService({}, {
    async withInboundLock(phone, work) { return work(); },
    async findMessageByProviderId() { return { conversationId: 'c1' }; },
    async hasResponseToProviderId() { return true; },
  }, {}, {});
  assert.equal((await engine.processIncomingMessage({ phone: '5511000000000', message: 'Ana', providerId: 'in-1' })).replied, false);
});
