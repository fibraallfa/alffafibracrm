"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, MessageCircleMore, Filter, Mic, Paintbrush, Paperclip, Plus, Search, Send, Square, Trash2, UserCheck, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-current-user";

type ConversationUser = {
  id: string;
  name: string;
  role: "ADMIN" | "EMPLOYEE";
};

type ConversationTag = {
  label: string;
  color: string;
};

type ConversationListItem = {
  id: string;
  phone: string;
  state: string;
  updatedAt: string;
  lead: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  owner: ConversationUser | null;
  tags: ConversationTag[];
  botActive: boolean;
  isStalled?: boolean;
  stalledStageLabel?: string | null;
  hasPendingCustomerMessage: boolean;
  lastMessage: { id: string; direction: string; body: string; createdAt: string } | null;
};

type ConversationDetail = {
  id: string;
  phone: string;
  state: string;
  updatedAt: string;
  lead: {
    id: string;
    name: string;
    email?: string | null;
    cep?: string | null;
    city?: string | null;
    state?: string | null;
  } | null;
  agent: { id: string; name: string } | null;
  owner: ConversationUser | null;
  ownerUserId: string | null;
  tags: ConversationTag[];
  memory: Record<string, unknown>;
  botActive: boolean;
  messages: Array<{ id: string; direction: string; body: string; createdAt: string }>;
  messagesPagination?: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
};

