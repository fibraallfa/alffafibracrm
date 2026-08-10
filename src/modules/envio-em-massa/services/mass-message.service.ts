import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { ZapiService } from "@/services/zapi/zapi.service";

type MassMessageInput = {
  contactsText: string;
  message?: string;
  caption?: string;
  media?: {
    fileName: string;
    mimeType: string;
    dataUrl: string;
  };
};

type MassMessageResult = {
  total: number;
  sent: number;
  failed: number;
  contacts: Array<{
    phone: string;
    status: "sent" | "failed";
    detail: string;
  }>;
};

export class MassMessageService {
  constructor(
    private readonly chatbotRepository = new ChatbotRepository(),
    private readonly zapiService = new ZapiService(),
  ) {}

  async send(input: MassMessageInput): Promise<MassMessageResult> {
    const contacts = parseContacts(input.contactsText);
    if (!contacts.length) {
      throw new Error("Informe pelo menos um número de WhatsApp válido.");
    }

    if (!input.message?.trim() && !input.media) {
      throw new Error("Informe uma mensagem ou anexe uma mídia para disparar.");
    }

    const agent = await this.chatbotRepository.getDefaultAgent();
    const config = agentConfig(agent);
    const results: MassMessageResult["contacts"] = [];

    for (const phone of contacts) {
      try {
        if (input.media) {
          await this.sendMedia({
            phone,
            media: input.media,
            caption: input.caption?.trim() || input.message?.trim() || undefined,
            config,
          });
        } else if (input.message?.trim()) {
          await this.zapiService.sendText({
            phone,
            message: input.message.trim(),
            config,
          });
        }

        results.push({
          phone,
          status: "sent",
          detail: input.media ? "Mídia enviada com sucesso." : "Mensagem enviada com sucesso.",
        });
      } catch (error) {
        results.push({
          phone,
          status: "failed",
          detail: error instanceof Error ? error.message : "Falha ao enviar.",
        });
      }
    }

    const sent = results.filter((item) => item.status === "sent").length;

    return {
      total: results.length,
      sent,
      failed: results.length - sent,
      contacts: results,
    };
  }

  private async sendMedia(input: {
    phone: string;
    media: NonNullable<MassMessageInput["media"]>;
    caption?: string;
    config?: ReturnType<typeof agentConfig>;
  }) {
    if (input.media.mimeType.startsWith("image/")) {
      await this.zapiService.sendImage({
        phone: input.phone,
        image: input.media.dataUrl,
        caption: input.caption,
        config: input.config,
      });
      return;
    }

    if (input.media.mimeType.startsWith("audio/")) {
      await this.zapiService.sendAudio({
        phone: input.phone,
        audio: input.media.dataUrl,
        config: input.config,
      });
      return;
    }

    if (input.media.mimeType.startsWith("video/")) {
      await this.zapiService.sendVideo({
        phone: input.phone,
        video: input.media.dataUrl,
        caption: input.caption,
        config: input.config,
      });
      return;
    }

    await this.zapiService.sendDocument({
      phone: input.phone,
      document: input.media.dataUrl,
      fileName: input.media.fileName,
      caption: input.caption,
      config: input.config,
    });
  }
}

function parseContacts(value: string) {
  const normalized = value
    .split(/\r?\n|;|,/)
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = new Set<string>();

  for (const item of normalized) {
    const digits = item.replace(/\D/g, "");
    if (!digits) continue;
    const phone = normalizeWhatsappPhone(digits);
    if (phone.length >= 12) {
      unique.add(phone);
    }
  }

  return Array.from(unique);
}

function normalizeWhatsappPhone(phone: string) {
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  if (digits.startsWith("55")) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function agentConfig(agent?: {
  zapiBaseUrl?: string | null;
  zapiInstanceId?: string | null;
  zapiToken?: string | null;
  zapiClientToken?: string | null;
  zapiWhatsappNumber?: string | null;
} | null) {
  if (!agent) return undefined;

  return {
    baseUrl: agent.zapiBaseUrl ?? undefined,
    instanceId: agent.zapiInstanceId ?? undefined,
    token: agent.zapiToken ?? undefined,
    clientToken: agent.zapiClientToken ?? undefined,
    whatsappNumber: agent.zapiWhatsappNumber ?? undefined,
  };
}
