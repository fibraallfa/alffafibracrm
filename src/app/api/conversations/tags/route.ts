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
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag: unknown) =>
          typeof tag === "string"
            ? { label: tag, color: "sky" }
            : {
                label: String((tag as { label?: unknown })?.label ?? ""),
                color: String((tag as { color?: unknown })?.color ?? "sky"),
              },
        )
      : [];
    const detail = await conversationService.updateTags(String(body.conversationId ?? ""), tags, user);

    return NextResponse.json(successResponse("Etiquetas atualizadas.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel atualizar as etiquetas."), {
      status: 500,
    });
  }
}
