import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEngineService } from '../src/modules/chatbot/services/chatbot-engine.service.ts';
import { validateFlowInterpretation } from '../src/services/openai/openai.service.ts';

const states = ['ASK_CEP', 'ASK_NAME', 'ASK_DOCUMENT', 'ASK_BIRTH_DATE', 'ASK_STREET_NUMBER', 'ASK_COMPLEMENT', 'ASK_BILLING_DUE_DAY', 'ASK_EMAIL', 'RECOMMEND_PLAN', 'CHOOSE_PLAN', 'CONFIRM_DATA', 'CORRECTION'];
function setup(interpretation) {
  const calls = [];
  const ai = {
    async interpretFlowMessage(input) { calls.push(input); return interpretation; },
    async answerCommercialQuestion(prompt) { calls.push(prompt); return 'Vamos esclarecer sua dúvida.'; },
    async extractLikelyFullName() { return ''; },
  };
  const repository = { async listActivePlans() { return []; } };
  const engine = new ChatbotEngineService({}, repository, {}, ai);
  engine.getPlans = async () => [];
  return { engine, calls };
}
const input = (state, message, memory = {}) => ({ phone: '5511999999999', state, message, memory, agent: null });

for (const message of ['28943412', '28943-412']) {
  test(`standalone CEP ${message} reaches coverage even when AI is unavailable`, async () => {
    const engine = new ChatbotEngineService({}, {}, {}, {
      async interpretFlowMessage() { throw new Error('Standalone CEP must not require AI'); },
    });
    let lookup;
    engine.handleCepStep = async (value) => { lookup = value; return { state: 'ASK_NAME', memory: { ...value.memory, cep: value.cep }, reply: 'Qual é o seu nome completo?' }; };
    const result = await engine.nextResponse(input('ASK_CEP', message, { salesPaused: true, followUpPaused: true }));
    assert.equal(lookup.cep, '28943412');
    assert.equal(result.state, 'ASK_NAME');
    assert.equal(result.memory.salesPaused, false);
  });
}

for (const message of ['Tem cobertura no CEP 28943412?', '2894341', '289434123', 'Não use 28943412']) {
  test(`ambiguous or incomplete CEP still requires interpretation: ${message}`, async () => {
    const { engine, calls } = setup(null);
    const result = await engine.nextResponse(input('ASK_CEP', message));
    assert.equal(result.state, 'ASK_CEP');
    assert.equal(result.memory.cep, undefined);
    assert.equal(calls.length, 1);
  });
}

for (const state of states) {
  test(`question never advances or writes customer fields in ${state}`, async () => {
    const { engine } = setup({ intent: 'question', value: null, question: null });
    const memory = { name: 'Maria da Silva', cep: '09340450', billingDueDay: 15 };
    const next = await engine.nextResponse(input(state, 'Essa internet de 500 mega serve para trabalhar?', memory));
    assert.equal(next.state, state);
    for (const [key, value] of Object.entries(memory)) assert.equal(next.memory[key], value);
    assert.equal(next.memory.streetNumber, undefined);
    assert.equal(next.memory.complement, undefined);
  });
  test(`interpreter unavailable preserves ${state}`, async () => {
    const { engine } = setup(null);
    const next = await engine.nextResponse(input(state, 'Qualquer Palavra'));
    assert.equal(next.state, state);
    assert.equal(next.memory.name, undefined);
  });
}

test('price objection does not become a name and stays in context', async () => {
  const { engine, calls } = setup({ intent: 'objection', value: null, question: null });
  const next = await engine.nextResponse({ ...input('ASK_NAME', 'quero uma internet mais barata'), history: [{ role: 'Cris', text: 'Qual é o seu nome completo?' }] });
  assert.equal(next.state, 'ASK_NAME');
  assert.equal(next.memory.name, undefined);
  assert.deepEqual(next.memory.customerRemarks, ['quero uma internet mais barata']);
  assert.match(calls[0].context, /Qual é o seu nome completo/);
  assert.equal(next.memory.objectionCount, 1);
  assert.match(next.reply, /valor, o plano/);
});

test('even a classifier mistake cannot save a product phrase as a name', async () => {
  const { engine } = setup({ intent: 'answer', value: 'quero uma internet mais barata', question: null });
  const next = await engine.nextResponse(input('ASK_NAME', 'quero uma internet mais barata'));
  assert.equal(next.state, 'ASK_NAME');
  assert.equal(next.memory.name, undefined);
});

