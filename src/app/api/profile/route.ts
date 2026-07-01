import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { prisma } from "@/lib/prisma";

const profileSchema = z.object({
  name: z.string().min(2, "Informe o nome completo."),
  email: z.string().email("Informe um e-mail válido."),
  theme: z.enum(["light", "dark"]),
});

export async function PUT(request: Request) {
  try {
    const user = await requireCurrentUser();
    if (user.role !== "ADMIN") throw new Error("FORBIDDEN");
    const input = profileSchema.parse(await request.json());
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: input.name.trim(), email: input.email.toLowerCase().trim(), theme: input.theme },
      select: { id: true, name: true, email: true, role: true, status: true, permissions: true, avatarUrl: true, theme: true },
    });
    await prisma.auditLog.create({ data: { userId: user.id, action: "UPDATE", module: "profile", description: "Perfil e preferências atualizados." } });
    return NextResponse.json(successResponse("Perfil atualizado.", updated));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    if (error instanceof z.ZodError) return NextResponse.json(errorResponse("Dados inválidos.", "VALIDATION_ERROR", error.flatten()), { status: 422 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json(errorResponse("Este e-mail já está sendo utilizado."), { status: 409 });
    return NextResponse.json(errorResponse("Não foi possível atualizar o perfil."), { status: 500 });
  }
}
