/**
 * Правила доступа в админку: кто кого заводит, кто что видит, кого нельзя разжаловать.
 *
 * Проверяется вместе с гвардом, а не только сервис: роль спрашивают именно на гварде,
 * и «сервис запретил бы» ничего не значит для маршрута, который до сервиса не доходит.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { cleanupOrg, closeDb, openDb, telegramWidgetPayload, TEST_ORG_ID } from "../testing/fixtures.test.js";
import { AdminGuard } from "../common/admin.guard.js";
import { AuthService } from "./auth.service.js";
import { TelegramAuthService, type TelegramLoginPayload } from "./telegram-auth.service.js";
import { MIN_ROLE_METADATA, type AdminRole, type OperatorContext } from "./roles.js";

const BOT_TOKEN = "123456:AAH-fake-bot-token-for-tests";
const PASSWORD = "correct-horse-battery";

let db: Database;
let telegram: TelegramAuthService;
let auth: AuthService;
let guard: AdminGuard;

/** Актор «изнутри»: гвард собирает такой же по сессии или общему ADMIN_TOKEN. */
const actorOf = (role: AdminRole, operatorId: string | null, email: string | null = null): OperatorContext => ({
  operatorId,
  email,
  displayName: null,
  telegramUsername: null,
  role,
  hasPassword: false,
  hasTelegram: false,
  viaSharedToken: operatorId === null,
});

const SHARED_TOKEN_ACTOR = actorOf("superadmin", null);

const signPayload = (fields: Omit<TelegramLoginPayload, "hash">): TelegramLoginPayload =>
  telegramWidgetPayload(fields as Record<string, string | number>, BOT_TOKEN) as unknown as TelegramLoginPayload;

const freshPayload = (telegramId: number, username: string) =>
  signPayload({ id: telegramId, auth_date: Math.floor(Date.now() / 1000), first_name: "Оператор", username });

/** Контекст запроса с требуемой ролью на хендлере — ровно то, что читает гвард. */
function contextFor(token: string, minRole?: AdminRole, path = "/api/admin/merchants"): ExecutionContext {
  const handler = () => {};
  if (minRole) Reflect.defineMetadata(MIN_ROLE_METADATA, minRole, handler);
  const req = { path, headers: { "x-admin-token": token } } as unknown as Request;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class Dummy {},
  } as unknown as ExecutionContext;
}

