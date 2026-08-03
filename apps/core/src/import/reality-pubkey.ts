import { createPrivateKey, createPublicKey } from "node:crypto";

/**
 * Публичная часть Reality из приватника, который отдаёт Remnawave.
 *
 * Зачем вообще: ни `/api/hosts`, ни `/api/config-profiles` не отдают `publicKey` —
 * панель выводит его на лету при сборке подписки. А `pbk` зашит в конфигах живых
 * клиентов: ошибись в нём — и клиент молча перестанет коннектиться. Единственный
 * способ перенести его дословно — повторить тот же вывод из приватника.
 *
 * Приватник при этом остаётся в памяти процесса на время импорта и в БД не попадает
 * (см. `stripRealityPrivateKey`): он живёт на ноде, агент подставляет его сам.
 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function realityPublicKey(privateKey: string): string | null {
  const raw = Buffer.from(privateKey, "base64url");
  if (raw.length !== 32) return null;
  try {
    const key = createPrivateKey({
      key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(key).export({ format: "der", type: "spki" });
    return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
  } catch {
    return null;
  }
}

/**
 * Копия сырого inbound'а без приватника — то, что допустимо положить в `inbound.raw_json`.
 * Сырой ответ панели хранится для аудита, но секрет в него попасть не должен: строка
 * в БД переживёт и бэкапы, и выгрузки, и чужие глаза в админке.
 */
export function stripRealityPrivateKey<T>(raw: T): T {
  const clone = structuredClone(raw) as { streamSettings?: { realitySettings?: Record<string, unknown> } };
  const reality = clone?.streamSettings?.realitySettings;
  if (reality && "privateKey" in reality) delete reality.privateKey;
  return clone as T;
}
