"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Paperclip, Plus, Search, Send, Square, UserCheck, Undo2, X } from "lucide-react";
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

type ConversationListItem = {
  id: string;
  phone: string;
  state: string;
  updatedAt: string;
  lead: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  owner: ConversationUser | null;
  tags: string[];
  botActive: boolean;
  lastMessage: { id: string; direction: string; body: string; createdAt: string } | null;
  messages: Array<{ id: string; direction: string; body: string; createdAt: string }>;
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
  tags: string[];
  memory: Record<string, unknown>;
  botActive: boolean;
  messages: Array<{ id: string; direction: string; body: string; createdAt: string }>;
};

type ConversationPayload = {
  conversations: {
    items: ConversationListItem[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  users: ConversationUser[];
};

const TAG_SUGGESTIONS = ["Novo lead", "Prioridade", "Retorno", "Instalação", "Venda", "Sem viabilidade"];
const PAGE_SIZE = 20;

export function ConversationCenter() {
  const { data: currentUser } = useCurrentUser();
  const [payload, setPayload] = useState<ConversationPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [customTag, setCustomTag] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ phone: "", leadName: "", firstMessage: "", ownerUserId: "" });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const conversationListRef = useRef<HTMLDivElement | null>(null);

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

    if (!params?.silent) {
      if (reset) {
        setIsLoading(true);
      } else {
        setIsLoadingMore(true);
      }
    }

    const response = await fetch(`/api/conversations?offset=${offset}&limit=${limit}`, { cache: "no-store" });
    const result = await response.json();
    if (result.status !== "success") {
      setStatusMessage(result.message ?? "Não foi possível carregar as conversas.");
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }

    const nextPayload = result.data as ConversationPayload;
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

    const baseItems = reset || !payload
      ? nextPayload.conversations.items
      : [...(payload?.conversations.items ?? []), ...nextPayload.conversations.items];
    const nextSelectedId = params?.preferredId ?? selectedId ?? baseItems[0]?.id ?? null;
    setSelectedId(nextSelectedId);

    if (nextSelectedId) {
      await loadDetail(nextSelectedId);
    } else {
      setDetail(null);
    }

    setIsLoading(false);
    setIsLoadingMore(false);
  }

  async function loadDetail(conversationId: string) {
    const response = await fetch(`/api/conversations?conversationId=${conversationId}`, { cache: "no-store" });
    const result = await response.json();
    if (result.status === "success") {
      setDetail(result.data as ConversationDetail | null);
      setSelectedId(conversationId);
    }
  }

  useEffect(() => {
    void loadConversations({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/conversations/stream");

    source.addEventListener("connected", () => {
      setIsRealtimeConnected(true);
    });

    source.addEventListener("conversation-update", () => {
      void loadConversations({
        preferredId: selectedId,
        reset: true,
        silent: true,
        limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE),
      });
    });

    source.onerror = () => {
      setIsRealtimeConnected(false);
    };

    return () => {
      source.close();
    };
  }, [payload?.conversations.items.length, selectedId]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    };
  }, [audioPreviewUrl]);

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
        ...conversation.tags,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [payload, search]);

  async function handleConversationListScroll() {
    const node = conversationListRef.current;
    if (!node || search.trim()) return;
    if (isLoading || isLoadingMore || !payload?.conversations.hasMore) return;

    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;

    if (distanceToBottom <= 180) {
      await loadConversations();
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
    if (!detail) return;
    setIsSavingTags(true);
    const response = await fetch("/api/conversations/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: detail.id, tags }),
    });
    const result = await response.json();
    setStatusMessage(result.message ?? null);
    setCustomTag("");
    await loadConversations({ preferredId: detail.id, reset: true, limitOverride: Math.max(payload?.conversations.items.length ?? PAGE_SIZE, PAGE_SIZE) });
    setIsSavingTags(false);
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Central de Conversas</CardTitle>
            <CardDescription>Inbox em tempo real do WhatsApp da Cris com controle humano.</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`h-2.5 w-2.5 rounded-full ${isRealtimeConnected ? "bg-emerald-500" : "bg-orange-500"}`} />
            {isRealtimeConnected ? "Tempo real conectado" : "Reconectando..."}
            <Button type="button" size="sm" onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Novo número
            </Button>
          </div>
        </CardHeader>
      </Card>

      {statusMessage ? (
        <div className="rounded-md border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">{statusMessage}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-[76vh] overflow-hidden">
          <CardHeader>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Pesquisar conversa, número ou etiqueta" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="h-[calc(76vh-88px)]">
            <div
              ref={conversationListRef}
              className="h-full space-y-3 overflow-y-auto"
              onScroll={() => {
                void handleConversationListScroll();
              }}
            >
              {isLoading ? <p className="text-sm text-muted-foreground">Carregando conversas...</p> : null}
              {filteredConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void loadDetail(conversation.id)}
                  className={`w-full rounded-lg border p-3 text-left transition ${selectedId === conversation.id ? "border-cyan-500 bg-cyan-50" : "hover:bg-muted/40"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{conversation.lead?.name ?? conversation.phone}</p>
                      <p className="text-xs text-muted-foreground">{conversation.phone}</p>
                    </div>
                    <span className="text-[11px] text-muted-foreground">{formatTime(conversation.updatedAt)}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{conversation.lastMessage?.body ?? "Sem mensagens ainda"}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <span className={`rounded-full px-2 py-1 ${conversation.botActive ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700"}`}>
                      {conversation.botActive ? "Cris ativa" : "Assumida"}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-1">{conversation.state}</span>
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

        <Card className="min-h-[76vh]">
          {!detail ? (
            <CardContent className="flex min-h-[76vh] items-center justify-center text-sm text-muted-foreground">
              Selecione uma conversa para começar.
            </CardContent>
          ) : (
            <>
              <CardHeader className="border-b">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <CardTitle>{detail.lead?.name ?? detail.phone}</CardTitle>
                    <CardDescription>
                      {detail.phone} • Etapa atual: {detail.state} • {detail.agent?.name ?? "Cris"}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
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
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {detail.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => void saveTags(detail.tags.filter((item) => item !== tag))}
                      className="rounded-full bg-cyan-100 px-3 py-1 text-xs text-cyan-800"
                    >
                      {tag} <X className="ml-1 inline h-3 w-3" />
                    </button>
                  ))}
                  {TAG_SUGGESTIONS.filter((tag) => !detail.tags.includes(tag)).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => void saveTags([...detail.tags, tag])}
                      className="rounded-full border px-3 py-1 text-xs"
                    >
                      + {tag}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2">
                  <Input placeholder="Criar etiqueta..." value={customTag} onChange={(event) => setCustomTag(event.target.value)} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSavingTags}
                    onClick={() => customTag.trim() && void saveTags([...detail.tags, customTag])}
                  >
                    Adicionar
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="flex min-h-[56vh] flex-col">
                <div className="flex-1 space-y-3 overflow-y-auto py-4">
                  {detail.messages.map((messageItem) => (
                    <div key={messageItem.id} className={`flex ${messageItem.direction === "inbound" ? "justify-start" : "justify-end"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${messageItem.direction === "inbound" ? "bg-muted" : "bg-alffa-navy text-white"}`}>
                        <p className="whitespace-pre-wrap break-words">{messageItem.body}</p>
                        <p className={`mt-2 text-[11px] ${messageItem.direction === "inbound" ? "text-muted-foreground" : "text-cyan-100"}`}>
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

                <div className="flex flex-col gap-3 border-t pt-4">
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{detail.botActive ? "Cris pode responder nesta conversa." : "Somente operador responde nesta conversa."}</span>
                    <span>•</span>
                    <span>Todos os funcionários visualizam todas as conversas.</span>
                  </div>
                  <div className="flex flex-col gap-3 md:flex-row md:items-end">
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="icon" onClick={() => fileInputRef.current?.click()}>
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="outline" size="icon" onClick={isRecording ? stopRecording : () => void startRecording()}>
                        {isRecording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                      </Button>
                    </div>
                    <Textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={selectedFile ? "Digite uma legenda opcional..." : "Digite sua mensagem..."}
                      className="min-h-24 flex-1"
                    />
                    <Button type="button" onClick={() => void sendMessage()} disabled={isSending}>
                      <Send className="h-4 w-4" />
                      {isSending ? "Enviando..." : "Enviar"}
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
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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
