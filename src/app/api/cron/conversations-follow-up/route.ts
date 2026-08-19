import { NextResponse } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

function readSecret(request: Request) {
  const urlSecret = new URL(request.url).searchParams.get("secret") ?? undefined;
  const headerSecret = request.headers.get("x-cron-secret") ?? undefined;
  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || undefined;
  return headerSecret || bearerToken || urlSecret;
}

export async function GET(request: Request) {
  try {
    const secret = readSecret(request);
    const result = await conversationService.processAutoFollowUps(secret);
    return NextResponse.json(successResponse("Lembretes automáticos processados.", result));
  } catch (error) {
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Não foi possível processar os lembretes."), {
      status: 500,
    });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
