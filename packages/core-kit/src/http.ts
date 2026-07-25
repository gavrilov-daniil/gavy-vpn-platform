import { maskBody, maskHeaders, maskUrl } from "./mask.js";

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** JSON-тело. Взаимоисключимо с form/raw. */
  json?: unknown;
  /** application/x-www-form-urlencoded (Pal24 требует именно его). */
  form?: Record<string, string | number>;
  raw?: string;
  timeoutMs?: number;
  retries?: number;
  provider?: string;
  correlationId?: string;
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  rawBody: string;
  attempts: number;
  durationMs: number;
}

export interface AuditRecord {
  provider: string;
  endpoint: string;
  method: string;
  requestBody: unknown;
  responseBody: unknown;
  statusCode: number | null;
  durationMs: number;
  attempts: number;
  correlationId?: string;
  errorMessage?: string;
}

/** Приёмник аудита — пишет в external_api_log. Подставляется приложением. */
export type AuditSink = (record: AuditRecord) => void | Promise<void>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;

let auditSink: AuditSink | null = null;
export function setAuditSink(sink: AuditSink | null): void {
  auditSink = sink;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Единственная точка исходящих HTTP-вызовов.
 * Ретраи с экспоненциальным бэкоффом + джиттер, уважение Retry-After,
 * аудит каждого вызова с маскированием секретов.
 * Джиттер обязателен: без него N воркеров ретраятся синхронно и добивают лежащего провайдера.
 */
export async function request<T = unknown>(url: string, opts: HttpRequestOptions = {}): Promise<HttpResult<T>> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = (opts.retries ?? DEFAULT_RETRIES) + 1;
  const startedAt = Date.now();

  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["content-type"] ??= "application/json";
  } else if (opts.form) {
    body = new URLSearchParams(
      Object.entries(opts.form).map(([k, v]) => [k, String(v)]),
    ).toString();
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  } else if (opts.raw !== undefined) {
    body = opts.raw;
  }

  let attempt = 0;
  let lastError: unknown;
  let lastStatus: number | null = null;
  let lastRawBody = "";

  while (attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);
      lastStatus = res.status;
      lastRawBody = await res.text();

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")));
        continue;
      }

      const parsed = parseBody<T>(lastRawBody, res.headers.get("content-type"));
      const result: HttpResult<T> = {
        status: res.status,
        body: parsed,
        rawBody: lastRawBody,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };

      void audit(opts, url, method, parsed, res.status, result.durationMs, attempt);

      if (res.status >= 400) {
        throw new HttpError(`${opts.provider ?? "http"} ${method} ${maskUrl(url)} → ${res.status}`, res.status, parsed);
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      lastError = err;
      if (attempt >= maxAttempts) break;
      await sleep(backoffMs(attempt, null));
    }
  }

  const durationMs = Date.now() - startedAt;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  void audit(opts, url, method, lastRawBody, lastStatus, durationMs, attempt, message);
  throw new HttpError(`${opts.provider ?? "http"} ${method} ${maskUrl(url)} failed: ${message}`, lastStatus);
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  const base = Math.min(2 ** (attempt - 1) * 500, 8_000);
  return base + Math.floor(Math.random() * 250);
}

function parseBody<T>(raw: string, contentType: string | null): T {
  if (!raw) return undefined as T;
  if (contentType?.includes("application/json") || raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }
  return raw as T;
}

async function audit(
  opts: HttpRequestOptions,
  url: string,
  method: string,
  responseBody: unknown,
  statusCode: number | null,
  durationMs: number,
  attempts: number,
  errorMessage?: string,
): Promise<void> {
  if (!auditSink) return;
  try {
    await auditSink({
      provider: opts.provider ?? "unknown",
      endpoint: maskUrl(url),
      method,
      requestBody: maskBody(opts.json ?? opts.form ?? opts.raw ?? null),
      responseBody: maskBody(responseBody),
      statusCode,
      durationMs,
      attempts,
      correlationId: opts.correlationId,
      errorMessage,
    });
  } catch {
    // аудит не должен ронять бизнес-вызов
  }
}

export { maskBody, maskHeaders, maskUrl };
