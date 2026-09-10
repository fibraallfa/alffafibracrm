import { Client } from "pg";

// Transaction-scoped lock also works through transaction poolers. Separate callers
// cannot read and overwrite the same conversation state while a reply is generated.
export async function withInboundLock<T>(phone: string, work: () => Promise<T>): Promise<T> {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
    ssl: connectionString?.startsWith("postgres") ? { rejectUnauthorized: false } : undefined });
  let connectionError: Error | null = null;
  client.on("error", (error) => { connectionError = error; });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`cris:${phone}`]);
    const result = await work();
    if (connectionError) throw connectionError;
    await client.query("COMMIT");
    return result;
  } finally {
    // Closing the connection rolls back on failure and releases the lock.
    await client.end().catch(() => {});
  }
}
