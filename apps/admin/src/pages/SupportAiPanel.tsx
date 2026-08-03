import { useState } from "react";
import {
  checkAiProvider,
  createAiProvider,
  errorMessage,
  getAiProviderSpecs,
  getAiProviders,
  updateAiProvider,
  type AiProvider,
  type AiProviderSpec,
} from "../api";
import { useResource } from "../useResource";
import { formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Toggle from "../components/Toggle";
import Modal from "../components/Modal";
import Field from "../components/Field";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

interface CheckState {
  pending: boolean;
  ok?: boolean;
  detail?: string;
}

/** Подключение ИИ: ключ хранится зашифрованным, тумблер включает подсказки без рестарта. */
export default function SupportAiPanel() {
  const page = useResource(async () => {
    const [providers, specs] = await Promise.all([getAiProviders(), getAiProviderSpecs()]);
    return { providers, specs };
  });

  const [editing, setEditing] = useState<{ provider: AiProvider | null } | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleEnabled = async (provider: AiProvider, next: boolean) => {
    setBusyId(provider.id);
    setActionError(null);
    try {
      await updateAiProvider(provider.id, { isEnabled: next });
      page.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const runCheck = async (provider: AiProvider) => {
    setChecks((prev) => ({ ...prev, [provider.id]: { pending: true } }));
    try {
      const result = await checkAiProvider(provider.id);
      setChecks((prev) => ({ ...prev, [provider.id]: { pending: false, ...result } }));
      page.reload();
    } catch (e) {
      setChecks((prev) => ({ ...prev, [provider.id]: { pending: false, ok: false, detail: errorMessage(e) } }));
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { providers, specs } = page.data;
  const specOf = (provider: string) => specs.find((s) => s.provider === provider);

  const columns: Column<AiProvider>[] = [
    {
      key: "provider",
      title: "Провайдер",
      render: (p) => (
        <div>
          <div className="strong">{specOf(p.provider)?.title ?? p.provider}</div>
          <div className="muted small">{p.alias}</div>
        </div>
      ),
    },
    {
      key: "model",
      title: "Модель",
      render: (p) => (
        <div>
          <div className="mono">{p.model}</div>
          <div className="small">
            {p.isConfigured ? (
              <StatusBadge status="ok" label="ключ задан" />
            ) : (
              <StatusBadge status="error" label="ключа нет" />
            )}
          </div>
        </div>
      ),
    },
    {
      key: "limits",
      title: "Лимиты",
      render: (p) => (
        <div className="muted small">
          контекст {String(p.settings.max_context_chars ?? "12000")} симв. · на диалог{" "}
          {String(p.settings.max_per_conversation ?? "20")} · в сутки {String(p.settings.max_per_day ?? "300")}
        </div>
      ),
    },
    {
      key: "check",
      title: "Последняя проверка",
      render: (p) => {
        const local = checks[p.id];
        if (local?.pending) return <span className="muted">проверяем…</span>;
        const ok = local?.ok ?? p.lastCheckOk;
        const detail = local?.detail ?? p.lastCheckError;
        if (ok === null || ok === undefined) return <span className="muted">не проверялся</span>;
        return (
          <div className="check-cell">
            <StatusBadge status={ok ? "ok" : "error"} label={ok ? "ок" : "ошибка"} />
            {!local && p.lastCheckAt && <div className="muted small">{formatDateTime(p.lastCheckAt)}</div>}
            {detail && <div className={ok ? "muted small" : "err small"}>{detail}</div>}
          </div>
        );
      },
    },
    {
      key: "enabled",
      title: "Включён",
      render: (p) => (
        <Toggle checked={p.isEnabled} disabled={busyId === p.id} onChange={(next) => toggleEnabled(p, next)} />
      ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (p) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => runCheck(p)} disabled={checks[p.id]?.pending}>
            Проверить
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setEditing({ provider: p })}>
            Настроить
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      {actionError && <ErrorBox error={actionError} />}

      <Card
        title="Провайдер подсказок"
        subtitle="Ключ хранится зашифрованным и наружу отдаётся маскированным. Подсказки генерирует первый включённый провайдер; ИИ никогда не отвечает клиенту сам."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ provider: null })}>
            Подключить провайдера
          </button>
        }
      >
        {providers.length === 0 ? (
          <EmptyState
            text="Провайдер не подключён"
            hint="Поддержка работает как раньше, просто без подсказок."
          />
        ) : (
          <Table columns={columns} rows={providers} rowKey={(p) => p.id} />
        )}
      </Card>

      {editing && (
        <AiProviderModal
          specs={specs}
          provider={editing.provider}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            page.reload();
          }}
        />
      )}
    </>
  );
}