for (const message of ['O consultor cobra pela instalação?', 'Não quero reiniciar']) {
  test(`mentions of commands do not execute them: ${message}`, async () => {
    const { engine } = setup({ intent: 'question', value: null, question: null });
    const next = await engine.nextResponse(input('ASK_NAME', message, { cep: '09340450' }));
    assert.equal(next.state, 'ASK_NAME');
    assert.equal(next.memory.cep, '09340450');
    assert.equal(next.memory.handoff, undefined);
  });
}

test('valid name keeps the existing flow text', async () => {
  const { engine } = setup({ intent: 'answer', value: 'João Pedro da Silva', question: null });
  const next = await engine.nextResponse(input('ASK_NAME', 'Meu nome é João Pedro da Silva'));
  assert.equal(next.state, 'ASK_DOCUMENT');
  assert.match(next.memory.name, /^João Pedro/);
  assert.equal(next.reply, 'Ótimo, João! 😊 Agora, por favor, me informe o seu CPF ou CNPJ.');
});

test('name and question are both handled', async () => {
  const { engine } = setup({ intent: 'answer', value: 'João da Silva', question: 'tem fidelidade?' });
  const next = await engine.nextResponse(input('ASK_NAME', 'Sou João da Silva, tem fidelidade?'));
  assert.equal(next.state, 'ASK_DOCUMENT');
  assert.match(next.reply, /fidelidade.*após o cadastro/);
  assert.match(next.reply, /CPF ou CNPJ/);
  assert.equal(next.memory.name.includes('fidelidade'), false);
});

test('Nascimento is accepted as a surname, not confused with a field label', async () => {
  const value = 'Rosângela Benedita Quirino do Nascimento';
  const { engine } = setup({ intent: 'answer', value, question: null });
  const next = await engine.nextResponse(input('ASK_NAME', `Meu nome é ${value}`));
  assert.equal(next.state, 'ASK_DOCUMENT');
  assert.match(next.memory.name, /Nascimento$/);
});

test('invalid correction does not get confirmed', async () => {
  const { engine } = setup({ intent: 'answer', value: 'email errado', question: null });
  const next = await engine.nextResponse(input('CORRECTION', 'email errado', { email: 'teste@example.com' }));
  assert.equal(next.state, 'CORRECTION');
  assert.equal(next.memory.email, 'teste@example.com');
});

test('correction resumes the pending stage instead of confirming an unfinished order', async () => {
  const { engine } = setup({ intent: 'answer', value: 'email novo@example.com', question: null });
  const next = await engine.nextResponse(input('CORRECTION', 'email novo@example.com', { correctionResumeState: 'CHOOSE_PLAN' }));
  assert.equal(next.state, 'CHOOSE_PLAN');
  assert.equal(next.memory.email, 'novo@example.com');
  assert.equal(next.memory.correctionResumeState, undefined);
});

test('numeric answer still uses billing validation', async () => {
  const { engine } = setup({ intent: 'answer', value: '31', question: null });
  const next = await engine.nextResponse(input('ASK_BILLING_DUE_DAY', '31'));
  assert.equal(next.state, 'ASK_BILLING_DUE_DAY');
  assert.equal(next.memory.billingDueDay, undefined);
});

test('billing question recalls the chosen day', async () => {
  const { engine } = setup({ intent: 'question', value: null, question: null });
  const next = await engine.nextResponse(input('CHOOSE_PLAN', 'Quando seria o primeiro pagamento?', { billingDueDay: 15 }));
  assert.equal(next.state, 'CHOOSE_PLAN');
  assert.match(next.reply, /dia 15/);
});

for (const intent of ['wait', 'decline']) {
  test(`${intent} preserves stage and pauses follow-ups`, async () => {
    const { engine } = setup({ intent, value: null, question: null });
    const next = await engine.nextResponse(input('ASK_DOCUMENT', 'Só um instante', { name: 'João da Silva' }));
    assert.equal(next.state, 'ASK_DOCUMENT');
    assert.equal(next.memory.followUpPaused, true);
    assert.equal(next.memory.name, 'João da Silva');
  });
}

test('untrusted structured output cannot fabricate customer data', () => {
  assert.equal(validateFlowInterpretation({ intent: 'answer', value: 'João da Silva', question: null }, 'quero uma internet'), null);
  assert.equal(validateFlowInterpretation({ intent: 'question', value: '500', question: null }, 'tem 500?'), null);
  assert.equal(validateFlowInterpretation({ intent: 'answer', value: 'Maria Silva', question: 'inventada' }, 'Maria Silva'), null);
  assert.equal(validateFlowInterpretation('bad JSON', 'Maria Silva'), null);
  assert.deepEqual(validateFlowInterpretation({ intent: 'answer', value: 'Maria Silva', question: null }, 'Sou Maria Silva'), { intent: 'answer', value: 'Maria Silva', question: null });
});
