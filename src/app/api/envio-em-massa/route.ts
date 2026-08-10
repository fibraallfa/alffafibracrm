import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { assertPermission } from "@/lib/permissions";
import { permissions } from "@/constants/permissions";
import { MassMessageService } from "@/modules/envio-em-massa/services/mass-message.service";

const massMessageService = new MassMessageService();

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    assertPermission(user, permissions.agentsEdit);

    const formData = await request.formData();
    const file = formData.get("file");
    const media =
      file instanceof File
        ? {
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            dataUrl: `data:${file.type || "application/octet-stream"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`,
          }
        : undefined;

    const result = await massMessageService.send({
      contactsText: String(formData.get("contacts") ?? ""),
      message: formData.get("message") ? String(formData.get("message")) : undefined,
      caption: formData.get("caption") ? String(formData.get("caption")) : undefined,
      media,
    });

    return NextResponse.json(successResponse("Disparo em massa concluído.", result));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;

    return NextResponse.json(
      errorResponse(error instanceof Error ? error.message : "Não foi possível concluir o envio em massa."),
      { status: 500 },
    );
  }
}
