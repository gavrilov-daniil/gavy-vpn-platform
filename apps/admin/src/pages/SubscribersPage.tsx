import { useEffect, useState } from "react";
import {
  errorMessage,
  getDevices,
  getSubscribers,
  getUsage,
  revokeSubscription,
  unlinkDevice,
  type Subscriber,
  type SubscriberDevice,
  type UsageRow,
} from "../api";
import { useResource } from "../useResource";
import { daysLeft, formatBytes, formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Field from "../components/Field";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

export default function SubscribersPage() {
  const page = useResource(getSubscribers);
  const [selected, setSelected] = useState<Subscriber | null>(null);
  const [query, setQuery] = useState("");

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? page.data.filter(
        (s) =>
          (s.username ?? "").toLowerCase().includes(needle) ||
          String(s.telegramId ?? "").includes(needle) ||
          s.status.includes(needle),
      )
    : page.data;

  const columns: Column<Subscriber>[] = [
    {
      key: "who",
      title: "Подписчик",
      render: (s) => (
        <div>
          <div className="strong">{s.username ? `@${s.username}` : "без username"}</div>
          <div className="muted small">tg: {s.telegramId ?? "—"}</div>
        </div>
      ),
    },
    { key: "status", title: "Статус", render: (s) => <StatusBadge status={s.status} /> },
    {
      key: "expire",
      title: "Срок",
      render: (s) => {
        const left = daysLeft(s.expireAt);
        return (
          <div>
            <div>{formatDateTime(s.expireAt)}</div>
            {left !== null && (
              <div className={left < 0 ? "err small" : left <= 3 ? "warn small" : "muted small"}>
                {left < 0 ? `истекла ${-left} дн назад` : `осталось ${left} дн`}
              </div>
            )}
          </div>
        );
      },
    },
    { key: "traffic", title: "Трафик", align: "right", render: (s) => formatBytes(s.usedTrafficBytes) },
    {
      key: "devices",
      title: "Устройства",
      align: "right",
      render: (s) => {
        const limit = s.deviceLimit;
        if (limit === null) return <span>{s.devicesUsed} / без лимита</span>;
        return (
          <span className={s.devicesUsed >= limit ? "warn" : undefined}>
            {s.devicesUsed} / {limit}
          </span>
        );
      },
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setSelected(s)}>
          Подробнее
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Подписчики</h1>
        <button type="button" className="btn" onClick={page.reload}>
          Обновить
        </button>
      </div>

      <Card
        title={`Подписки (${page.data.length})`}
        actions={
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="поиск по username, tg id, статусу"
          />
        }
      >
        {page.data.length === 0 ? (
          <EmptyState text="Подписчиков нет" />
        ) : rows.length === 0 ? (
          <EmptyState text="Ничего не найдено" hint="Измените запрос." />
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={setSelected}
            activeKey={selected?.id ?? null}
          />
        )}
      </Card>

      {/* key: при переключении подписчика форма и загруженная статистика должны
          сброситься, иначе в карточке остаются цифры от предыдущего. */}
      {selected && (
        <SubscriberDetails key={selected.id} subscriber={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function SubscriberDetails({ subscriber, onClose }: { subscriber: Subscriber; onClose: () => void }) {
  const [shortUuid, setShortUuid] = useState(subscriber.shortUuid);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!shortUuid.trim()) {
      setError("нужен shortUuid подписки");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setUsage(await getUsage(shortUuid.trim()));
    } catch (e) {
      setError(errorMessage(e));
      setUsage(null);
    } finally {
      setLoading(false);
    }
  };

  const columns: Column<UsageRow>[] = [
    { key: "day", title: "День", render: (r) => r.day },
    { key: "node", title: "Нода", render: (r) => <span className="mono small">{r.nodeId}</span> },
    { key: "up", title: "Отдано", align: "right", render: (r) => formatBytes(r.up) },
    { key: "down", title: "Принято", align: "right", render: (r) => formatBytes(r.down) },
    { key: "total", title: "Итого", align: "right", render: (r) => formatBytes(r.up + r.down) },
  ];

  return (
    <Card
      title={subscriber.username ? `@${subscriber.username}` : `tg ${subscriber.telegramId ?? "—"}`}
      actions={
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <div className="kv">
        <div>
          <span className="kv-key">ID подписки</span>
          <span className="kv-val mono">{subscriber.id}</span>
        </div>
        <div>
          <span className="kv-key">Статус</span>
          <span className="kv-val">
            <StatusBadge status={subscriber.status} />
          </span>
        </div>
        <div>
          <span className="kv-key">Истекает</span>
          <span className="kv-val">{formatDateTime(subscriber.expireAt)}</span>
        </div>
        <div>
          <span className="kv-key">Трафик</span>
          <span className="kv-val">{formatBytes(subscriber.usedTrafficBytes)}</span>
        </div>
      </div>

      <h3 className="form-section">Использование по нодам</h3>
      <div className="inline-form">
        <Field label="shortUuid подписки" hint="Подставлен из выбранной подписки; можно заменить на любой другой.">
          <input value={shortUuid} onChange={(e) => setShortUuid(e.target.value)} placeholder="demoshortuuid0001" />
        </Field>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          {loading ? "Загружаем…" : "Загрузить"}
        </button>
      </div>

      {error && <ErrorBox error={error} />}
      {usage !== null &&
        (usage.length === 0 ? (
          <EmptyState text="Статистики по этой подписке нет" hint="Агенты ещё не прислали дельты трафика." />
        ) : (
          <Table columns={columns} rows={usage} rowKey={(r) => `${r.day}:${r.nodeId}`} />
        ))}

      <DevicesBlock subscriptionId={subscriber.id} deviceLimit={subscriber.deviceLimit} />
      <RevokeBlock subscriptionId={subscriber.id} />
    </Card>
  );
}

/** Устройства подписки: занятые слоты и отвязка застрявшего устройства. */
function DevicesBlock({ subscriptionId, deviceLimit }: { subscriptionId: string; deviceLimit: number | null }) {
  const [devices, setDevices] = useState<SubscriberDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setDevices(await getDevices(subscriptionId));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // подписка сменилась — список надо перечитать, иначе покажем чужие устройства
  }, [subscriptionId]);

  const unlink = async (hwid: string) => {
    setBusy(hwid);
    setError(null);
    try {
      await unlinkDevice(subscriptionId, hwid);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<SubscriberDevice>[] = [
    { key: "hwid", title: "HWID", render: (d) => <span className="mono small">{d.hwid}</span> },
    { key: "os", title: "Платформа", render: (d) => d.deviceOs ?? "—" },
    { key: "model", title: "Модель", render: (d) => d.deviceModel ?? "—" },
    { key: "last", title: "Последний раз", render: (d) => formatDateTime(d.lastSeenAt) },
    {
      key: "act",
      title: "",
      align: "right",
      render: (d) => (
        <button type="button" className="btn btn-sm" onClick={() => void unlink(d.hwid)} disabled={busy === d.hwid}>
          {busy === d.hwid ? "…" : "Отвязать"}
        </button>
      ),
    },
  ];

  return (
    <>
      <h3 className="form-section">
        Устройства {devices ? `(${devices.length}${deviceLimit ? ` из ${deviceLimit}` : ""})` : ""}
      </h3>
      {error && <ErrorBox error={error} />}
      {devices === null ? (
        <Loading />
      ) : devices.length === 0 ? (
        <EmptyState text="Устройств нет" hint="Клиент ещё не открывал подписку или не шлёт HWID." />
      ) : (
        <Table columns={columns} rows={devices} rowKey={(d) => d.hwid} />
      )}
    </>
  );
}

/**
 * Перевыпуск подписки при утечке ссылки. Действие необратимое и рвёт доступ
 * до тех пор, пока клиент не заберёт новую ссылку в боте, поэтому с подтверждением.
 */
function RevokeBlock({ subscriptionId }: { subscriptionId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await revokeSubscription(subscriptionId);
      setResult(r.subscriptionUrl);
      setConfirming(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="form-section">Перевыпуск подписки</h3>
      {error && <ErrorBox error={error} />}
      {result ? (
        <p className="small">
          Новая ссылка: <span className="mono">{result}</span>. Старая больше не работает — клиент заберёт новую в боте.
        </p>
      ) : confirming ? (
        <div className="inline-form">
          <span className="small">
            Старая ссылка перестанет работать сразу, устройства отвяжутся. Клиенту придётся взять новую в боте.
          </span>
          <button type="button" className="btn btn-danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? "Перевыпускаем…" : "Да, перевыпустить"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
            Отмена
          </button>
        </div>
      ) : (
        <div className="inline-form">
          <span className="small">Применять при утечке ссылки: меняет адрес подписки и идентификатор в конфиге.</span>
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Перевыпустить
          </button>
        </div>
      )}
    </>
  );
}
