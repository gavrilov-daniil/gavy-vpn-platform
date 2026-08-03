import { ForbiddenException, SetMetadata } from "@nestjs/common";

/**
 * Роли операторов админки. Вложенность линейная: каждая следующая умеет всё, что
 * предыдущая, плюс своё. Плоский набор прав на три роли и полтора десятка экранов —
 * абстракция дороже задачи.
 *
 *   support     — переписка с клиентами и просмотр их подписок;
 *   admin       — всё, кроме платёжных мерчантов;
 *   superadmin  — всё, включая ключи платёжных провайдеров.
 */
export const ADMIN_ROLES = ["support", "admin", "superadmin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const RANK: Record<AdminRole, number> = { support: 1, admin: 2, superadmin: 3 };

/** Роль по умолчанию для маршрута без @MinRole: доступ шире надо разрешать явно. */
export const DEFAULT_MIN_ROLE: AdminRole = "admin";

export const MIN_ROLE_METADATA = "corelink:min-role";

/** Маршрут без сессии. Значение живёт в тех же метаданных, что и роль: механизм один. */
const PUBLIC_ROUTE = "public";

export type RouteAccess = AdminRole | typeof PUBLIC_ROUTE;

/** Минимальная роль для маршрута. Ставится на класс контроллера или на отдельный хендлер. */
export const MinRole = (role: AdminRole) => SetMetadata(MIN_ROLE_METADATA, role);

/**
 * Маршрут под `/api/admin/*`, доступный без сессии. Ровно три таких: вход по паролю,
 * вход по Telegram и конфиг кнопки Telegram — без них форму входа не нарисовать.
 */
export const PublicRoute = () => SetMetadata(MIN_ROLE_METADATA, PUBLIC_ROUTE);

export const isPublicRoute = (access: RouteAccess): access is typeof PUBLIC_ROUTE => access === PUBLIC_ROUTE;

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(actual: string, required: AdminRole): boolean {
  if (!isAdminRole(actual)) return false;
  return RANK[actual] >= RANK[required];
}

/**
 * Оператор запроса. Пробрасывается гвардом в req.operator и достаётся @Operator().
 * Поля профиля кладёт туда же гвард — он всё равно читает учётку, резолвя сессию.
 */
export interface OperatorContext {
  /** null у переходного общего ADMIN_TOKEN: за ним нет учётки. */
  operatorId: string | null;
  email: string | null;
  displayName: string | null;
  telegramUsername: string | null;
  role: AdminRole;
  hasPassword: boolean;
  hasTelegram: boolean;
  /** Вход по общему ADMIN_TOKEN — операции «от имени себя» для него недоступны. */
  viaSharedToken: boolean;
}

/** Действия над своей учёткой требуют учётки: у входа по общему токену её нет. */
export function requireOwnOperatorId(actor: OperatorContext): string {
  if (!actor.operatorId) throw new ForbiddenException("у входа по общему токену нет своей учётки");
  return actor.operatorId;
}
