import { NextResponse } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export async function GET(request: Request) {
  try {
    const secret = new URL(request.url).searchParams.get("secret") ?? undefined;
    const result = await conversationService.processAutoFollowUps(secret);
    return NextResponse.json(successResponse("Lembretes automáticos processados.", result));
  } catch (error) {
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Não foi possível processar os lembretes."), {
      status: 500,
    });
  }
}
