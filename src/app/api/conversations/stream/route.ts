import { authErrorResponse } from "@/lib/api-errors";
import { requireCurrentUser } from "@/lib/auth-context";
import { createConversationListener, getConversationChannelName } from "@/server/realtime/conversation-events";

import { openConversationStream } from "@/server/realtime/conversation-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // EventSource stops reconnecting on 204; the UI uses its polling fallback.
    // LISTEN would reserve one PostgreSQL session per open browser tab.
    if (process.env.VERCEL) return new Response(null, { status: 204 });
    await requireCurrentUser();

    const stream = await openConversationStream(
      createConversationListener(), getConversationChannelName(), request.signal,
    );

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
    return new Response("Atualizações temporariamente indisponíveis.", { status: 503 });
  }
}
