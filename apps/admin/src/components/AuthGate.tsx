import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import logoLight from "@corelink/ui/assets/logo-lockup.svg";
import {
  ApiError,
  clearAdminToken,
  errorMessage,
  getAdminToken,
  getMe,
  getTelegramLoginConfig,
  loginWithPassword,
  loginWithTelegram,
  logout,
  setAdminToken,
  type Me,
} from "../api";
import { useResource } from "../useResource";
import { SessionContext } from "../session";
import Field from "./Field";
import ErrorBox from "./ErrorBox";
import Loading from "./Loading";
import TelegramLoginButton from "./TelegramLoginButton";

/**
 * Вход в админку и контекст сессии.
 *
 * Токен сессии живёт в localStorage и уходит заголовком x-admin-token; кто им владеет
 * и что ему можно — решает core, здесь мы только показываем то, что роль позволяет.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getAdminToken()));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getAdminToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setMe(await getMe());
      setError(null);
    } catch (e) {
      // Протухшая или отозванная сессия — не ошибка экрана, а повод показать вход.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearAdminToken();
        setMe(null);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(() => {
    void logout().catch(() => undefined);
    clearAdminToken();
    setMe(null);
  }, []);

  if (loading) return <Loading />;

  if (!me) {
    return (
      <div className="login-screen">
        <div>
          <div className="login-brand">
            <img src={logoLight} alt="CoreLink" />
          </div>
          <LoginScreen
          initialError={error}
            onToken={(token) => {
              setAdminToken(token);
              void load();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={{ me, reload: () => void load(), signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

function LoginScreen({ onToken, initialError }: { onToken: (token: string) => void; initialError: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  const [serviceToken, setServiceToken] = useState("");
  // Настройки входа не должны мешать входу: не отдались — просто нет кнопки Telegram.
  const telegram = useResource(getTelegramLoginConfig).data ?? { enabled: false, botUsername: "" };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await loginWithPassword(email.trim(), password);
      onToken(result.token);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card login-card" onSubmit={submitPassword}>
      <div className="card-head">
        <div className="card-title">Вход в панель</div>
      </div>
      <div className="card-body">
        {error && <ErrorBox error={error} />}
        {pending && (
          <p className="notice">
            Заявка отправлена. Доступ появится, когда её подтвердит администратор — войдите ещё раз после этого.
          </p>
        )}

        <Field label="Email">
          <input
            type="email"
            value={email}
            autoFocus
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="operator@example.org"
          />
        </Field>
        <Field label="Пароль">
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
          {busy ? "Входим…" : "Войти"}
        </button>

        {telegram.enabled && (
          <div className="login-alt">
            <span className="muted small">или</span>
            <TelegramLoginButton
              botUsername={telegram.botUsername}
              onAuth={(payload) => {
                setError(null);
                setPending(false);
                loginWithTelegram(payload)
                  .then((result) => (result.status === "ok" ? onToken(result.token) : setPending(true)))
                  .catch((err) => setError(errorMessage(err)));
              }}
            />
          </div>
        )}

        <details className="login-service">
          <summary className="muted small">Войти по служебному токену</summary>
          <Field label="ADMIN_TOKEN" hint="Переходный общий токен из env. Используется, чтобы завести первую учётку.">
            <input
              type="password"
              value={serviceToken}
              onChange={(e) => setServiceToken(e.target.value)}
              placeholder="x-admin-token"
            />
          </Field>
          <button
            type="button"
            className="btn"
            disabled={!serviceToken.trim()}
            onClick={() => onToken(serviceToken.trim())}
          >
            Войти токеном
          </button>
        </details>
      </div>
    </form>
  );
}