interface ModalProps {
  specs: AiProviderSpec[];
  provider: AiProvider | null;
  onClose: () => void;
  onSaved: () => void;
}

function AiProviderModal({ specs, provider, onClose, onSaved }: ModalProps) {
  const isEdit = provider !== null;
  const [providerId, setProviderId] = useState(provider?.provider ?? specs[0]?.provider ?? "");
  const spec = specs.find((s) => s.provider === providerId);

  const [alias, setAlias] = useState(provider?.alias ?? "");
  const [model, setModel] = useState(provider?.model ?? spec?.defaultModel ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>(() => initialSettings(provider, specs));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchProvider = (next: string) => {
    setProviderId(next);
    setCredentials({});
    setSettings(initialSettings(null, specs, next));
    setModel(specs.find((s) => s.provider === next)?.defaultModel ?? "");
  };

  const submit = async () => {
    if (!alias.trim()) {
      setError("нужен алиас");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payloadSettings = buildSettings(settings, spec);
      const payloadCredentials = buildCredentials(credentials);
      if (isEdit) {
        await updateAiProvider(provider.id, {
          alias: alias.trim(),
          model: model.trim(),
          settings: payloadSettings,
          ...(Object.keys(payloadCredentials).length > 0 ? { credentials: payloadCredentials } : {}),
        });
      } else {
        await createAiProvider({
          provider: providerId,
          alias: alias.trim(),
          model: model.trim() || undefined,
          settings: payloadSettings,
          credentials: payloadCredentials,
        });
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Провайдер ${provider.alias}` : "Подключить провайдера"}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Сохраняем…" : isEdit ? "Сохранить" : "Подключить"}
          </button>
        </>
      }
    >
      <Field label="Провайдер" required>
        <select value={providerId} onChange={(e) => switchProvider(e.target.value)} disabled={isEdit}>
          {specs.map((s) => (
            <option key={s.provider} value={s.provider}>
              {s.title}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Алиас" hint="Уникальное имя внутри организации" required>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="claude-main" />
        </Field>
        <Field label="Модель" hint={`По умолчанию: ${spec?.defaultModel ?? "—"}`}>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={spec?.defaultModel} />
        </Field>
      </div>

      {spec && spec.credentialFields.length > 0 && (
        <>
          <h3 className="form-section">Ключ доступа</h3>
          {spec.credentialFields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              required={f.required && !isEdit}
              hint={isEdit ? "Пустое поле — не менять" : undefined}
            >
              <input
                value={credentials[f.key] ?? ""}
                placeholder={isEdit ? (provider.credentials[f.key] ?? "не задан") : ""}
                onChange={(e) => setCredentials((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </>
      )}

      {spec && spec.settingFields.length > 0 && (
        <>
          <h3 className="form-section">Лимиты и адрес</h3>
          {spec.settingFields.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                type={f.type === "number" ? "number" : "text"}
                value={settings[f.key] ?? ""}
                placeholder={f.default !== undefined ? String(f.default) : ""}
                onChange={(e) => setSettings((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </>
      )}
    </Modal>
  );
}

function initialSettings(
  provider: AiProvider | null,
  specs: AiProviderSpec[],
  providerId = provider?.provider ?? specs[0]?.provider,
): Record<string, string> {
  const spec = specs.find((s) => s.provider === providerId);
  const out: Record<string, string> = {};
  for (const f of spec?.settingFields ?? []) {
    const current = provider?.settings[f.key];
    if (current !== undefined && current !== null) out[f.key] = String(current);
    else if (!provider && f.default !== undefined) out[f.key] = String(f.default);
  }
  return out;
}

function buildSettings(raw: Record<string, string>, spec?: AiProviderSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec?.settingFields ?? []) {
    const value = raw[f.key];
    if (value === undefined || value.trim() === "") continue;
    out[f.key] = f.type === "number" ? Number(value) : value;
  }
  return out;
}

function buildCredentials(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v.trim() !== "") out[k] = v.trim();
  }
  return out;
}