type ConversationPayload = {
  conversations: {
    items: ConversationListItem[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    summary?: {
      unavailable: number;
      finished: number;
      stalled: number;
    };
  };
  users: ConversationUser[];
};

type ConversationFilter = "all" | "unavailable" | "finished" | "stalled";

const TAG_SUGGESTIONS = ["Novo lead", "Prioridade", "Retorno", "Instalação", "Venda", "Sem viabilidade"];
const PAGE_SIZE = 20;
const TAG_COLORS = [
  { value: "sky", label: "Azul" },
  { value: "emerald", label: "Verde" },
  { value: "amber", label: "Amarelo" },
  { value: "rose", label: "Rosa" },
  { value: "violet", label: "Roxo" },
  { value: "slate", label: "Cinza" },
];

export function ConversationCenter() {
  const { data: currentUser } = useCurrentUser();
  const [payload, setPayload] = useState<ConversationPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [search, setSearch] = useState("");
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [customTag, setCustomTag] = useState("");
  const [customTagColor, setCustomTagColor] = useState("sky");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ phone: "", leadName: "", firstMessage: "", ownerUserId: "" });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [activeFilter, setActiveFilter] = useState<ConversationFilter>("all");
  const [isFilterPopupOpen, setIsFilterPopupOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const filterPopupRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const visibleCountRef = useRef(PAGE_SIZE);

  async function loadConversations(params?: {
    preferredId?: string | null;
    reset?: boolean;
    silent?: boolean;
    limitOverride?: number;
  }) {
    const reset = params?.reset ?? false;
    const currentCount = reset ? 0 : payload?.conversations.items.length ?? 0;
    const offset = reset ? 0 : currentCount;
    const limit = params?.limitOverride ?? PAGE_SIZE;
    const filter = params?.reset ? activeFilter : activeFilter;

    if (!params?.silent) {
      if (reset) {
        setIsLoading(true);
      } else {
        setIsLoadingMore(true);
      }
    }

    const response = await fetch(`/api/conversations?offset=${offset}&limit=${limit}&filter=${filter}`, { cache: "no-store" });
    const result = await response.json();
    if (result.status !== "success") {
      setStatusMessage(result.message ?? "Não foi possível carregar as conversas.");
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }

    const nextPayload = normalizeConversationPayload(result.data);
    setPayload((current) => {
      if (reset || !current) {
        return nextPayload;
      }

      return {
        users: nextPayload.users,
        conversations: {
          ...nextPayload.conversations,
          items: [...current.conversations.items, ...nextPayload.conversations.items],
        },
      };
    });

    const previousItems = payload?.conversations.items ?? [];
    const baseItems = reset || !payload
      ? nextPayload.conversations.items
      : [...previousItems, ...nextPayload.conversations.items];
    const nextSelectedId = params && "preferredId" in params
      ? (params.preferredId ?? baseItems[0]?.id ?? null)
      : (selectedId ?? baseItems[0]?.id ?? null);
    setSelectedId(nextSelectedId);

    const shouldRefreshDetail = Boolean(
      nextSelectedId && (
        reset ||
        !detail ||
        detail.id !== nextSelectedId ||
        previousItems.find((item) => item.id === nextSelectedId)?.updatedAt !==
          baseItems.find((item) => item.id === nextSelectedId)?.updatedAt
      ),
    );

    if (nextSelectedId && shouldRefreshDetail) {
      await loadDetail(nextSelectedId);
    } else if (!nextSelectedId) {
      setDetail(null);
    }

    setIsLoading(false);
    setIsLoadingMore(false);
  }

  async function loadDetail(conversationId: string, options?: { appendOlder?: boolean }) {
    const appendOlder = options?.appendOlder ?? false;
    const currentOffset = appendOlder ? detail?.messagesPagination?.offset ?? 0 : 0;
    const limit = detail?.messagesPagination?.limit ?? 40;
    const nextOffset = appendOlder ? currentOffset + limit : 0;
    const beforeHeight = messagesScrollRef.current?.scrollHeight ?? 0;
    const response = await fetch(
      `/api/conversations?conversationId=${conversationId}&messagesOffset=${nextOffset}&messagesLimit=${limit}`,
      { cache: "no-store" },
    );
    const result = await response.json();
    if (result.status === "success") {
      const normalized = result.data ? normalizeConversationDetail(result.data) : null;
      setDetail((current) => {
        if (!normalized) return null;
        if (!appendOlder || !current || current.id !== normalized.id) {
          return normalized;
        }

        const existingIds = new Set(current.messages.map((messageItem) => messageItem.id));
        const olderMessages = normalized.messages.filter((messageItem) => !existingIds.has(messageItem.id));
        return {
          ...normalized,
          messages: [...olderMessages, ...current.messages],
          messagesPagination: normalized.messagesPagination,
        };
      });
      setSelectedId(conversationId);
      if (appendOlder) {
        requestAnimationFrame(() => {
          const node = messagesScrollRef.current;
          if (!node) return;
          const afterHeight = node.scrollHeight;
          node.scrollTop = afterHeight - beforeHeight + node.scrollTop;
        });
      } else {
        requestAnimationFrame(() => {
          const node = messagesScrollRef.current;
          if (!node) return;
          node.scrollTop = node.scrollHeight;
        });
      }
    }
  }

  useEffect(() => {
    void loadConversations({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    visibleCountRef.current = Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE);
  }, [payload?.conversations.items.length]);

  useEffect(() => {
    const source = new EventSource("/api/conversations/stream");

    source.addEventListener("connected", () => {
      setIsRealtimeConnected(true);
    });

    source.addEventListener("conversation-update", () => {
      void loadConversations({
        preferredId: selectedIdRef.current,
        reset: true,
        silent: true,
        limitOverride: visibleCountRef.current,
      });
    });

    source.onerror = () => {
      setIsRealtimeConnected(false);
    };

    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    void loadConversations({ reset: true, preferredId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    };
  }, [audioPreviewUrl]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (!filterPopupRef.current?.contains(event.target as Node)) {
        setIsFilterPopupOpen(false);
      }
    }

    if (isFilterPopupOpen) {
      window.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isFilterPopupOpen]);

  const filteredConversations = useMemo(() => {
    const list = payload?.conversations.items ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return list;

    return list.filter((conversation) =>
      [
        conversation.phone,
        conversation.state,
        conversation.lead?.name,
        conversation.owner?.name,
        conversation.lastMessage?.body,
        ...conversation.tags.map((tag) => tag.label),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [payload, search]);

  const filterCards = useMemo(() => {
    const summary = payload?.conversations.summary ?? { unavailable: 0, finished: 0, stalled: 0 };
    return [
      { key: "all" as const, label: "Todas", count: payload?.conversations.total ?? 0 },
      { key: "unavailable" as const, label: "Sem cobertura", count: summary.unavailable },
      { key: "finished" as const, label: "Completou o fluxo", count: summary.finished },
      { key: "stalled" as const, label: "Cliente parou de responder", count: summary.stalled },
    ];
  }, [payload]);

  async function handleConversationListScroll() {
    const node = conversationListRef.current;
    if (!node || search.trim()) return;
    if (isLoading || isLoadingMore || !payload?.conversations.hasMore) return;

    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;

    if (distanceToBottom <= 180) {
      await loadConversations();
    }
  }

  async function handleMessagesScroll() {
    const node = messagesScrollRef.current;
    if (!node || !detail?.messagesPagination?.hasMore || isLoadingOlderMessages) return;
    if (node.scrollTop > 120) return;

    setIsLoadingOlderMessages(true);
    try {
      await loadDetail(detail.id, { appendOlder: true });
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  async function toggleControl() {
    if (!detail) return;
    setStatusMessage(null);
    const response = await fetch("/api/conversations/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: detail.id }),
    });
    const result = await response.json();
    setStatusMessage(result.message ?? null);
    await loadConversations({ preferredId: detail.id, reset: true, limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE) });
  }

  async function assignOwner(ownerUserId: string) {
    if (!detail) return;
    const response = await fetch("/api/conversations/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: detail.id, ownerUserId: ownerUserId || null }),
    });
    const result = await response.json();
    setStatusMessage(result.message ?? null);
    await loadConversations({ preferredId: detail.id, reset: true, limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE) });
  }

  async function saveTags(tags: string[]) {
    await saveTagObjects(tags.map((tag) => ({ label: tag, color: "sky" })));
  }

  async function saveTagObjects(tags: ConversationTag[]) {
    if (!detail) return;
    setIsSavingTags(true);
    try {
      const response = await fetch("/api/conversations/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: detail.id, tags }),
      });
      const result = await response.json();
      setStatusMessage(result.message ?? null);
      setCustomTag("");
      await loadConversations({ preferredId: detail.id, reset: true, limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE) });
    } finally {
      setIsSavingTags(false);
    }
  }

  async function sendMessage() {
    if (!detail || isSending || (!message.trim() && !selectedFile)) return;
    setIsSending(true);

    const response = selectedFile
      ? await sendMedia()
      : await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: detail.id, content: message.trim() }),
        });

    const result = await response.json();
    setStatusMessage(result.message ?? null);
    setMessage("");
    clearSelectedMedia();
    await loadConversations({ preferredId: detail.id, reset: true, limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE) });
    setIsSending(false);
  }

  async function sendMedia() {
    const formData = new FormData();
    formData.append("conversationId", detail!.id);
    formData.append("caption", message);
    if (selectedFile) formData.append("file", selectedFile);

    return fetch("/api/conversations/media", {
      method: "POST",
      body: formData,
    });
  }

  async function startConversation() {
    const response = await fetch("/api/conversations/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: createForm.phone,
        leadName: createForm.leadName,
        firstMessage: createForm.firstMessage,
        ownerUserId: createForm.ownerUserId || currentUser?.id,
      }),
    });
    const result = await response.json();
    setStatusMessage(result.message ?? null);

    if (result.status === "success" && result.data?.id) {
      setIsCreateOpen(false);
      setCreateForm({ phone: "", leadName: "", firstMessage: "", ownerUserId: "" });
      await loadConversations({ preferredId: result.data.id, reset: true });
    }
  }

  async function startRecording() {
    if (isRecording) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);

    mediaStreamRef.current = stream;
    mediaRecorderRef.current = recorder;
    audioChunksRef.current = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const file = new File([blob], `audio-${Date.now()}.webm`, { type: recorder.mimeType || "audio/webm" });
      setSelectedFile(file);
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
      setAudioPreviewUrl(URL.createObjectURL(blob));
      stream.getTracks().forEach((track) => track.stop());
      setIsRecording(false);
    });

    recorder.start();
    setIsRecording(true);
  }

  function stopRecording() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
    mediaRecorderRef.current = null;
  }

  function clearSelectedMedia() {
    setSelectedFile(null);
    if (audioPreviewUrl) {
      URL.revokeObjectURL(audioPreviewUrl);
      setAudioPreviewUrl(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function deleteConversation() {
    if (!detail) return;
    if (!window.confirm("Tem certeza que deseja excluir esta conversa?")) return;

    const response = await fetch(`/api/conversations/${detail.id}`, {
      method: "DELETE",
    });
    const result = await response.json();
    setStatusMessage(result.message ?? null);
    setDetail(null);
    setSelectedId(null);
    await loadConversations({ reset: true, preferredId: null });
  }

  return (
    <div className="wa-inbox" data-mobile-chat={mobileChatOpen}>
      <Card className="wa-toolbar">
        <CardHeader className="mb-0 flex flex-row items-center justify-between gap-4 border-0 bg-none p-3">
          <div>
            <CardTitle>Central de Conversas</CardTitle>
            <CardDescription className="hidden sm:block">Atendimento WhatsApp · Allfa Fibra</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`h-2.5 w-2.5 rounded-full ${isRealtimeConnected ? "bg-emerald-500" : "bg-orange-500"}`} />
            {currentUser?.id === "visual-preview" ? "Prévia local" : isRealtimeConnected ? "Conectado" : "Reconectando..."}
            <Button type="button" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Novo número
            </Button>
          </div>
        </CardHeader>
      </Card>

      {statusMessage ? (
        <div className="rounded-md border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">{statusMessage}</div>
      ) : null}

      <div className="wa-columns">
        <Card className="wa-list-panel">
          <CardHeader className="mb-0 shrink-0 rounded-none bg-none p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">Conversas</p>
                <p className="text-xs text-muted-foreground">
                  {filterCards.find((item) => item.key === activeFilter)?.label ?? "Todas"} • {filterCards.find((item) => item.key === activeFilter)?.count ?? 0}
                </p>
              </div>
              <div className="relative" ref={filterPopupRef}>
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => setIsFilterPopupOpen((current) => !current)}>
                  <Filter className="h-4 w-4" />
                  Filtros
                </Button>
                {isFilterPopupOpen ? (
                  <div className="absolute right-0 top-12 z-20 w-72 rounded-3xl border border-slate-200 bg-white p-3 shadow-2xl">
                    <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Filtrar conversas</div>
                    <div className="space-y-2">
                      {filterCards.map((filterItem) => (
                        <button
                          key={filterItem.key}
                          type="button"
                          onClick={() => {
                            setActiveFilter(filterItem.key);
                            setIsFilterPopupOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition ${
                            activeFilter === filterItem.key
                              ? "bg-[#0b2441] text-white"
                              : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          <span className="text-sm font-medium">{filterItem.label}</span>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${activeFilter === filterItem.key ? "bg-white/15 text-white" : "bg-white text-slate-700"}`}>
                            {filterItem.count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Pesquisar conversa, número ou etiqueta" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-0">
            <div
              ref={conversationListRef}
              className="h-full overflow-y-auto"
              onScroll={() => {
                void handleConversationListScroll();
              }}
            >
              {isLoading ? <p className="text-sm text-muted-foreground">Carregando conversas...</p> : null}
              {filteredConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => { setMobileChatOpen(true); void loadDetail(conversation.id); }}
                  className={`wa-contact w-full border-b px-4 py-3 text-left transition-colors ${selectedId === conversation.id ? "bg-primary/10" : "hover:bg-muted/60"}`}
                >
                <div className="flex items-start justify-between gap-3">
                  <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-bold text-primary">{(conversation.lead?.name ?? conversation.phone).slice(0, 2).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{conversation.lead?.name ?? conversation.phone}</p>
                      {conversation.hasPendingCustomerMessage ? (
                        <span
                          className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-600 ring-2 ring-cyan-100"
                          aria-label="Cliente aguardando resposta"
                          title="Cliente aguardando resposta"
                        />
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{conversation.phone}</p>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{formatTime(conversation.updatedAt)}</span>
                  </div>
                  <p className="mt-1.5 truncate text-xs text-muted-foreground">{conversation.lastMessage?.body ?? "Sem mensagens ainda"}</p>
                  <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                    <span className={`rounded-full px-2 py-1 ${conversation.botActive ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700"}`}>
                      {conversation.botActive ? "Cris ativa" : "Assumida"}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-1">{conversation.state}</span>
                    {conversation.isStalled && conversation.stalledStageLabel ? (
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-800">
                        Parado em: {conversation.stalledStageLabel}
                      </span>
                    ) : null}
                    {conversation.tags.map((tag) => (
                      <span key={`${conversation.id}-${tag.label}`} className={`rounded-full px-2 py-1 ${tagClasses(tag.color)}`}>
                        {tag.label}
                      </span>
                    ))}
                    {conversation.owner ? <span className="rounded-full bg-slate-900 px-2 py-1 text-white">{conversation.owner.name}</span> : null}
                  </div>
                </button>
              ))}
              {!isLoading && !filteredConversations.length ? (
                <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">Nenhuma conversa encontrada.</div>
              ) : null}
              {isLoadingMore ? <p className="text-center text-xs text-muted-foreground">Carregando mais conversas...</p> : null}
            </div>
          </CardContent>
        </Card>

        <Card className="wa-chat-panel">
          {!detail ? (
            <CardContent className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <div className="space-y-4 text-center"><MessageCircleMore className="mx-auto h-14 w-14 text-primary/40" /><p className="text-xl font-semibold">Suas conversas, mais próximas.</p><p>Selecione um contato para começar.</p></div>
            </CardContent>
          ) : (
            <>
              <CardHeader className="relative mb-0 shrink-0 rounded-none border-b bg-card bg-none p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon" className="lg:hidden" aria-label="Voltar às conversas" onClick={() => setMobileChatOpen(false)}><ArrowLeft className="h-4 w-4" /></Button><span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">{(detail.lead?.name ?? detail.phone).slice(0, 2).toUpperCase()}</span><CardTitle>{detail.lead?.name ?? detail.phone}</CardTitle></div>
                    <CardDescription>
                      {detail.phone} • Etapa atual: {detail.state} • {detail.agent?.name ?? "Cris"}
                    </CardDescription>
                  </div>
                  <details className="relative">
                    <summary className="cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs font-medium">Gerenciar atendimento</summary>
                    <div className="absolute right-0 top-full z-30 mt-2 flex w-64 flex-wrap gap-2 rounded-xl border bg-card p-3 shadow-xl">
                    <select
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                      value={detail.ownerUserId ?? ""}
                      onChange={(event) => void assignOwner(event.target.value)}
                    >
                      <option value="">Sem responsável</option>
                      {(payload?.users ?? []).map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                    </select>
                    <Button type="button" variant="outline" onClick={() => void toggleControl()}>
                      {detail.botActive ? <UserCheck className="h-4 w-4" /> : <Undo2 className="h-4 w-4" />}
                      {detail.botActive ? "Assumir" : "Devolver"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void deleteConversation()}>
                      <Trash2 className="h-4 w-4" />
                      Excluir
                    </Button>
                    </div>
                  </details>
                </div>

                <details className="wa-tag-menu"><summary className="w-fit cursor-pointer rounded-full bg-muted px-3 py-1 text-xs font-medium">Etiquetas e organização ({detail.tags.length})</summary><div className="absolute inset-x-3 top-full z-20 max-h-64 space-y-3 overflow-y-auto rounded-xl border bg-card p-4 shadow-xl">
                <div className="flex flex-wrap gap-2">
                  {detail.tags.map((tag) => (
                    <div key={tag.label} className="flex items-center gap-1 rounded-full border border-slate-200 bg-white pr-2">
                      <span className={`rounded-full px-3 py-1 text-xs ${tagClasses(tag.color)}`}>{tag.label}</span>
                      <div className="flex items-center gap-1">
                        {TAG_COLORS.map((color) => (
                          <button
                            key={`${tag.label}-${color.value}`}
                            type="button"
                            className={`h-3 w-3 rounded-full ${tagDotClasses(color.value)} ${tag.color === color.value ? "ring-2 ring-slate-400" : ""}`}
                            title={`Trocar para ${color.label}`}
                            onClick={() => void saveTagObjects(detail.tags.map((item) => item.label === tag.label ? { ...item, color: color.value } : item))}
                          />
                        ))}
                        <button
                          type="button"
                          className="rounded-full p-0.5 text-slate-500 hover:bg-slate-100"
                          title="Remover etiqueta"
                          onClick={() => void saveTagObjects(detail.tags.filter((item) => item.label !== tag.label))}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {TAG_SUGGESTIONS.filter((tag) => !detail.tags.some((item) => item.label === tag)).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => void saveTagObjects([...detail.tags, { label: tag, color: "sky" }])}
                      className="rounded-full border px-3 py-1 text-xs"
                    >
                      + {tag}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2">
                  <Input placeholder="Criar etiqueta..." value={customTag} onChange={(event) => setCustomTag(event.target.value)} />
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={customTagColor}
                    onChange={(event) => setCustomTagColor(event.target.value)}
                  >
                    {TAG_COLORS.map((color) => (
                      <option key={color.value} value={color.value}>
                        {color.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSavingTags}
                    onClick={() => customTag.trim() && void saveTagObjects([...detail.tags, { label: customTag, color: customTagColor }])}
                  >
                    <Paintbrush className="h-4 w-4" />
                    Adicionar
                  </Button>
                </div>
                </div></details>
              </CardHeader>

              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                <div
                  ref={messagesScrollRef}
                  className="wa-messages min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-5 sm:px-8"
                  onScroll={() => {
                    void handleMessagesScroll();
                  }}
                >
                  {isLoadingOlderMessages ? (
                    <p className="text-center text-xs text-muted-foreground">Carregando mensagens antigas...</p>
                  ) : null}
                  {detail.messages.map((messageItem) => (
                    <div key={messageItem.id} className={`flex ${messageItem.direction === "inbound" ? "justify-start" : "justify-end"}`}>
                      <div className={`max-w-[88%] rounded-lg px-3 py-2 text-sm leading-relaxed shadow-sm sm:max-w-[78%] ${messageItem.direction === "inbound" ? "rounded-tl-none bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100" : "rounded-tr-none bg-[#d9fdd3] text-slate-900 dark:bg-[#164b42] dark:text-slate-100"}`}>
                        <p className="whitespace-pre-wrap break-words">{messageItem.body}</p>
                        <p className="mt-1 text-right text-[10px] text-slate-500 dark:text-slate-300">
                          {formatTime(messageItem.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                {selectedFile ? (
                  <div className="mb-3 rounded-md border bg-muted/40 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{selectedFile.name}</p>
                        <p className="text-xs text-muted-foreground">{Math.ceil(selectedFile.size / 1024)} KB</p>
                      </div>
                      <Button type="button" variant="ghost" size="icon" onClick={clearSelectedMedia}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {audioPreviewUrl ? <audio className="mt-3 w-full" controls src={audioPreviewUrl} /> : null}
                  </div>
                ) : null}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    if (file) {
                      setSelectedFile(file);
                      if (!file.type.startsWith("audio/")) {
                        if (audioPreviewUrl) {
                          URL.revokeObjectURL(audioPreviewUrl);
                          setAudioPreviewUrl(null);
                        }
                      }
                    }
                  }}
                />

                <div className="mt-auto shrink-0 space-y-2 border-t bg-card px-3 py-3">
                  <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                    <span>{detail.botActive ? "Cris pode responder nesta conversa." : "Somente operador responde nesta conversa."}</span>
                    <span className="hidden sm:inline">•</span>
                    <span className="hidden sm:inline">{currentUser?.role === "ADMIN" ? "Administradores visualizam todas as conversas." : "Você visualiza apenas as conversas atribuídas a você."}</span>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" size="icon" aria-label="Anexar arquivo" onClick={() => fileInputRef.current?.click()}>
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={isRecording ? "Parar gravação" : "Gravar áudio"} onClick={isRecording ? stopRecording : () => void startRecording()}>
                        {isRecording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                      </Button>
                    </div>
                    <Textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={selectedFile ? "Digite uma legenda opcional..." : "Digite sua mensagem..."}
                      rows={1}
                      aria-label="Mensagem"
                      className="min-h-11 max-h-32 min-w-0 flex-1 resize-y rounded-xl bg-background py-3"
                    />
                    <Button type="button" size="icon" aria-label={isSending ? "Enviando mensagem" : "Enviar mensagem"} className="shrink-0 rounded-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => void sendMessage()} disabled={isSending}>
                      <Send className="h-4 w-4" />
                      <span className="sr-only">{isSending ? "Enviando..." : "Enviar"}</span>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>

      {isCreateOpen ? (
        <Modal title="Novo número manual" onClose={() => setIsCreateOpen(false)}>
          <div className="space-y-4">
            <Input placeholder="Nome do contato" value={createForm.leadName} onChange={(event) => setCreateForm((current) => ({ ...current, leadName: event.target.value }))} />
            <Input placeholder="WhatsApp com DDI e DDD" value={createForm.phone} onChange={(event) => setCreateForm((current) => ({ ...current, phone: event.target.value }))} />
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={createForm.ownerUserId} onChange={(event) => setCreateForm((current) => ({ ...current, ownerUserId: event.target.value }))}>
              <option value="">Assumir comigo</option>
              {(payload?.users ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <Textarea placeholder="Primeira mensagem opcional..." value={createForm.firstMessage} onChange={(event) => setCreateForm((current) => ({ ...current, firstMessage: event.target.value }))} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancelar</Button>
              <Button type="button" onClick={() => void startConversation()}>Iniciar conversa</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function normalizeConversationPayload(payload: unknown): ConversationPayload {
  const raw = (payload && typeof payload === "object") ? payload as Partial<ConversationPayload> : {};
  const rawConversations = (raw.conversations && typeof raw.conversations === "object")
    ? raw.conversations as Partial<ConversationPayload["conversations"]>
    : undefined;
  const rawItems = rawConversations?.items;

  return {
    users: Array.isArray(raw.users) ? raw.users : [],
    conversations: {
      items: Array.isArray(rawItems)
        ? rawItems.map((conversation) => normalizeConversationListItem(conversation))
        : [],
      total: typeof rawConversations?.total === "number" ? rawConversations.total : 0,
      offset: typeof rawConversations?.offset === "number" ? rawConversations.offset : 0,
      limit: typeof rawConversations?.limit === "number" ? rawConversations.limit : PAGE_SIZE,
      hasMore: Boolean(rawConversations?.hasMore),
      summary: rawConversations?.summary && typeof rawConversations.summary === "object"
        ? {
            unavailable: Number((rawConversations.summary as { unavailable?: unknown }).unavailable ?? 0),
            finished: Number((rawConversations.summary as { finished?: unknown }).finished ?? 0),
            stalled: Number((rawConversations.summary as { stalled?: unknown }).stalled ?? 0),
          }
        : { unavailable: 0, finished: 0, stalled: 0 },
    },
  };
}

function normalizeConversationListItem(conversation: unknown): ConversationListItem {
  const raw = (conversation && typeof conversation === "object") ? conversation as Partial<ConversationListItem> : {};

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    phone: typeof raw.phone === "string" ? raw.phone : "",
    state: typeof raw.state === "string" ? raw.state : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    lead: raw.lead && typeof raw.lead === "object" ? raw.lead : null,
    agent: raw.agent && typeof raw.agent === "object" ? raw.agent : null,
    owner: raw.owner && typeof raw.owner === "object" ? raw.owner : null,
    tags: normalizeTags(raw.tags),
    botActive: Boolean(raw.botActive),
    isStalled: Boolean(raw.isStalled),
    stalledStageLabel: typeof raw.stalledStageLabel === "string" ? raw.stalledStageLabel : null,
    hasPendingCustomerMessage: Boolean(raw.hasPendingCustomerMessage),
    lastMessage: raw.lastMessage && typeof raw.lastMessage === "object" ? raw.lastMessage : null,
  };
}

function normalizeConversationDetail(detail: unknown): ConversationDetail {
  const raw = (detail && typeof detail === "object") ? detail as Partial<ConversationDetail> : {};

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    phone: typeof raw.phone === "string" ? raw.phone : "",
    state: typeof raw.state === "string" ? raw.state : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    lead: raw.lead && typeof raw.lead === "object" ? raw.lead : null,
    agent: raw.agent && typeof raw.agent === "object" ? raw.agent : null,
    owner: raw.owner && typeof raw.owner === "object" ? raw.owner : null,
    ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
    tags: normalizeTags(raw.tags),
    memory: raw.memory && typeof raw.memory === "object" && !Array.isArray(raw.memory) ? raw.memory : {},
    botActive: Boolean(raw.botActive),
    messages: Array.isArray(raw.messages) ? raw.messages.filter(Boolean) : [],
    messagesPagination: raw.messagesPagination && typeof raw.messagesPagination === "object"
      ? {
          total: Number((raw.messagesPagination as { total?: unknown }).total ?? 0),
          offset: Number((raw.messagesPagination as { offset?: unknown }).offset ?? 0),
          limit: Number((raw.messagesPagination as { limit?: unknown }).limit ?? 40),
          hasMore: Boolean((raw.messagesPagination as { hasMore?: unknown }).hasMore),
        }
      : undefined,
  };
}

function normalizeTags(tags: unknown): ConversationTag[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .map((tag) => normalizeTag(tag))
    .filter((tag): tag is ConversationTag => Boolean(tag));
}

function normalizeTag(tag: unknown): ConversationTag | null {
  if (typeof tag === "string") {
    const label = tag.trim();
    return label ? { label, color: "sky" } : null;
  }

  if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
    return null;
  }

  const raw = tag as Partial<ConversationTag>;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const color = typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : "sky";

  if (!label) {
    return null;
  }

  return { label, color };
}

function tagClasses(color: string) {
  if (color === "emerald") return "bg-emerald-100 text-emerald-800";
  if (color === "amber") return "bg-amber-100 text-amber-800";
  if (color === "rose") return "bg-rose-100 text-rose-800";
  if (color === "violet") return "bg-violet-100 text-violet-800";
  if (color === "slate") return "bg-slate-200 text-slate-800";
  return "bg-sky-100 text-sky-800";
}

function tagDotClasses(color: string) {
  if (color === "emerald") return "bg-emerald-500";
  if (color === "amber") return "bg-amber-500";
  if (color === "rose") return "bg-rose-500";
  if (color === "violet") return "bg-violet-500";
  if (color === "slate") return "bg-slate-500";
  return "bg-sky-500";
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-md border bg-background shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          <Button type="button" size="icon" variant="ghost" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
