import { authErrorResponse } from "@/lib/api-errors";
import { requireCurrentUser } from "@/lib/auth-context";
import { createConversationListener, getConversationChannelName } from "@/server/realtime/conversation-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireCurrentUser();

    const client = createConversationListener();
    const channel = getConversationChannelName();
    const encoder = new TextEncoder();

    await client.connect();
    await client.query(`LISTEN ${channel}`);

    let keepAlive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        const onNotification = (message: { channel?: string; payload?: string }) => {
          if (message.channel !== channel || !message.payload) return;

          try {
            send("conversation-update", JSON.parse(message.payload));
          } catch {
            send("conversation-update", { raw: message.payload });
          }
        };

        client.on("notification", onNotification);
        keepAlive = setInterval(() => {
          send("keepalive", { at: new Date().toISOString() });
        }, 15000);
        send("connected", { at: new Date().toISOString() });

        request.signal.addEventListener("abort", () => {
          client.off("notification", onNotification);
          if (keepAlive) clearInterval(keepAlive);
          void client.end();
          controller.close();
        }, { once: true });
      },
      async cancel() {
        if (keepAlive) clearInterval(keepAlive);
        await client.end();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return new Response("Não autorizado.", { status: 401 });
  }
}
