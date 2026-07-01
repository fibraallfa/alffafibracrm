import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { errorResponse, successResponse } from "@/lib/api-response";
import { writeTechnicalLog } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatbotEngineService } from "@/modules/chatbot/services/chatbot-engine.service";

const chatbotEngineService = new ChatbotEngineService();

type ZapiWebhookPayload = {
  instanceId?: string;
  phone?: string;
  sender?: string;
  from?: string;
  fromMe?: boolean;
  messageId?: string;
  id?: string;
  body?: string;
  message?: {
    text?: string;
    body?: string;
  };
  text?: {
    message?: string;
    body?: string;
  };
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ZapiWebhookPayload;
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
    const rateLimit = checkRateLimit(`zapi:${ip}`, 120, 60_000);

    if (!rateLimit.allowed) {
      return NextResponse.json(errorResponse("Limite de webhooks excedido.", "RATE_LIMITED"), {
        status: 429,
      });
    }

    if (payload.fromMe) {
      return NextResponse.json(successResponse("Mensagem propria ignorada.", { ignored: true }));
    }

    const phone = payload.phone ?? payload.sender ?? payload.from;
    const message = extractMessage(payload);
    const providerId = payload.messageId ?? payload.id;

    if (!phone || !message) {
      return NextResponse.json(errorResponse("Payload invalido.", "INVALID_WEBHOOK"), {
        status: 400,
      });
    }

    const result = await chatbotEngineService.processIncomingMessage({
      phone,
      message,
      providerId,
      rawPayload: payload as Prisma.InputJsonValue,
      instanceId: payload.instanceId,
    });

    return NextResponse.json(successResponse("Webhook processado.", result));
  } catch (error) {
    await writeTechnicalLog({
      level: "ERROR",
      category: "webhook",
      message: "Falha ao processar webhook da Z-API.",
      method: "POST",
      endpoint: "/api/webhooks/zapi",
      integration: "zapi",
      metadata: {
        error: error instanceof Error ? error.message : "unknown",
      },
    });
    return NextResponse.json(errorResponse("Nao foi possivel processar o webhook."), {
      status: 500,
    });
  }
}

function extractMessage(payload: ZapiWebhookPayload) {
  return (
    payload.text?.message ??
    payload.text?.body ??
    payload.message?.text ??
    payload.message?.body ??
    payload.body ??
    ""
  ).trim();
}
