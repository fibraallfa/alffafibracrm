import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export async function DELETE(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { conversationId } = await context.params;
    const result = await conversationService.deleteConversation(conversationId, user);

    return NextResponse.json(successResponse("Conversa excluída.", result));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel excluir a conversa."), {
      status: 500,
    });
  }
}
