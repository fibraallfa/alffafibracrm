import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");
    const offset = Number(searchParams.get("offset") ?? "0");
    const limit = Number(searchParams.get("limit") ?? "25");

    if (conversationId) {
      const conversation = await conversationService.getDetail(conversationId, user);
      return NextResponse.json(successResponse("Conversa consultada.", conversation));
    }

    const [conversations, users] = await Promise.all([
      conversationService.list({
        offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25,
        user,
      }),
      conversationService.listAssignableUsers(),
    ]);

    return NextResponse.json(successResponse("Conversas consultadas.", { conversations, users }));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse("Nao foi possivel consultar as conversas."), {
      status: 500,
    });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = await request.json();
    const detail = await conversationService.sendManualMessage({
      conversationId: String(body.conversationId ?? ""),
      content: String(body.content ?? "").trim(),
      user,
    });

    return NextResponse.json(successResponse("Mensagem enviada.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel enviar a mensagem."), {
      status: 500,
    });
  }
}
