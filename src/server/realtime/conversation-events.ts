import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";

const CONVERSATION_CHANNEL = "chat_conversation_updates";

declare global {
  // eslint-disable-next-line no-var
  var __alffaFibraConversationPool: Pool | undefined;
}

function getConnectionString() {
  return process.env.DIRECT_URL || process.env.DATABASE_URL || "";
}

function getPool() {
  if (!globalThis.__alffaFibraConversationPool) {
    globalThis.__alffaFibraConversationPool = new Pool({
      connectionString: getConnectionString(),
    });
  }

  return globalThis.__alffaFibraConversationPool;
}

export async function publishConversationEvent(payload: Record<string, unknown>) {
  const connectionString = getConnectionString();
  if (!connectionString) return;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_notify($1, $2)", [
      CONVERSATION_CHANNEL,
      JSON.stringify({
        id: randomUUID(),
        at: new Date().toISOString(),
        ...payload,
      }),
    ]);
  } finally {
    client.release();
  }
}

export function createConversationListener() {
  return new Client({
    connectionString: getConnectionString(),
  });
}

export function getConversationChannelName() {
  return CONVERSATION_CHANNEL;
}
