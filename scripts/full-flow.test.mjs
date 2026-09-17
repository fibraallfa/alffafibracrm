import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEngineService } from '../src/modules/chatbot/services/chatbot-engine.service.ts';
import { GIOVANA_AGENT_ID, giovanaPlans, GIOVANA_RECOMMENDED_PLAN_ID } from '../src/config/giovana.ts';

for (const name of ['Cris', 'Giovana']) {
  const plans = name === 'Giovana' ? giovanaPlans : [{ id: 'cris-plan', name: 'Plano 500Mb (Wi-Fi) + 60Gb (Celular)', speed: '500Mb', price: 129.9 }];
  const agent = { name, id: name === 'Giovana' ? GIOVANA_AGENT_ID : 'cris', rules: name === 'Giovana' ? { recommendedPlanId: GIOVANA_RECOMMENDED_PLAN_ID } : {}, flow: {} };
  test(`${name}: complete flow preserves data through every stage`, async () => {
    let saved;
    const service = new ChatbotEngineService({}, {
      async listActivePlans() { return plans; },
      async createLeadFromChat(data) { saved = data; return { id: 'test-lead' }; },
    }, {}, { async interpretFlowMessage({ state, message }) {
      assert.equal(state, 'ASK_NAME');
      return { intent: 'answer', value: message, question: null };
    } });
    service.handleCepStep = async ({ cep, memory }) => ({ state: 'ASK_NAME', memory: { ...memory, cep }, reply: 'Nome completo?' });
    let current = { state: 'START', memory: {} };
    const steps = [['oi', 'ASK_CEP'], ['09340450', 'ASK_NAME'], ['Ana Maria Souza', 'ASK_DOCUMENT'],
      ['52998224725', 'ASK_BIRTH_DATE'], ['23/04/1980', 'ASK_STREET_NUMBER'], ['363', 'ASK_COMPLEMENT'],
      ['não', 'ASK_BILLING_DUE_DAY'], ['5', 'ASK_EMAIL'], ['ana@example.com', 'RECOMMEND_PLAN'], ['sim', 'CONFIRM_DATA'], ['Ok', 'FINISHED']];
    for (const [message, expected] of steps) {
      current = await service.nextResponse({ ...current, agent, phone: '5511000000000', message });
      assert.equal(current.state, expected, message);
    }
    assert.equal(saved.name, 'Ana Maria Souza');
    assert.equal(saved.cep, '09340450');
    assert.equal(saved.billingDueDay, 5);
    assert.equal(saved.source, name === 'Giovana' ? 'chatbot:giovana' : 'chatbot');
  });

  for (const [state, message] of [['ASK_DOCUMENT', '11111111111'], ['ASK_BIRTH_DATE', '31/02/1980'], ['ASK_BILLING_DUE_DAY', '31']]) {
    test(`${name}: invalid ${state} stays pending without AI`, async () => {
      const service = new ChatbotEngineService({}, {}, {}, {});
      const result = await service.nextResponse({ state, message, memory: {}, agent, phone: '5511000000000' });
      assert.equal(result.state, state);
    });
  }
  for (const state of ['ASK_NAME', 'CORRECTION']) {
    test(`${name}: AI outage cannot accept arbitrary text in ${state}`, async () => {
      const service = new ChatbotEngineService({}, {}, {}, { async interpretFlowMessage() { return null; } });
      const result = await service.nextResponse({ state, message: 'quero uma internet mais barata', memory: {}, agent, phone: '5511000000000' });
      assert.equal(result.state, state);
      assert.equal(result.memory.name, undefined);
    });
  }
}
