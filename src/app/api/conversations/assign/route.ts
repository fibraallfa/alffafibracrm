import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = await request.json();
    const detail = await conversationService.assignOwner(
      String(body.conversationId ?? ""),
      body.ownerUserId ? String(body.ownerUserId) : null,
      user,
    );

    return NextResponse.json(successResponse("Responsável atualizado.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel atribuir a conversa."), {
      status: 500,
    });
  }
}
