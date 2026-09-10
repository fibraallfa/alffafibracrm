import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/modules/chatbot/services/conversation.service.ts';

const user = { id: 'employee-test', role: 'EMPLOYEE' };
const date = new Date('2026-09-10T12:00:00Z');
const row = (index, state = 'ASK_NAME', direction = 'outbound', ownerUserId = null) => ({
  id: `conversation-${index}`, state, ownerUserId, updatedAt: date,
  messages: [{ direction, createdAt: date }],
});

test('first page skips full summary scan and preserves user scoping', async () => {
  let page;
  const service = new ConversationService({
    listConversationSummaries() { throw new Error('Full scan must not run'); },
    async countConversations(scope) { assert.deepEqual(scope, user); return 6000; },
    async listConversations(params) { page = params; return []; },
  }, {});
  const result = await service.list({ user, limit: 20, includeSummary: false });
  assert.equal(result.total, 6000);
  assert.equal(result.summary, undefined);
  assert.equal(page.take, 20);
  assert.deepEqual(page.user, user);
});

test('filtered pagination finds matches beyond the former 500-row limit', async () => {
  const rows = Array.from({ length: 650 }, (_, index) => row(index, 'FINISHED_UNAVAILABLE'));
  let page;
  const service = new ConversationService({
    async listConversationSummaries(scope) { assert.deepEqual(scope, user); return rows; },
    async listConversations(params) { page = params; return []; },
  }, {});
  const result = await service.list({ user, filter: 'unavailable', offset: 600, limit: 20, includeSummary: false });
  assert.equal(result.total, 650);
  assert.equal(result.summary.unavailable, 650);
  assert.deepEqual(page.ids, rows.slice(600, 620).map(item => item.id));
  assert.equal(page.take, 20);
  assert.deepEqual(page.user, user);
});

test('summary excludes completed, unavailable, owned and customer-last conversations from stalled', async () => {
  const service = new ConversationService({
    async listConversationSummaries() { return [row(1), row(2, 'FINISHED'), row(3, 'FINISHED_UNAVAILABLE'), row(4, 'ASK_NAME', 'inbound'), row(5, 'ASK_NAME', 'outbound', 'employee-test')]; },
  }, {});
  assert.deepEqual(await service.getSummary(user), { unavailable: 1, finished: 1, stalled: 1 });
});
