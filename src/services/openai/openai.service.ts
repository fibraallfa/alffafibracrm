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
              "Quando houver conta de luz/agua/telefone, procure CEP no endereco de instalacao ou endereco do cliente.",
              "CEP brasileiro normalmente aparece como 00000-000 ou perto da palavra CEP. Nao confunda CEP com CPF, CNPJ, nota fiscal ou codigo da concessionaria.",
              "CPF pode aparecer em RG, CNH, conta ou cadastro do titular. Data de nascimento pode aparecer como nascimento, nasc., data nasc. ou DN.",
              "Nunca deduza nem complete dados ilegíveis. Use null quando não houver certeza.",
              "Responda apenas JSON válido, sem markdown, neste formato:",
              '{"cep":null,"fullName":null,"cpf":null,"birthDate":null,"streetNumber":null,"address":null,"email":null,"rawText":null}',
              "Normalize CEP como 8 dígitos, CPF como 11 dígitos e nascimento como DD/MM/AAAA.",
              "Em rawText, coloque o texto bruto que conseguiu ler do documento, mesmo que incompleto.",
            ].join("\n"),
          },
          media,
        ],
      }],
    });

    return parseExtractedCustomerData(response.output_text);
  }

  async transcribeAudio(input: { url: string; mimeType: string }) {
    const config = await getOpenAiRuntimeConfig();
    if (!config.apiKey) return "";

    const mediaResponse = await fetch(input.url, { signal: AbortSignal.timeout(12_000) });
    if (!mediaResponse.ok) throw new Error("Não foi possível baixar o áudio recebido.");
    const declaredSize = Number(mediaResponse.headers.get("content-length") ?? 0);
    if (declaredSize > 20 * 1024 * 1024) throw new Error("Áudio excede o limite de 20 MB.");

    const bytes = await mediaResponse.arrayBuffer();
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Áudio excede o limite de 20 MB.");
    const mimeType = input.mimeType.split(";")[0] || "audio/ogg";
    const extension = audioExtension(mimeType);
    const file = new File([bytes], `audio.${extension}`, { type: mimeType });
    const client = new OpenAI({ apiKey: config.apiKey, timeout: 25_000, maxRetries: 0 });
    const transcription = await client.audio.transcriptions.create({
      file,
      model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      language: "pt",
      prompt: "Atendimento comercial brasileiro de internet Claro. Preserve nomes, números, CEP, CPF, e-mail e datas falados.",
    });

    return transcription.text.trim();
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
  rawText?: string;
};

function parseExtractedCustomerData(value: string): ExtractedCustomerData {
  try {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    const parsed = JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
    const text = (key: string) => typeof parsed[key] === "string" && parsed[key] ? String(parsed[key]).trim() : undefined;
    const rawText = text("rawText") ?? text("ocrText") ?? text("texto") ?? text("textoBruto");
    return {
      cep: normalizeCep(text("cep")) ?? findLikelyCep(rawText),
      fullName: text("fullName"),
      cpf: digitsWithLength(text("cpf"), 11) ?? findCpf(rawText),
      birthDate: normalizeBirthDate(text("birthDate")) ?? findBirthDate(rawText),
      streetNumber: text("streetNumber"),
      address: text("address"),
      email: text("email"),
      rawText,
    };
  } catch {
    return {};
  }
}

function normalizeCep(value: string | undefined) {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : undefined;
}

function digitsWithLength(value: string | undefined, length: number) {
  const digits = value?.replace(/\D/g, "");
  return digits?.length === length ? digits : undefined;
}

function findLikelyCep(value: string | undefined) {
  if (!value) return undefined;

  const formatted = value.match(/\b\d{5}\s*[-–—.]?\s*\d{3}\b/);
  if (formatted) return formatted[0].replace(/\D/g, "");

  const nearCep = value.match(/cep\D{0,20}(\d[\d\s.\-–—]{6,}\d)/i);
  const digits = nearCep?.[1]?.replace(/\D/g, "");
  return digits && digits.length >= 8 ? digits.slice(0, 8) : undefined;
}

function findCpf(value: string | undefined) {
  if (!value) return undefined;
  const formatted = value.match(/\b\d{3}\.?\s*\d{3}\.?\s*\d{3}\s*[-–—]?\s*\d{2}\b/);
  return formatted?.[0]?.replace(/\D/g, "");
}

function normalizeBirthDate(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(/\b(\d{1,2})[\/.\-\s](\d{1,2})[\/.\-\s](\d{2,4})\b/);
  if (!match) return undefined;
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `19${match[3]}` : match[3];
  return `${day}/${month}/${year}`;
}

function findBirthDate(value: string | undefined) {
  if (!value) return undefined;
  const nearLabel = value.match(/(?:nascimento|nasc\.?|data nasc\.?|dn)\D{0,20}(\d{1,2}[\/.\-\s]\d{1,2}[\/.\-\s]\d{2,4})/i);
  return normalizeBirthDate(nearLabel?.[1]);
}

function audioExtension(mimeType: string) {
  const extensions: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  return extensions[mimeType] ?? "ogg";
}
