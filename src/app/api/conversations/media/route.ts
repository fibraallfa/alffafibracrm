import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(errorResponse("Arquivo não enviado."), { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const dataUrl = `data:${file.type || "application/octet-stream"};base64,${buffer.toString("base64")}`;
    const detail = await conversationService.sendManualMedia({
      conversationId: String(formData.get("conversationId") ?? ""),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      dataUrl,
      caption: formData.get("caption") ? String(formData.get("caption")) : undefined,
      user,
    });

    return NextResponse.json(successResponse("Arquivo enviado.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel enviar o arquivo."), {
      status: 500,
    });
  }
}