before(async () => {
  db = openDb();
  telegram = new TelegramAuthService(db);
  auth = new AuthService(db, telegram);
  guard = new AdminGuard(auth, new Reflector());
  await telegram.updateSettings({ isEnabled: true, botUsername: "corelink_admin_bot", botToken: BOT_TOKEN });
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

describe("заявка на доступ из Telegram", () => {
  it("незнакомый аккаунт получает заявку, а не доступ", async () => {
    const result = await auth.loginWithTelegram({ payload: freshPayload(9_000_001, "newcomer") });

    assert.equal(result.status, "pending");
    assert.equal("token" in result, false, "сессия неподтверждённому не выдаётся");

    const rows = await auth.listOperators();
    const created = rows.find((r) => r.telegramId === 9_000_001);
    assert.ok(created, "заявка обязана быть видна админу — иначе её нечем подтвердить");
    assert.equal(created.status, "pending");
  });

  it("повторный вход не плодит заявок", async () => {
    await auth.loginWithTelegram({ payload: freshPayload(9_000_001, "newcomer") });

    const rows = (await auth.listOperators()).filter((r) => r.telegramId === 9_000_001);
    assert.equal(rows.length, 1);
  });

  it("подтверждённый входит и получает сессию с назначенной ролью", async () => {
    const pending = (await auth.listOperators()).find((r) => r.telegramId === 9_000_001)!;
    await auth.approveOperator(pending.id, "support", SHARED_TOKEN_ACTOR);

    const result = await auth.loginWithTelegram({ payload: freshPayload(9_000_001, "newcomer") });
    assert.ok(result.status === "ok");

    const session = await auth.resolveSession(result.token);
    assert.equal(session?.role, "support");
  });

  it("отключённой учётке отвечаем отказом, а не заявкой", async () => {
    const target = (await auth.listOperators()).find((r) => r.telegramId === 9_000_001)!;
    await auth.updateOperator(target.id, { status: "disabled" }, SHARED_TOKEN_ACTOR);

    await assert.rejects(
      () => auth.loginWithTelegram({ payload: freshPayload(9_000_001, "newcomer") }),
      /доступ отключён/,
    );

    await auth.updateOperator(target.id, { status: "active" }, SHARED_TOKEN_ACTOR);
  });

  it("устаревшая подпись не принимается", async () => {
    const stale = signPayload({ id: 9_000_002, auth_date: Math.floor(Date.now() / 1000) - 3600, first_name: "Старый" });

    await assert.rejects(() => auth.loginWithTelegram({ payload: stale }), /устарели/);
  });
});

describe("заведение учёток", () => {
  it("admin не выдаёт роль выше своей", async () => {
    const admin = await auth.createOperator(
      { email: "admin1@example.org", password: PASSWORD, role: "admin" },
      SHARED_TOKEN_ACTOR,
    );

    await assert.rejects(
      () =>
        auth.createOperator(
          { email: "escalated@example.org", password: PASSWORD, role: "superadmin" },
          actorOf("admin", admin.id, admin.email),
        ),
      /выше своей/,
    );
  });

  it("повторный email не заводит вторую учётку", async () => {
    await assert.rejects(
      () => auth.createOperator({ email: "admin1@example.org", password: PASSWORD }, SHARED_TOKEN_ACTOR),
      /уже есть/,
    );
  });

  it("короткий пароль не принимается", async () => {
    await assert.rejects(
      () => auth.createOperator({ email: "weak@example.org", password: "123" }, SHARED_TOKEN_ACTOR),
      /пароль/,
    );
  });

  it("смена пароля рубит живые сессии", async () => {
    const created = await auth.createOperator(
      { email: "rotate@example.org", password: PASSWORD, role: "support" },
      SHARED_TOKEN_ACTOR,
    );
    const login = await auth.login({ email: "rotate@example.org", password: PASSWORD });
    assert.ok(await auth.resolveSession(login.token));

    await auth.changePassword(created.id, `${PASSWORD}-2`, SHARED_TOKEN_ACTOR);

    assert.equal(await auth.resolveSession(login.token), null, "старый токен обязан умереть вместе с паролем");
  });
});

describe("защита от потери доступа", () => {
  it("последнего superadmin'а нельзя ни разжаловать, ни отключить", async () => {
    const only = await auth.createOperator(
      { email: "root@example.org", password: PASSWORD, role: "superadmin" },
      SHARED_TOKEN_ACTOR,
    );

    await assert.rejects(
      () => auth.updateOperator(only.id, { role: "admin" }, SHARED_TOKEN_ACTOR),
      /последний superadmin/,
    );
    await assert.rejects(
      () => auth.updateOperator(only.id, { status: "disabled" }, SHARED_TOKEN_ACTOR),
      /последний superadmin/,
    );
  });

  it("свою учётку не разжаловать: иначе оператор запирает себя одним кликом", async () => {
    const admin = (await auth.listOperators()).find((r) => r.email === "admin1@example.org")!;

    await assert.rejects(
      () => auth.updateOperator(admin.id, { role: "support" }, actorOf("admin", admin.id, admin.email)),
      /свою учётку/,
    );
  });

  it("единственный способ входа не отбирается", async () => {
    const tgOnly = (await auth.listOperators()).find((r) => r.telegramId === 9_000_001)!;
    assert.equal(tgOnly.hasPassword, false);

    await assert.rejects(() => auth.unlinkTelegram(tgOnly.id, SHARED_TOKEN_ACTOR), /единственный способ входа/);
  });

  it("привязанный Telegram не переезжает на чужую учётку", async () => {
    const admin = (await auth.listOperators()).find((r) => r.email === "admin1@example.org")!;

    await assert.rejects(
      () => auth.linkTelegram(freshPayload(9_000_001, "newcomer"), actorOf("admin", admin.id, admin.email)),
      /уже привязан/,
    );
  });

  it("свободный Telegram привязывается и открывает второй способ входа", async () => {
    const admin = (await auth.listOperators()).find((r) => r.email === "admin1@example.org")!;
    await auth.linkTelegram(freshPayload(9_000_055, "admin_tg"), actorOf("admin", admin.id, admin.email));

    const result = await auth.loginWithTelegram({ payload: freshPayload(9_000_055, "admin_tg") });
    assert.ok(result.status === "ok");
    assert.equal(result.operator.id, admin.id, "вход по Telegram обязан вести в ту же учётку");
  });
});

describe("гвард: роль спрашивается на маршруте", () => {
  it("сессия support не открывает раздел мерчантов", async () => {
    const support = (await auth.listOperators()).find((r) => r.email === "rotate@example.org")!;
    await auth.changePassword(support.id, PASSWORD, SHARED_TOKEN_ACTOR);
    const login = await auth.login({ email: "rotate@example.org", password: PASSWORD });

    await assert.rejects(
      () => guard.canActivate(contextFor(login.token, "superadmin")),
      /недостаточно прав/,
      "ключи платёжных провайдеров закрыты от всех, кроме superadmin",
    );

    assert.equal(
      await guard.canActivate(contextFor(login.token, "support", "/api/admin/support/conversations")),
      true,
    );
  });

  it("маршрут без @MinRole закрыт от support: умолчание — admin", async () => {
    const login = await auth.login({ email: "rotate@example.org", password: PASSWORD });

    await assert.rejects(
      () => guard.canActivate(contextFor(login.token, undefined, "/api/admin/broadcasts")),
      /недостаточно прав/,
    );
  });

  it("отключённая учётка теряет доступ немедленно, по живому токену", async () => {
    const login = await auth.login({ email: "rotate@example.org", password: PASSWORD });
    const support = (await auth.listOperators()).find((r) => r.email === "rotate@example.org")!;

    await auth.updateOperator(support.id, { status: "disabled" }, SHARED_TOKEN_ACTOR);

    await assert.rejects(
      () => guard.canActivate(contextFor(login.token, "support", "/api/admin/support/conversations")),
      /невалидный admin token/,
    );
  });

  it("маршруты вне /api/admin гвард не трогает", async () => {
    assert.equal(await guard.canActivate(contextFor("", "superadmin", "/healthz")), true);
  });
});

describe("настройки входа по Telegram", () => {
  it("токен бота наружу не отдаётся", async () => {
    const settings = await telegram.settingsForAdmin();

    assert.equal(settings.hasBotToken, true);
    assert.equal((settings as Record<string, unknown>).botToken, undefined);
  });

  it("в БД токен лежит зашифрованным", async () => {
    // Фильтр по org обязателен: в dev-базе лежит и настоящая строка настроек.
    const [row] = await db
      .select()
      .from(schema.telegramAuthSetting)
      .where(eq(schema.telegramAuthSetting.orgId, TEST_ORG_ID));

    assert.notEqual(row.botToken, BOT_TOKEN);
    assert.ok(row.botToken.startsWith("v1."), "формат шифртекста тот же, что у кредов мерчантов");
  });

  it("включить без токена нельзя", async () => {
    await assert.rejects(() => telegram.updateSettings({ isEnabled: true, botToken: "" }), /нужны username/);
  });

  it("выключённый вход по Telegram не пускает даже с верной подписью", async () => {
    await telegram.updateSettings({ isEnabled: false });

    await assert.rejects(
      () => auth.loginWithTelegram({ payload: freshPayload(9_000_001, "newcomer") }),
      /выключен/,
    );

    await telegram.updateSettings({ isEnabled: true });
  });
});
