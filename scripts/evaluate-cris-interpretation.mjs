// Uses synthetic messages only. Run explicitly; never part of build or unit tests.
import { OpenAiService } from '../src/services/openai/openai.service.ts';

process.loadEnvFile('.env');
const models = process.argv.slice(2);
if (!models.length) throw new Error('Informe os modelos a comparar.');
const cases = [
  ['ASK_NAME', 'quero uma internet mais barata', 'objection', null],
  ['ASK_NAME', 'Meu nome é Rosângela Benedita Quirino do Nascimento', 'answer', 'Rosângela Benedita Quirino do Nascimento'],
  ['ASK_NAME', 'Sou João da Silva, tem fidelidade?', 'answer', 'João da Silva'],
  ['ASK_NAME', 'Data de nascimento', 'unclear', null],
  ['ASK_NAME', 'Não esse endereço', 'correction', null],
  ['ASK_DOCUMENT', 'Só um instante', 'wait', null],
  ['ASK_STREET_NUMBER', 'Essa internet de 500 mega serve para trabalhar?', 'question', null],
  ['ASK_COMPLEMENT', 'Não tenho interesse em contratar', 'decline', null],
  ['ASK_BILLING_DUE_DAY', 'Quando seria o primeiro pagamento?', 'question', null],
  ['ASK_COMPLEMENT', 'Apartamento 23 bloco B', 'answer', 'Apartamento 23 bloco B'],
  ['CHOOSE_PLAN', 'Super combo', 'answer', 'Super combo'],
  ['CONFIRM_DATA', 'Sim, mas quanto custa cancelar?', 'question', null],
];
for (const model of models) {
  process.env.OPENAI_INTERPRETATION_MODEL = model;
  const service = new OpenAiService(async () => ({ apiKey: process.env.OPENAI_API_KEY ?? '', model }));
  let passed = 0;
  let unavailable = 0;
  const started = Date.now();
  for (const [state, message, intent, value] of cases) {
    const result = await service.interpretFlowMessage({ state, message, context: 'Nome nao informado. Etapa pendente conforme state. O cliente viu a lista de planos.' });
    if (!result) {
      unavailable++;
      console.log(JSON.stringify({ model, state, available: false }));
      // Avoid repeating failed requests (revoked key, permissions, network, etc.).
      break;
    }
    const ok = result.intent === intent && result.value === value;
    passed += Number(ok);
    console.log(JSON.stringify({ model, state, message, result, ok }));
  }
  console.log(JSON.stringify({ model, passed, total: cases.length, unavailable, elapsedMs: Date.now() - started }));
}
