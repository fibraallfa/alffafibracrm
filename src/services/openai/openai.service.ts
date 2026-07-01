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
}
