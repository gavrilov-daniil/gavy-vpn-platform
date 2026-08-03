import { createContext, useContext } from "react";
import type { AdminRole, Me } from "./api";

const RANK: Record<AdminRole, number> = { support: 1, admin: 2, superadmin: 3 };

/**
 * Та же вложенность ролей, что в core. Копия неизбежна — общего пакета для браузера
 * в репозитории нет, — но копия должна быть одна на всю админку.
 */
export function roleAtLeast(actual: AdminRole, required: AdminRole): boolean {
  return RANK[actual] >= RANK[required];
}

export interface SessionValue {
  me: Me;
  reload: () => void;
  signOut: () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

/**
 * Сессия текущего оператора. Доступна только под AuthGate — вне него дерева нет
 * и рисовать нечего.
 */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession вызван вне AuthGate");
  return value;
}

/**
 * Прячет то, на что у роли нет прав. Это только UI: настоящий барьер — гвард на
 * стороне core, который спрашивает роль на каждом запросе.
 */
export function useCan(role: AdminRole): boolean {
  const { me } = useSession();
  return roleAtLeast(me.role, role);
}
