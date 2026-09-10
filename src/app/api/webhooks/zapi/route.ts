import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { errorResponse, successResponse } from "@/lib/api-response";
import { writeTechnicalLog } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatbotEngineService } from "@/modules/chatbot/services/chatbot-engine.service";
import { OpenAiService, type ExtractedCustomerData } from "@/services/openai/openai.service";

const chatbotEngineService = new ChatbotEngineService();
const openAiService = new OpenAiService();
export const maxDuration = 120;

type ZapiWebhookPayload = {
  instanceId?: string;
  phone?: string;
  sender?: string;
  from?: string;
  data?: ZapiWebhookPayload;
  messageData?: ZapiWebhookPayload;
  fromMe?: boolean;
  isGroup?: boolean;
  messageId?: string;
  id?: string;
  callId?: string;
  notification?: string;
  body?: string;
  message?: {
    text?: string;
    body?: string;
    conversation?: string;
    content?: string;
    extendedTextMessage?: {
      text?: string;
      body?: string;
      selectedDisplayText?: string;
    };
  };
  text?: {
    message?: string;
    body?: string;
    content?: string;
  };
  extendedTextMessage?: {
    text?: string;
    body?: string;
    selectedDisplayText?: string;
  };
  buttonsResponseMessage?: {
    message?: string;
    buttonText?: { displayText?: string };
    selectedButtonId?: string;
  };
  listResponseMessage?: {
    message?: string;
    title?: string;
    description?: string;
    selectedRowId?: string;
  };
  buttonText?: {
    displayText?: string;
  };
  reaction?: {
    text?: string;
    emoji?: string;
  };
  contact?: {
    displayName?: string;
  };
  image?: { mimeType?: string; imageUrl?: string; caption?: string; downloadError?: string | null };
  document?: { documentUrl?: string; mimeType?: string; fileName?: string; pageCount?: number };
  audio?: { audioUrl?: string; mimeType?: string; seconds?: number; ptt?: boolean; viewOnce?: boolean };
  location?: { longitude?: number; latitude?: number; address?: string; url?: string };
};

export async function POST(request: Request) {
  const debugRequested = request.headers.get("x-cris-debug") === "1";
  try {
    const rawPayload = (await request.json()) as ZapiWebhookPayload;
    const payload = unwrapWebhookPayload(rawPayload);
    if (payload.fromMe || payload.isGroup) {
      return NextResponse.json(successResponse("Mensagem propria ignorada.", { ignored: true }));
    }
    // Provider IPs are shared by many customers; one busy contact must not block others.
    const senderKey = String(payload.phone ?? payload.sender ?? payload.from ?? "unknown").replace(/\D/g, "");
    const rateLimit = checkRateLimit(`zapi:${payload.instanceId ?? "default"}:${senderKey}`, 120, 60_000);

    if (!rateLimit.allowed) {
      return NextResponse.json(errorResponse("Limite de webhooks excedido.", "RATE_LIMITED"), {
        status: 429,
      });
    }

    const phone = payload.phone ?? payload.sender ?? payload.from;
    const providerId = payload.messageId ?? payload.id;

    if (phone && isIncomingCallNotification(payload.notification)) {
      const result = await chatbotEngineService.handleIncomingCall({
        phone,
        providerId: payload.callId ?? providerId,
        rawPayload: rawPayload as Prisma.InputJsonValue,
        instanceId: payload.instanceId,
      });
      return NextResponse.json(successResponse("Ligação recusada e fluxo retomado.", result));
    }

    const incoming = await extractIncomingMessage(payload);

    if (!phone || !incoming.message) {
      return NextResponse.json(errorResponse("Payload invalido.", "INVALID_WEBHOOK"), {
        status: 400,
      });
    }

    const result = await chatbotEngineService.processIncomingMessage({
      phone,
      message: incoming.message,
      providerId,
      rawPayload: rawPayload as Prisma.InputJsonValue,
      instanceId: payload.instanceId,
      extractedData: incoming.extractedData,
    });

    return NextResponse.json(successResponse("Webhook processado.", result));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown";
    await writeTechnicalLog({
      level: "ERROR",
      category: "webhook",
      message: "Falha ao processar webhook da Z-API.",
      method: "POST",
      endpoint: "/api/webhooks/zapi",
      integration: "zapi",
      metadata: {
        error: errorMessage,
      },
    });
    const response = errorResponse("Nao foi possivel processar o webhook.");
    if (debugRequested) {
      return NextResponse.json({
        ...response,
        details: errorMessage,
      }, { status: 500 });
    }
    return NextResponse.json(response, { status: 500 });
  }
}

function isIncomingCallNotification(notification?: string) {
  return ["CALL_RECEIVED", "CALL_VOICE", "CALL_MISSED", "CALL_MISSED_VOICE", "CALL_MISSED_VIDEO"]
    .includes(notification ?? "");
}

function unwrapWebhookPayload(payload: ZapiWebhookPayload) {
  if (payload.data && typeof payload.data === "object") {
    return { ...payload, ...payload.data };
  }

  if (payload.messageData && typeof payload.messageData === "object") {
    return { ...payload, ...payload.messageData };
  }

  return payload;
}

async function extractIncomingMessage(payload: ZapiWebhookPayload) {
  const text = (
    payload.text?.message ??
    payload.text?.body ??
    payload.text?.content ??
    payload.message?.text ??
    payload.message?.body ??
    payload.message?.conversation ??
    payload.message?.content ??
    payload.message?.extendedTextMessage?.text ??
    payload.message?.extendedTextMessage?.body ??
    payload.message?.extendedTextMessage?.selectedDisplayText ??
    payload.extendedTextMessage?.text ??
    payload.extendedTextMessage?.body ??
    payload.extendedTextMessage?.selectedDisplayText ??
    payload.buttonsResponseMessage?.message ??
    payload.buttonsResponseMessage?.buttonText?.displayText ??
    payload.buttonsResponseMessage?.selectedButtonId ??
    payload.listResponseMessage?.message ??
    payload.listResponseMessage?.title ??
    payload.listResponseMessage?.description ??
    payload.listResponseMessage?.selectedRowId ??
    payload.buttonText?.displayText ??
    payload.reaction?.text ??
    payload.reaction?.emoji ??
    payload.contact?.displayName ??
    findNestedMessageText(payload.message) ??
    findNestedMessageText(payload.text) ??
    findNestedMessageText(payload.buttonsResponseMessage) ??
    findNestedMessageText(payload.listResponseMessage) ??
    payload.body ??
    ""
  ).trim();
  if (text) return { message: text };

  if (payload.audio?.audioUrl) {
    try {
      const transcription = await openAiService.transcribeAudio({
        url: payload.audio.audioUrl,
        mimeType: payload.audio.mimeType ?? "audio/ogg",
      });
      if (transcription) return { message: transcription };
    } catch {
      // The flow below keeps the current step and asks the customer to resend.
    }
    return { message: "[Áudio não pôde ser transcrito]", extractedData: {} };
  }

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

function findNestedMessageText(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 3) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findNestedMessageText(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "message",
    "body",
    "text",
    "content",
    "conversation",
    "selectedDisplayText",
    "displayText",
    "title",
    "description",
    "selectedRowId",
    "selectedButtonId",
    "emoji",
  ];

  for (const key of preferredKeys) {
    const nested = findNestedMessageText(record[key], depth + 1);
    if (nested) return nested;
  }

  return undefined;
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
