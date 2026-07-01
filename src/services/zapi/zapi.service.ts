import { getZapiRuntimeConfig } from "@/lib/integration-config";
import { writeTechnicalLog } from "@/lib/logger";

type SendTextInput = {
  phone: string;
  message: string;
  config?: Partial<ZapiConfig>;
};

type ZapiConfig = Awaited<ReturnType<typeof getZapiRuntimeConfig>>;

export class ZapiService {
  async markAsRead(messageId: string, phone: string, config?: Partial<ZapiConfig>) {
    return this.optionalPost("read-message", { messageId, phone }, config);
  }

  async startTyping(phone: string, config?: Partial<ZapiConfig>) {
    return this.optionalPost("typing", { phone }, config);
  }

  async sendText({ phone, message, config }: SendTextInput) {
    const zapiConfig = { ...(await getZapiRuntimeConfig()), ...cleanConfig(config) };
    if (!zapiConfig.instanceId || !zapiConfig.token) {
      throw new Error("Z-API nao configurada.");
    }

    const response = await fetch(
      `${zapiConfig.baseUrl}/instances/${zapiConfig.instanceId}/token/${zapiConfig.token}/send-text`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(zapiConfig.clientToken ? { "Client-Token": zapiConfig.clientToken } : {}),
        },
        body: JSON.stringify({ phone, message }),
      },
    );

    if (!response.ok) {
      await writeTechnicalLog({
        level: "ERROR",
        category: "integration",
        message: "Falha ao enviar mensagem pela Z-API.",
        method: "POST",
        endpoint: "send-text",
        statusCode: response.status,
        integration: "zapi",
      });
      throw new Error("Falha ao enviar mensagem pela Z-API.");
    }

    return response.json() as Promise<unknown>;
  }

  private async optionalPost(action: string, body: Record<string, string>, config?: Partial<ZapiConfig>) {
    try {
      const zapiConfig = { ...(await getZapiRuntimeConfig()), ...cleanConfig(config) };
      if (!zapiConfig.instanceId || !zapiConfig.token) {
        return false;
      }

      const response = await fetch(
        `${zapiConfig.baseUrl}/instances/${zapiConfig.instanceId}/token/${zapiConfig.token}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(zapiConfig.clientToken ? { "Client-Token": zapiConfig.clientToken } : {}),
          },
          body: JSON.stringify(body),
        },
      );

      return response.ok;
    } catch {
      return false;
    }
  }
}

function cleanConfig(config?: Partial<ZapiConfig>) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => Boolean(value))) as Partial<ZapiConfig>;
}
