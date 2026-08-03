import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { decryptSecret, encryptSecret, isEncrypted, safeCompare } from "@corelink/core-kit";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

/** Полезная нагрузка Telegram Login Widget. Виджет отдаёт её как объект в data-onauth. */
export interface TelegramLoginPayload {
  id: number;
  auth_date: number;
  hash: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface TelegramIdentity {
  telegramId: number;
  username: string | null;
  displayName: string | null;
}

/**
 * Окно годности подписи виджета. Виджет отдаёт payload сразу после нажатия, поэтому
 * пять минут — с запасом на медленный ввод пароля в Telegram и расхождение часов.
 * Дольше — украденный из истории браузера payload дольше остаётся ключом от админки.
 */
const AUTH_DATE_MAX_AGE_SEC = 300;
/** Часы клиента и сервера расходятся; отрицательный возраст в пределах минуты не ошибка. */
const AUTH_DATE_MAX_SKEW_SEC = 60;

/**
 * Вход по Telegram: настройки и проверка подписи Login Widget.
 *
 * Подпись — HMAC-SHA256 по строке проверки, ключ — sha256(токен бота). То есть токен
 * бота здесь не «доступ к API», а ключ проверки подлинности входа: его утечка позволяет
 * подделать вход любым telegram_id. Поэтому в БД он лежит зашифрованным (AES-256-GCM
 * на SECRETS_MASTER_KEY, тот же механизм, что у кредов мерчантов), а наружу отдаётся
 * только признак «задан».
 */
@Injectable()
export class TelegramAuthService {
  private readonly log = new Logger(TelegramAuthService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  private async row() {
    const [row] = await this.db
      .select()
      .from(schema.telegramAuthSetting)
      .where(eq(schema.telegramAuthSetting.orgId, this.cfg.defaultOrgId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Публичная часть: по ней страница входа решает, рисовать ли кнопку Telegram.
   * Включённой настройка считается только вместе с username и токеном — тот же
   * инвариант, что проверяет `updateSettings` на записи.
   */
  async publicConfig(): Promise<{ enabled: boolean; botUsername: string }> {
    const row = await this.row();
    if (!row?.isEnabled || !row.botUsername || !row.botToken) return { enabled: false, botUsername: "" };
    return { enabled: true, botUsername: row.botUsername };
  }

  /** Для админки: токен наружу не отдаём, только факт его наличия. */
  async settingsForAdmin() {
    return forAdmin(await this.row());
  }

  /**
   * Правка настроек. `botToken` не передан — не трогаем; пустая строка — стираем.
   * Ровно как у кредов мерчантов: иначе замаскированное значение из формы затирало бы секрет.
   */
  async updateSettings(input: { isEnabled?: boolean; botUsername?: string; botToken?: string }) {
    const current = await this.row();

    const botUsername = normalizeUsername(input.botUsername ?? current?.botUsername ?? "");
    const isEnabled = input.isEnabled ?? current?.isEnabled ?? false;
    let botToken = current?.botToken ?? "";
    if (input.botToken !== undefined) {
      const raw = input.botToken.trim();
      botToken = raw === "" ? "" : encryptSecret(raw, this.cfg.secretsMasterKey);
    }

    if (isEnabled && (!botUsername || !botToken)) {
      throw new BadRequestException("для включения входа по Telegram нужны username бота и его токен");
    }

    const updatedAt = new Date();
    if (current) {
      await this.db
        .update(schema.telegramAuthSetting)
        .set({ isEnabled, botUsername, botToken, updatedAt })
        .where(eq(schema.telegramAuthSetting.id, current.id));
    } else {
      await this.db
        .insert(schema.telegramAuthSetting)
        .values({ orgId: this.cfg.defaultOrgId, isEnabled, botUsername, botToken, updatedAt });
    }

    return forAdmin({ isEnabled, botUsername, botToken, updatedAt });
  }

  /**
   * Проверка входа. Возвращает личность из Telegram; всё, что не сошлось —
   * исключение с одинаково неинформативным текстом: подсказывать перебирающему,
   * какая именно часть подписи не сошлась, незачем.
   */
  async verifyLogin(payload: TelegramLoginPayload): Promise<TelegramIdentity> {
    const row = await this.row();
    if (!row?.isEnabled || !row.botToken) throw new BadRequestException("вход по Telegram выключен");

    let botToken: string;
    try {
      botToken = isEncrypted(row.botToken) ? decryptSecret(row.botToken, this.cfg.secretsMasterKey) : row.botToken;
    } catch {
      // Сменили SECRETS_MASTER_KEY или подняли дамп со старым ключом: токен нечитаем.
      this.log.error("токен бота не расшифровывается — вход по Telegram нерабочий, введите токен заново");
      throw new BadRequestException("вход по Telegram не настроен");
    }

    if (!verifyWidgetHash(payload, botToken)) {
      this.log.warn(`подпись Telegram не сошлась, telegram_id ${payload?.id}`);
      throw new BadRequestException("подпись Telegram не подтверждена");
    }

    const age = Math.floor(Date.now() / 1000) - Number(payload.auth_date);
    if (!Number.isFinite(age) || age > AUTH_DATE_MAX_AGE_SEC || age < -AUTH_DATE_MAX_SKEW_SEC) {
      throw new BadRequestException("данные входа устарели, попробуйте ещё раз");
    }

    const displayName = [payload.first_name, payload.last_name].filter(Boolean).join(" ").trim();
    return {
      telegramId: Number(payload.id),
      username: payload.username ? payload.username.replace(/^@/, "") : null,
      displayName: displayName || null,
    };
  }
}

/**
 * Проверка подписи Login Widget по документации Telegram: строка проверки — все поля,
 * кроме hash, отсортированные по имени, в виде `key=value` через \n; ключ HMAC —
 * sha256(токен бота). Сравнение — тем же `safeCompare`, что и подписи вебхуков
 * провайдеров: constant-time и с проверкой длины внутри.
 */
export function verifyWidgetHash(payload: TelegramLoginPayload, botToken: string): boolean {
  const hash = typeof payload?.hash === "string" ? payload.hash.toLowerCase() : "";

  const checkString = Object.entries(payload)
    .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join("\n");

  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");
  return safeCompare(expected, hash);
}

/** Проекция настроек наружу: сам токен не отдаём никогда, только факт его наличия. */
function forAdmin(row: { isEnabled: boolean; botUsername: string; botToken: string; updatedAt: Date } | null) {
  return {
    isEnabled: row?.isEnabled ?? false,
    botUsername: row?.botUsername ?? "",
    hasBotToken: Boolean(row?.botToken),
    updatedAt: row?.updatedAt ?? null,
  };
}

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "");
}
