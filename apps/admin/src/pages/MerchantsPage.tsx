import { useState } from "react";
import {
  checkMerchant,
  createMerchant,
  errorMessage,
  getMerchants,
  getProviderSpecs,
  updateMerchant,
  type Merchant,
  type ProviderSpec,
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

const PURPOSE_LABELS: Record<string, string> = {
  topup: "пополнение",
  plan: "тариф",
  gift: "подарок",
};

interface CheckState {
  pending: boolean;
  ok?: boolean;
  detail?: string;
}

export default function MerchantsPage() {
  const page = useResource(async () => {
    const [merchants, specs] = await Promise.all([getMerchants(), getProviderSpecs()]);
    return { merchants, specs };
  });

  const [editing, setEditing] = useState<{ merchant: Merchant | null } | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleEnabled = async (merchant: Merchant, next: boolean) => {
    setBusyId(merchant.id);
    setActionError(null);
    try {
      await updateMerchant(merchant.id, { isEnabled: next });
      page.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const runCheck = async (merchant: Merchant) => {
    setChecks((prev) => ({ ...prev, [merchant.id]: { pending: true } }));
    try {
      const result = await checkMerchant(merchant.id);
      setChecks((prev) => ({ ...prev, [merchant.id]: { pending: false, ...result } }));
      page.reload();
    } catch (e) {
      setChecks((prev) => ({ ...prev, [merchant.id]: { pending: false, ok: false, detail: errorMessage(e) } }));
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { merchants, specs } = page.data;
  const specOf = (provider: string) => specs.find((s) => s.provider === provider);

  const columns: Column<Merchant>[] = [
    {
      key: "provider",
      title: "Провайдер",
      render: (m) => (
        <div>
          <div className="strong">{specOf(m.provider)?.title ?? m.provider}</div>
          <div className="muted small">{m.provider}</div>
        </div>
      ),
    },
    {
      key: "alias",
      title: "Мерчант",
      render: (m) => (
        <div>
          <div>{m.alias}</div>
          {m.title && <div className="muted small">кнопка: {m.title}</div>}
          <div className="small">
            {m.isConfigured ? (
              <StatusBadge status="ok" label="ключи заданы" />
            ) : (
              <StatusBadge status="error" label="ключей нет" />
            )}
          </div>
        </div>
      ),
    },
    {
      key: "purposes",
      title: "Назначения",
      render: (m) => m.purposes.map((p) => PURPOSE_LABELS[p] ?? p).join(", ") || "—",
    },
    {
      key: "mode",
      title: "Режим",
      render: (m) => (
        <div>
          <StatusBadge status={m.mode} />
          <div className="muted small">приоритет {m.priority}</div>
        </div>
      ),
    },
    {
      key: "check",
      title: "Последняя проверка",
      render: (m) => {
        const local = checks[m.id];
        if (local?.pending) return <span className="muted">проверяем…</span>;
        const ok = local?.ok ?? m.lastCheckOk;
        const detail = local?.detail ?? m.lastCheckError;
        if (ok === null || ok === undefined) return <span className="muted">не проверялся</span>;
        return (
          <div className="check-cell">
            <StatusBadge status={ok ? "ok" : "error"} label={ok ? "ок" : "ошибка"} />
            {!local && m.lastCheckAt && <div className="muted small">{formatDateTime(m.lastCheckAt)}</div>}
            {detail && <div className={ok ? "muted small" : "err small"}>{detail}</div>}
          </div>
        );
      },
    },
    {
      key: "enabled",
      title: "Включён",
      render: (m) => (
        <Toggle checked={m.isEnabled} disabled={busyId === m.id} onChange={(next) => toggleEnabled(m, next)} />
      ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (m) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => runCheck(m)} disabled={checks[m.id]?.pending}>
            Проверить
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setEditing({ merchant: m })}>
            Настроить
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Мерчанты</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ merchant: null })}>
          Подключить мерчанта
        </button>
      </div>

      {actionError && <ErrorBox error={actionError} />}

      <Card
        title="Подключённые мерчанты"
        subtitle="Ключи хранятся зашифрованными и наружу отдаются маскированными."
      >
        {merchants.length === 0 ? (
          <EmptyState
            text="Мерчантов пока нет"
            hint="Подключите первого — форма строится по спецификации провайдера."
          />
        ) : (
          <Table columns={columns} rows={merchants} rowKey={(m) => m.id} />
        )}
      </Card>

      {editing && (
        <MerchantModal
          specs={specs}
          merchant={editing.merchant}
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
  specs: ProviderSpec[];
  merchant: Merchant | null;
  onClose: () => void;
  onSaved: () => void;
}

function MerchantModal({ specs, merchant, onClose, onSaved }: ModalProps) {
  const isEdit = merchant !== null;
  const [provider, setProvider] = useState(merchant?.provider ?? specs[0]?.provider ?? "");
  const spec = specs.find((s) => s.provider === provider);

  const [alias, setAlias] = useState(merchant?.alias ?? "");
  const [title, setTitle] = useState(merchant?.title ?? "");
  const [mode, setMode] = useState<"live" | "test">(merchant?.mode ?? "live");
  const [priority, setPriority] = useState(String(merchant?.priority ?? 0));
  const [purposes, setPurposes] = useState<string[]>(merchant?.purposes ?? ["topup", "plan"]);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>(() => initialSettings(merchant, specs));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchProvider = (next: string) => {
    setProvider(next);
    setCredentials({});
    setSettings(initialSettings(null, specs, next));
    const nextSpec = specs.find((s) => s.provider === next);
    setPurposes(nextSpec ? [...nextSpec.purposes] : []);
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
        await updateMerchant(merchant.id, {
          alias: alias.trim(),
          title: title.trim(),
          mode,
          priority: Number(priority) || 0,
          purposes,
          settings: payloadSettings,
          ...(Object.keys(payloadCredentials).length > 0 ? { credentials: payloadCredentials } : {}),
        });
      } else {
        await createMerchant({
          provider,
          alias: alias.trim(),
          title: title.trim() || undefined,
          mode,
          purposes,
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
      title={isEdit ? `Мерчант ${merchant.alias}` : "Подключить мерчанта"}
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
        <select value={provider} onChange={(e) => switchProvider(e.target.value)} disabled={isEdit}>
          {specs.map((s) => (
            <option key={s.provider} value={s.provider}>
              {s.title}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Алиас" hint="Уникальное имя внутри организации" required>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="pal24-main" />
        </Field>
        <Field label="Подпись кнопки в боте">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="СБП" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Режим">
          <select value={mode} onChange={(e) => setMode(e.target.value as "live" | "test")}>
            <option value="live">live</option>
            <option value="test">test</option>
          </select>
        </Field>
        {isEdit && (
          <Field label="Приоритет" hint="Меньше — выше в списке способов оплаты">
            <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
        )}
      </div>

      <Field label="Назначения" hint={`Провайдер поддерживает: ${spec?.purposes.join(", ") ?? "—"}`}>
        <div className="checks">
          {(spec?.purposes ?? []).map((p) => (
            <label key={p} className="check">
              <input
                type="checkbox"
                checked={purposes.includes(p)}
                onChange={(e) =>
                  setPurposes((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))
                }
              />
              {PURPOSE_LABELS[p] ?? p}
            </label>
          ))}
        </div>
      </Field>

      {spec && spec.credentialFields.length > 0 && (
        <>
          <h3 className="form-section">Ключи доступа</h3>
          {spec.credentialFields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              required={f.required && !isEdit}
              hint={isEdit ? "Пустое поле — не менять; очистить ключ нельзя из формы" : undefined}
            >
              <input
                value={credentials[f.key] ?? ""}
                placeholder={isEdit ? (merchant.credentials[f.key] ?? "не задан") : ""}
                onChange={(e) => setCredentials((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </>
      )}

      {spec && spec.settingFields.length > 0 && (
        <>
          <h3 className="form-section">Настройки</h3>
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

      {spec && spec.credentialFields.length === 0 && (
        <p className="muted small">У этого провайдера нет ключей — достаточно настроек.</p>
      )}
    </Modal>
  );
}

function initialSettings(
  merchant: Merchant | null,
  specs: ProviderSpec[],
  provider = merchant?.provider ?? specs[0]?.provider,
): Record<string, string> {
  const spec = specs.find((s) => s.provider === provider);
  const out: Record<string, string> = {};
  for (const f of spec?.settingFields ?? []) {
    const current = merchant?.settings[f.key];
    if (current !== undefined && current !== null) out[f.key] = String(current);
    else if (!merchant && f.default !== undefined) out[f.key] = String(f.default);
  }
  return out;
}

function buildSettings(raw: Record<string, string>, spec?: ProviderSpec): Record<string, unknown> {
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
