import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Шифрование кредов мерчантов (AES-256-GCM). Ключ — из env/vault, НЕ из БД.
 * Модель угроз честная: ключ и шифртекст на одном боксе, поэтому это защита от
 * дампа БД / бэкапа / случайного попадания в лог, а НЕ от компрометации хоста.
 */
const ALGO = "aes-256-gcm";
const VERSION = "v1";

export function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey).digest();
}

export function encryptSecret(plain: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(masterKey), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(payload: string, masterKey: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== VERSION) throw new Error(`unsupported secret version: ${version}`);
  const decipher = createDecipheriv(ALGO, deriveKey(masterKey), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}

export function encryptCredentials(creds: Record<string, string>, masterKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = isEncrypted(v) ? v : encryptSecret(v, masterKey);
  return out;
}

export function decryptCredentials(creds: Record<string, string>, masterKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = isEncrypted(v) ? decryptSecret(v, masterKey) : v;
  return out;
}

/**
 * Сравнение подписей вебхуков. Всегда constant-time и с проверкой длины:
 * timingSafeEqual бросает на разной длине, поэтому длину сверяем заранее.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Маскирование кредов для показа в админке — значения наружу не отдаём. */
export function maskCredentialsForDisplay(creds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(creds)) out[k] = "••••••••";
  return out;
}
