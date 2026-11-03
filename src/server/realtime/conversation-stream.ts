import type { Client } from "pg";

type StreamClient = Pick<Client, "connect" | "query" | "on" | "off" | "end">;

// Own the listener from connection setup through stream cancellation, including
// failures before a Response exists (otherwise EventSource retries leak clients).
export async function openConversationStream(client: StreamClient, channel: string, signal: AbortSignal) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let ending: Promise<void> | undefined;

  function close(error?: Error) {
    if (closed) return ending;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    signal.removeEventListener("abort", onAbort);
    client.off("notification", onNotification);
    // Keep the error handler installed until end() finishes: pg can emit an
    // error while an in-progress connection or query is being cancelled.
    ending = client.end().catch(() => {}).finally(() => client.off("error", onError));
    if (controller) {
      if (error) controller.error(error);
      else controller.close();
    }
    return ending;
  }

  function send(event: string, data: unknown) {
    if (closed || !controller) return;
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }
  function onAbort() { void close(); }
  function onError(error: Error) { void close(error); }
  function onNotification(message: { channel?: string; payload?: string }) {
    if (message.channel !== channel || !message.payload) return;
    let payload: unknown;
    try { payload = JSON.parse(message.payload); }
    catch { return; }
    send("conversation-update", payload);
  }

  client.on("error", onError);
  client.on("notification", onNotification);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error("Conexão cancelada.");
    await client.connect();
    if (closed) throw new Error("Conexão cancelada.");
    await client.query(`LISTEN ${channel}`);
    if (closed) throw new Error("Conexão cancelada.");
    return new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        keepAlive = setInterval(() => send("keepalive", { at: new Date().toISOString() }), 15000);
        send("connected", { at: new Date().toISOString() });
      },
      cancel() {
        // The consumer has already cancelled the stream; do not close it twice.
        controller = undefined;
        return close();
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
