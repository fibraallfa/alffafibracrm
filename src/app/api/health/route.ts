import { NextResponse } from "next/server";
import { successResponse } from "@/lib/api-response";
import { prisma } from "@/lib/prisma";
import { databaseProjectRef } from "@/lib/database-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  const projectRef = databaseProjectRef(process.env.DATABASE_URL);
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(successResponse("Aplicacao operacional.", {
      database: "connected",
      databaseProjectRef: projectRef,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      status: "error", message: "Banco temporariamente indisponível.",
      data: { database: "unavailable", databaseProjectRef: projectRef, durationMs: Date.now() - startedAt },
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
