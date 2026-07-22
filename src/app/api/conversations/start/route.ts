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
    const detail = await conversationService.startConversation({
      phone: String(body.phone ?? ""),
      leadName: body.leadName ? String(body.leadName) : undefined,
      firstMessage: body.firstMessage ? String(body.firstMessage) : undefined,
      ownerUserId: body.ownerUserId ? String(body.ownerUserId) : user.id,
    });

    return NextResponse.json(successResponse("Conversa iniciada.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel iniciar a conversa."), {
      status: 500,
    });
  }
}
