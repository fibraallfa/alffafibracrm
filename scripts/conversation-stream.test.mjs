import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/server/realtime/conversation-stream.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { openConversationStream } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
class Listener extends EventEmitter {
  ends = 0;
  async connect() {}
  async query() {}
  async end() { this.ends++; }
}

test('LISTEN failure releases the database connection before rejecting', async () => {
  const client = new Listener();
  client.query = async () => { throw new Error('database unavailable'); };
  await assert.rejects(openConversationStream(client, 'updates', new AbortController().signal), /database unavailable/);
  assert.equal(client.ends, 1);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('error'), 0);
});

test('connection failure also closes the client', async () => {
  const client = new Listener();
  client.connect = async () => { throw new Error('connection timeout'); };
  await assert.rejects(openConversationStream(client, 'updates', new AbortController().signal), /connection timeout/);
  assert.equal(client.ends, 1);
});

test('aborting during connection setup never starts LISTEN', async () => {
  const client = new Listener();
  let connected;
  client.connect = () => new Promise(resolve => { connected = resolve; });
  client.query = () => { throw new Error('LISTEN should not start'); };
  const abort = new AbortController();
  const opening = openConversationStream(client, 'updates', abort.signal);
  abort.abort();
  connected();
  await assert.rejects(opening, /cancelada/);
  assert.equal(client.ends, 1);
});

test('notifications stream normally; browser cancellation releases the listener once', async () => {
  const client = new Listener();
  const abort = new AbortController();
  const stream = await openConversationStream(client, 'updates', abort.signal);
  const reader = stream.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
  client.emit('notification', { channel: 'updates', payload: '{"id":"event-1"}' });
  assert.match(new TextDecoder().decode((await reader.read()).value), /event-1/);
  await reader.cancel();
  abort.abort();
  assert.equal(client.ends, 1);
  assert.equal(client.listenerCount('notification'), 0);
});

test('database errors terminate the open stream and release its connection', async () => {
  const client = new Listener();
  const stream = await openConversationStream(client, 'updates', new AbortController().signal);
  const reader = stream.getReader();
  await reader.read();
  const pending = reader.read();
  client.emit('error', new Error('connection lost'));
  await assert.rejects(pending, /connection lost/);
  assert.equal(client.ends, 1);
});
