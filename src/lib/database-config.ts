/** Keep the configured database identity; only tune serverless pool parameters. */
export function runtimeDatabaseUrl(value: string | undefined, serverless: boolean) {
  if (!value || !serverless) return value;
  const url = new URL(value);
  url.searchParams.set("connection_limit", "1");
  if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "10");
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "10");
  if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543") {
    url.searchParams.set("pgbouncer", "true");
  }
  return url.toString();
}

export function databaseProjectRef(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname.endsWith(".pooler.supabase.com")) {
      const ref = decodeURIComponent(url.username).split(".").slice(1).join(".");
      return /^[a-z0-9]{20}$/.test(ref) ? ref : null;
    }
    const match = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
    return match?.[1] ?? null;
  } catch { return null; }
}
