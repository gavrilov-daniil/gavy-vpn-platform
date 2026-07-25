import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

const scrypt = promisify(scryptCb);

/** Срок жизни сессии. Короче — оператор злится, длиннее — украденный токен живёт дольше. */
const SESSION_TTL_MS = 7 * 24 * 3600_000;

/**
 * Учётки операторов админки.
 *
 * Пароли — scrypt со случайной солью: он memory-hard, поэтому перебор дампа
 * дороже, чем при sha256/pbkdf2. Внешних зависимостей (argon2/bcrypt) не тянем:
 * scrypt есть в стандартной библиотеке Node.
 *
 * В браузере живёт только случайный токен сессии, в БД — его хеш.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [algo, saltB64, hashB64] = stored.split("$");
    if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, "base64");
    const derived = (await scrypt(password, Buffer.from(saltB64, "base64"), expected.length)) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  async createOperator(input: { email: string; password: string; role?: string }) {
    const [row] = await this.db
      .insert(schema.user)
      .values({
        orgId: this.cfg.defaultOrgId,
        email: input.email.toLowerCase().trim(),
        passwordHash: await this.hashPassword(input.password),
        role: input.role ?? "operator",
        status: "active",
      })
      .returning({ id: schema.user.id, email: schema.user.email, role: schema.user.role });
    return row;
  }

  /**
   * Вход. Ответ одинаков и при неизвестном email, и при неверном пароле —
   * иначе форма входа превращается в список существующих операторов.
   */
  async login(input: { email: string; password: string; userAgent?: string; ip?: string }) {
    const [operator] = await this.db
      .select()
      .from(schema.user)
      .where(
        and(
          eq(schema.user.orgId, this.cfg.defaultOrgId),
          eq(schema.user.email, input.email.toLowerCase().trim()),
          eq(schema.user.status, "active"),
        ),
      )
      .limit(1);

    const ok = operator?.passwordHash ? await this.verifyPassword(input.password, operator.passwordHash) : false;
    if (!ok || !operator) {
      this.log.warn(`неудачный вход: ${input.email}`);
      throw new UnauthorizedException("неверный email или пароль");
    }

    const token = randomBytes(32).toString("base64url");
    await this.db.insert(schema.operatorSession).values({
      orgId: this.cfg.defaultOrgId,
      userId: operator.id,
      tokenHash: hashToken(token),
      userAgent: input.userAgent?.slice(0, 300),
      ip: input.ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      lastSeenAt: new Date(),
    });

    return {
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      operator: { id: operator.id, email: operator.email, role: operator.role },
    };
  }

  /** Проверка сессии на каждом админском запросе. */
  async resolveSession(token: string) {
    const [row] = await this.db
      .select({ session: schema.operatorSession, operator: schema.user })
      .from(schema.operatorSession)
      .innerJoin(schema.user, eq(schema.operatorSession.userId, schema.user.id))
      .where(
        and(
          eq(schema.operatorSession.tokenHash, hashToken(token)),
          isNull(schema.operatorSession.revokedAt),
          gt(schema.operatorSession.expiresAt, new Date()),
          eq(schema.user.status, "active"),
        ),
      )
      .limit(1);

    if (!row) return null;

    // отметка активности раз в минуту, а не на каждый запрос — иначе лишняя запись на каждый клик
    const lastSeen = row.session.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeen > 60_000) {
      await this.db
        .update(schema.operatorSession)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.operatorSession.id, row.session.id));
    }

    return { operatorId: row.operator.id, email: row.operator.email, role: row.operator.role };
  }

  async logout(token: string) {
    await this.db
      .update(schema.operatorSession)
      .set({ revokedAt: new Date() })
      .where(eq(schema.operatorSession.tokenHash, hashToken(token)));
    return { ok: true };
  }

  async listOperators() {
    return this.db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        role: schema.user.role,
        status: schema.user.status,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .where(eq(schema.user.orgId, this.cfg.defaultOrgId));
  }

  /** Отзыв доступа: блокируем учётку и рубим все её живые сессии. */
  async disableOperator(userId: string) {
    await this.db
      .update(schema.user)
      .set({ status: "disabled" })
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.id, userId)));
    await this.db
      .update(schema.operatorSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.operatorSession.userId, userId), isNull(schema.operatorSession.revokedAt)));
    return { ok: true };
  }

  async changePassword(userId: string, newPassword: string) {
    await this.db
      .update(schema.user)
      .set({ passwordHash: await this.hashPassword(newPassword) })
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.id, userId)));
    // старые сессии рубим: смена пароля должна выкидывать чужие устройства
    await this.db
      .update(schema.operatorSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.operatorSession.userId, userId), isNull(schema.operatorSession.revokedAt)));
    return { ok: true };
  }

  /** Чистка протухших сессий — вызывается джобой обслуживания. */
  async purgeExpired(): Promise<number> {
    const deleted = await this.db
      .delete(schema.operatorSession)
      .where(sql`${schema.operatorSession.expiresAt} < now() - interval '30 days'`)
      .returning({ id: schema.operatorSession.id });
    return deleted.length;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
