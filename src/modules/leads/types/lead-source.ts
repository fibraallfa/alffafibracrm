export function leadSourceLabel(source: string) {
  if (source === "chatbot:giovana") return "Giovana";
  if (source === "chatbot" || source === "chatbot:cris") return "Cris";
  if (source === "manual") return "Cadastro manual";
  return source || "Sem origem";
}
