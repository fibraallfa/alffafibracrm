import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { errorResponse, successResponse } from "@/lib/api-response";
import { writeTechnicalLog } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatbotEngineService } from "@/modules/chatbot/services/chatbot-engine.service";
import { OpenAiService, type ExtractedCustomerData } from "@/services/openai/openai.service";

const chatbotEngineService = new ChatbotEngineService();
const openAiService = new OpenAiService();

type ZapiWebhookPayload = {
  instanceId?: string;
  phone?: string;
  sender?: string;
  from?: string;
  fromMe?: boolean;
  isGroup?: boolean;
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
  image?: { mimeType?: string; imageUrl?: string; caption?: string; downloadError?: string | null };
  document?: { documentUrl?: string; mimeType?: string; fileName?: string; pageCount?: number };
  location?: { longitude?: number; latitude?: number; address?: string; url?: string };
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

    if (payload.fromMe || payload.isGroup) {
      return NextResponse.json(successResponse("Mensagem propria ignorada.", { ignored: true }));
    }

    const phone = payload.phone ?? payload.sender ?? payload.from;
    const incoming = await extractIncomingMessage(payload);
    const providerId = payload.messageId ?? payload.id;

    if (!phone || !incoming.message) {
      return NextResponse.json(errorResponse("Payload invalido.", "INVALID_WEBHOOK"), {
        status: 400,
      });
    }

    const result = await chatbotEngineService.processIncomingMessage({
      phone,
      message: incoming.message,
      providerId,
      rawPayload: payload as Prisma.InputJsonValue,
      instanceId: payload.instanceId,
      extractedData: incoming.extractedData,
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

async function extractIncomingMessage(payload: ZapiWebhookPayload) {
  const text = (
    payload.text?.message ??
    payload.text?.body ??
    payload.message?.text ??
    payload.message?.body ??
    payload.body ??
    ""
  ).trim();
  if (text) return { message: text };

  const media = payload.image?.imageUrl
    ? { url: payload.image.imageUrl, mimeType: payload.image.mimeType ?? "image/jpeg", label: "Imagem" }
    : payload.document?.documentUrl && payload.document.mimeType === "application/pdf"
      ? { url: payload.document.documentUrl, mimeType: payload.document.mimeType, label: "PDF" }
      : null;

  if (media) {
    try {
      const extractedData = await openAiService.extractCustomerData(media);
      return { message: `[${media.label} recebido]`, extractedData };
    } catch {
      return { message: `[${media.label} não pôde ser lido]`, extractedData: {} };
    }
  }

  if (payload.location && Number.isFinite(payload.location.latitude) && Number.isFinite(payload.location.longitude)) {
    const extractedData = await extractLocationData(payload.location);
    return { message: "[Localização recebida]", extractedData };
  }

  return { message: "" };
}

async function extractLocationData(location: NonNullable<ZapiWebhookPayload["location"]>): Promise<ExtractedCustomerData> {
  const addressCep = location.address?.match(/\b\d{5}-?\d{3}\b/)?.[0]?.replace(/\D/g, "");
  if (addressCep) return { cep: addressCep, address: location.address };

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(location.latitude));
    url.searchParams.set("lon", String(location.longitude));
    url.searchParams.set("addressdetails", "1");
    const response = await fetch(url, {
      headers: { "User-Agent": "ALFFA-FIBRA-CRM/1.0 (www.alffafibra.com.br)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return {};
    const data = await response.json() as { display_name?: string; address?: { postcode?: string } };
    return {
      cep: data.address?.postcode?.replace(/\D/g, "").slice(0, 8),
      address: data.display_name,
    };
  } catch {
    return {};
  }
}
