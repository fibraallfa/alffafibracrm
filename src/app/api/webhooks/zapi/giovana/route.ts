import { GIOVANA_AGENT_ID } from "@/config/giovana";
import { handleZapiWebhook } from "@/modules/chatbot/services/zapi-webhook";

export const maxDuration = 120;

export async function POST(request: Request) {
  return handleZapiWebhook(request, GIOVANA_AGENT_ID);
}
