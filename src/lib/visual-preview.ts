import { NextResponse, type NextRequest } from "next/server";

// Opt-in, loopback-only preview. Never bypass authentication in production.
export function visualPreviewResponse(request: NextRequest): NextResponse | null {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.CRM_VISUAL_PREVIEW !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname)
  ) return null;

  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/api")) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return new NextResponse("Preview is read-only", { status: 403 });
    }
    return NextResponse.next();
  }

  const timestamp = new Date().toISOString();
  const success = (data: unknown) => NextResponse.json(
    { status: "success", message: "Dados demonstrativos", data, timestamp },
    { headers: { "Cache-Control": "no-store" } },
  );

  if (request.method === "GET" && pathname === "/api/auth/me") {
    return success({
      id: "visual-preview", name: "Equipe Allfa", email: "preview@example.invalid",
      role: "ADMIN", status: "ACTIVE", permissions: {}, avatarUrl: null, theme: "light",
    });
  }

  if (request.method === "GET" && pathname === "/api/dashboard") {
    return success({
      newLeads: 48, wonLeads: 32, totalValue: 4516.8, expenses: 780, showExpenses: true,
      leadStatuses: ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL", "WON", "LOST"].map((status, index) => ({ status, count: [48, 38, 27, 19, 32, 8][index] })),
      leadChart: [18, 32, 25, 46, 38, 57, 48].map((count, index) => {
        const date = new Date();
        date.setDate(date.getDate() - 6 + index);
        return { count, date: date.toISOString(), label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) };
      }),
      planSales: [
        { planId: "demo-1", planName: "Combo Super", count: 16, totalValue: 2078.4 },
        { planId: "demo-2", planName: "Plano 500Mb", count: 10, totalValue: 999 },
        { planId: "demo-3", planName: "Plano 1Gb", count: 6, totalValue: 1439.4 },
      ],
      recentLeads: ["Marina Exemplo", "Rafael Demonstração", "Camila Exemplo"].map((name, index) => ({
        id: `demo-${index}`, name, phone: "Contato demonstrativo", status: ["NEW", "PROPOSAL", "WON"][index],
        city: null, state: null, planName: "Combo Super", assignedUserName: "Equipe Allfa",
        expectedValue: 129.9, createdAt: timestamp,
      })),
    });
  }

  if (request.method === "GET" && pathname === "/api/conversations") {
    const items = ["Marina Exemplo", "Rafael Demonstração", "Camila Exemplo"].map((name, index) => ({
      id: `demo-chat-${index}`, phone: "Contato demonstrativo", state: "ASK_NAME", updatedAt: timestamp,
      lead: { id: `demo-lead-${index}`, name }, agent: { id: "demo-agent", name: "Cris" },
      owner: null, ownerUserId: null, tags: [{ label: "Demonstração", color: "sky" }], botActive: true,
      hasPendingCustomerMessage: false, isStalled: false,
      lastMessage: { id: `out-${index}`, direction: "outbound", body: "Posso te ajudar a encontrar o plano ideal. Qual é o seu nome completo?", createdAt: timestamp },
    }));
    const id = request.nextUrl.searchParams.get("conversationId");
    if (id) {
      const item = items.find((entry) => entry.id === id);
      return success(item ? { ...item, memory: {}, messages: [
        { id: "demo-in", direction: "inbound", body: "Olá! Gostaria de saber mais sobre os planos de internet.", createdAt: timestamp },
        { id: "demo-out", direction: "outbound", body: "Olá! Vamos encontrar uma opção para você. Esta conversa é apenas uma demonstração visual do atendimento.", createdAt: timestamp },
        { id: "demo-in2", direction: "inbound", body: "Quero internet para trabalhar em casa. Pode me ajudar?", createdAt: timestamp },
        item.lastMessage,
      ], messagesPagination: { total: 4, offset: 0, limit: 40, hasMore: false } } : null);
    }
    const query = (request.nextUrl.searchParams.get("search") ?? "").toLowerCase();
    const filtered = items.filter((item) => item.lead.name.toLowerCase().includes(query));
    return success({ users: [], conversations: { items: filtered, total: filtered.length, offset: 0, limit: 20, hasMore: false, summary: { unavailable: 0, finished: 0, stalled: 0 } } });
  }

  // Block ALL other APIs, including cron and webhooks, before their public-route rules.
  return NextResponse.json({
    status: "error", code: "VISUAL_PREVIEW_ONLY", timestamp,
    message: "Prévia visual: integrações e alterações de dados estão desativadas.",
  }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
