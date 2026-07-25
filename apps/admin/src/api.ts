export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "сеть недоступна или сервер не отвечает");
  }

  if (!res.ok) throw new ApiError(res.status, await readError(res));

  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text.length === 0) return res.statusText;
  try {
    const body = JSON.parse(text) as { message?: string | string[]; error?: string };
    if (Array.isArray(body.message)) return body.message.join("; ");
    return body.message ?? body.error ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

const post = (body?: unknown): RequestInit =>
  body === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

const patch = (body: unknown): RequestInit => ({ ...post(body), method: "PATCH" });

// --- Мерчанты ---------------------------------------------------------------

export interface Merchant {
  id: string;
  orgId: string;
  provider: string;
  alias: string;
  isEnabled: boolean;
  mode: "live" | "test";
  priority: number;
  /** С бэкенда приходят маскированными («••••••••»), значим только набор ключей. */
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  purposes: string[];
  title: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: string;
  updatedAt: string;
  isConfigured: boolean;
}

export interface ProviderSpec {
  provider: string;
  title: string;
  credentialFields: { key: string; label: string; required: boolean }[];
  settingFields: { key: string; label: string; type: "number" | "string"; default?: string | number }[];
  purposes: string[];
}

export const getMerchants = () => request<Merchant[]>("/api/admin/merchants");

export const getProviderSpecs = () => request<ProviderSpec[]>("/api/admin/merchants/provider-specs");

export const createMerchant = (body: {
  provider: string;
  alias: string;
  title?: string;
  mode?: "live" | "test";
  credentials?: Record<string, string>;
  settings?: Record<string, unknown>;
  purposes?: string[];
}) => request<Merchant>("/api/admin/merchants", post(body));

export const updateMerchant = (
  id: string,
  body: {
    alias?: string;
    title?: string;
    isEnabled?: boolean;
    mode?: "live" | "test";
    priority?: number;
    purposes?: string[];
    settings?: Record<string, unknown>;
    /** Передаются только изменяемые ключи; пустая строка удаляет ключ. */
    credentials?: Record<string, string>;
  },
) => request<Merchant>(`/api/admin/merchants/${id}`, patch(body));

export const checkMerchant = (id: string) =>
  request<{ ok: boolean; detail?: string }>(`/api/admin/merchants/${id}/check`, post());

// --- Ноды и каскады ---------------------------------------------------------

export interface Node {
  id: string;
  name: string;
  roles: string[];
  status: string;
  lastHeartbeatAt: string | null;
}

export interface DesiredState {
  nodeId: string;
  version: number;
  configHash: string;
  config: Record<string, unknown> & { inbounds?: { tag?: string; port?: number; protocol?: string }[] };
  users: { email: string; uuid: string; level: number }[];
  generatedAt: string;
}

export interface Cascade {
  id: string;
  orgId: string;
  kind: "server_forward" | "client_chain";
  cc: string;
  relayNodeId: string | null;
  frontNodeId: string | null;
  exitNodeId: string;
  exitInboundTag: string;
  linkUserUuid: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const getNodes = () => request<Node[]>("/api/admin/nodes");

export const getDesiredState = (nodeId: string) =>
  request<DesiredState>(`/api/admin/nodes/${nodeId}/desired-state`);

export const rebuildNode = (nodeId: string) =>
  request<{ changed: boolean; version: number; hash: string }>(`/api/admin/nodes/${nodeId}/rebuild`, post());

export const getCascades = () => request<Cascade[]>("/api/admin/cascades");

export const createCascade = (body: {
  kind: "server_forward" | "client_chain";
  cc: string;
  exitNodeId: string;
  exitInboundTag: string;
  relayNodeId?: string;
  frontNodeId?: string;
}) => request<Cascade | null>("/api/admin/cascades", post(body));

export const refreshCascade = (id: string) =>
  request<Cascade | null>(`/api/admin/cascades/${id}/refresh`, post());

// --- Подписчики -------------------------------------------------------------

export interface Subscriber {
  /** id подписки, не подписчика. */
  id: string;
  username: string | null;
  telegramId: number | null;
  status: string;
  expireAt: string | null;
  usedTrafficBytes: number;
}

export interface UsageRow {
  nodeId: string;
  day: string;
  up: number;
  down: number;
}

export const getSubscribers = () => request<Subscriber[]>("/api/admin/subscribers");

export const getUsage = (shortUuid: string) =>
  request<UsageRow[]>(`/api/admin/usage/${encodeURIComponent(shortUuid)}`);

// --- Поддержка --------------------------------------------------------------

export const CONVERSATION_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface ConversationListItem {
  id: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  tags: string[];
  lastMessageAt: string | null;
  createdAt: string;
  contact: { id: string; telegramUserId: number; username: string | null } | null;
}

export interface ConversationMessage {
  id: string;
  direction: "in" | "out";
  senderType: string;
  senderUserId: string | null;
  content: string;
  deliveryStatus: string;
  error: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  aiMode: string;
  tags: string[];
  lastMessageAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact: {
    id: string;
    telegramUserId: number;
    username: string | null;
    languageCode: string | null;
    subscriberId: string | null;
  } | null;
  messages: ConversationMessage[];
}

export const getConversations = (status?: string) =>
  request<ConversationListItem[]>(
    `/api/admin/support/conversations${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  );

export const getConversation = (id: string) =>
  request<Conversation>(`/api/admin/support/conversations/${id}`);

export const replyToConversation = (id: string, text: string) =>
  request<{ messageId: string; deduped: boolean; delivered: boolean; reason?: string }>(
    `/api/admin/support/conversations/${id}/reply`,
    post({ text }),
  );

export const patchConversation = (id: string, body: { status?: string; assigneeUserId?: string | null }) =>
  request<Conversation | null>(`/api/admin/support/conversations/${id}`, patch(body));

// --- Продажи: воронка и кампании --------------------------------------------

export interface CampaignLink {
  id: string;
  campaignId: string;
  code: string;
  label: string | null;
  isArchived: boolean;
  registrations: number;
  payingUsers: number;
  revenueKopeks: number;
  createdAt: string;
}

export interface Campaign {
  id: string;
  slug: string;
  name: string;
  channel: string | null;
  status: string;
  costKopeks: number;
  createdAt: string;
  links: CampaignLink[];
}

export interface CampaignStats {
  campaign: Omit<Campaign, "links">;
  links: {
    id: string;
    code: string;
    label: string | null;
    isArchived: boolean;
    registrations: number;
    payments: number;
    payingUsers: number;
    revenueKopeks: number;
  }[];
  total: {
    registrations: number;
    payingUsers: number;
    revenueKopeks: number;
    costKopeks: number;
    profitKopeks: number;
    conversion: number;
    cpaKopeks: number | null;
  };
}

export interface Funnel {
  from: string;
  days: number;
  stages: { key: string; users: number; events: number }[];
  revenueKopeks: number;
  startToPaid: number;
  daily: { date: string; newSubscribers: number; payments: number; revenueKopeks: number }[];
}

export const getCampaigns = () => request<Campaign[]>("/api/admin/campaigns");

export const createCampaign = (body: { slug: string; name: string; channel?: string; costKopeks?: number }) =>
  request<Campaign>("/api/admin/campaigns", post(body));

export const updateCampaign = (
  id: string,
  body: { name?: string; channel?: string; status?: string; costKopeks?: number },
) => request<Campaign>(`/api/admin/campaigns/${id}`, patch(body));

export const createCampaignLink = (id: string, label?: string) =>
  request<CampaignLink & { startPayload: string }>(`/api/admin/campaigns/${id}/links`, post({ label }));

export const getCampaignStats = (id: string) => request<CampaignStats>(`/api/admin/campaigns/${id}/stats`);

export const getFunnel = (days: number) => request<Funnel>(`/api/admin/funnel?days=${days}`);

// --- Рассылки и триггерные касания ------------------------------------------

export const SEGMENT_KINDS = ["all", "active", "inactive", "expiring", "segment"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface Broadcast {
  id: string;
  title: string;
  segmentKind: string;
  segmentId: string | null;
  bodyHtml: string;
  imageFileId: string | null;
  buttons: Record<string, unknown>[];
  status: string;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  throttlePerSec: number;
  createdAt: string;
  updatedAt: string;
  stats: { pending: number; sent: number; failed: number; skipped: number; total: number };
}

export interface Touchpoint {
  id: string;
  name: string;
  triggerType: string;
  triggerKey: string;
  delayHours: number;
  bodyHtml: string;
  buttons: Record<string, unknown>[];
  quietHours: { from: number; to: number } | null;
  isActive: boolean;
  createdAt: string;
}

export const getBroadcasts = () => request<Broadcast[]>("/api/admin/broadcasts");

export const getBroadcast = (id: string) => request<Broadcast>(`/api/admin/broadcasts/${id}`);

export const createBroadcast = (body: {
  title: string;
  segmentKind: SegmentKind;
  segmentId?: string;
  bodyHtml: string;
  throttlePerSec?: number;
  expiringDays?: number;
}) => request<{ broadcast: Omit<Broadcast, "stats">; recipients: number }>("/api/admin/broadcasts", post(body));

export const runBroadcast = (id: string) =>
  request<{ started: boolean }>(`/api/admin/broadcasts/${id}/run`, post());

export const cancelBroadcast = (id: string) =>
  request<{ ok: boolean; reason?: string }>(`/api/admin/broadcasts/${id}/cancel`, post());

export const getTouchpoints = () => request<Touchpoint[]>("/api/admin/touchpoints");

export const createTouchpoint = (body: {
  name: string;
  triggerKey: string;
  triggerType?: string;
  delayHours?: number;
  bodyHtml: string;
  isActive?: boolean;
}) => request<Touchpoint>("/api/admin/touchpoints", post(body));

export const updateTouchpoint = (
  id: string,
  body: {
    name?: string;
    triggerKey?: string;
    triggerType?: string;
    delayHours?: number;
    bodyHtml?: string;
    isActive?: boolean;
  },
) => request<Touchpoint>(`/api/admin/touchpoints/${id}`, patch(body));

// --- Тарифы -----------------------------------------------------------------

export interface Plan {
  id: string;
  code: string;
  title: string;
  periodDays: number;
  priceKopeks: number;
  trafficGb: number | null;
  deviceLimit: number | null;
  isTrial: boolean;
  isActive: boolean;
  sortOrder: number;
  squadIds: string[];
}

export const getPlans = () => request<Plan[]>("/v1/plans");
