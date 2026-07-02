import OpenAI from "openai";
import { getOpenAiRuntimeConfig } from "@/lib/integration-config";

export class OpenAiService {
  async answerCommercialQuestion(prompt: string) {
    const config = await getOpenAiRuntimeConfig();
    if (!config.apiKey) {
      return "";
    }

    const client = new OpenAI({ apiKey: config.apiKey });
    const response = await client.responses.create({
      model: config.model,
      input: prompt,
    });

    return response.output_text;
  }

  async extractCustomerData(input: { url: string; mimeType: string }) {
    const config = await getOpenAiRuntimeConfig();
    if (!config.apiKey) return {};

    const client = new OpenAI({ apiKey: config.apiKey, timeout: 30_000 });
    const media = input.mimeType === "application/pdf"
      ? { type: "input_file" as const, file_url: input.url }
      : { type: "input_image" as const, image_url: input.url, detail: "high" as const };
    const response = await client.responses.create({
      model: config.model,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Leia este documento brasileiro e extraia somente dados explicitamente visiveis.",
              "Pode ser conta de consumo, RG, CNH ou outro comprovante.",
              "Nunca deduza nem complete dados ilegíveis. Use null quando não houver certeza.",
              "Responda apenas JSON válido, sem markdown, neste formato:",
              '{"cep":null,"fullName":null,"cpf":null,"birthDate":null,"streetNumber":null,"address":null,"email":null}',
              "Normalize CEP como 8 dígitos, CPF como 11 dígitos e nascimento como DD/MM/AAAA.",
            ].join("\n"),
          },
          media,
        ],
      }],
    });

    return parseExtractedCustomerData(response.output_text);
  }
}

export type ExtractedCustomerData = {
  cep?: string;
  fullName?: string;
  cpf?: string;
  birthDate?: string;
  streetNumber?: string;
  address?: string;
  email?: string;
};

function parseExtractedCustomerData(value: string): ExtractedCustomerData {
  try {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    const parsed = JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
    const text = (key: string) => typeof parsed[key] === "string" && parsed[key] ? String(parsed[key]).trim() : undefined;
    return {
      cep: digitsWithLength(text("cep"), 8),
      fullName: text("fullName"),
      cpf: digitsWithLength(text("cpf"), 11),
      birthDate: text("birthDate"),
      streetNumber: text("streetNumber"),
      address: text("address"),
      email: text("email"),
    };
  } catch {
    return {};
  }
}

function digitsWithLength(value: string | undefined, length: number) {
  const digits = value?.replace(/\D/g, "");
  return digits?.length === length ? digits : undefined;
}
