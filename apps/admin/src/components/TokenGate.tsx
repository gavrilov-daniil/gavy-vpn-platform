import { useState, type FormEvent, type ReactNode } from "react";
import { clearAdminToken, getAdminToken, setAdminToken } from "../api";
import Field from "./Field";

interface Props {
  children: ReactNode;
}

/**
 * Вход в админку: core требует заголовок x-admin-token на всех /api/admin/*.
 * В поле вводится либо токен сессии оператора (его отдаёт POST /api/admin/auth/login),
 * либо переходный общий ADMIN_TOKEN. Формы логина по email/паролю здесь пока нет.
 */
export default function TokenGate({ children }: Props) {
  const [token, setToken] = useState(getAdminToken);
  const [draft, setDraft] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setAdminToken(value);
    setToken(value);
    setDraft("");
  };

  if (!token) {
    return (
      <div className="login-screen">
        <form className="card login-card" onSubmit={submit}>
          <div className="card-head">
            <div className="card-title">VPN Admin</div>
          </div>
          <div className="card-body">
            <Field label="Админский токен" hint="Значение ADMIN_TOKEN сервиса core">
              <input
                type="password"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                placeholder="x-admin-token"
              />
            </Field>
            <button type="submit" className="btn btn-primary" disabled={draft.trim().length === 0}>
              Войти
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <>
      {children}
      <button
        type="button"
        className="btn btn-sm logout-btn"
        onClick={() => {
          clearAdminToken();
          setToken("");
        }}
      >
        Сменить токен
      </button>
    </>
  );
}
