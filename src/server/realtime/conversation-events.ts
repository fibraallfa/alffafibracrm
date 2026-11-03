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
      max: 2,
      idleTimeoutMillis: 10000,
      connectionString: getConnectionString(),
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
    });
  }

  return globalThis.__alffaFibraConversationPool;
}

export async function publishConversationEvent(payload: Record<string, unknown>) {
  // Serverless clients poll; avoid a second database pool for notifications.
  if (process.env.VERCEL) return;
  const connectionString = getConnectionString();
  if (!connectionString) return;

  try {
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
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Failed to publish conversation event", error);
    }
  }
}

export function createConversationListener() {
  return new Client({
    connectionString: getConnectionString(),
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
  });
}

export function getConversationChannelName() {
  return CONVERSATION_CHANNEL;
}

function shouldUseSsl() {
  const connectionString = getConnectionString().toLowerCase();
  return connectionString.startsWith("postgres://") || connectionString.startsWith("postgresql://");
}
