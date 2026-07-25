import { useState } from "react";
import {
  SEGMENT_KINDS,
  cancelBroadcast,
  createBroadcast,
  createTouchpoint,
  errorMessage,
  getBroadcasts,
  getTouchpoints,
  runBroadcast,
  updateTouchpoint,
  type Broadcast,
  type SegmentKind,
  type Touchpoint,
} from "../api";
import { useResource } from "../useResource";
import { formatDateTime, formatNumber } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

const SEGMENT_LABELS: Record<string, string> = {
  all: "все",
  active: "активные",
  inactive: "неактивные",
  expiring: "истекающие",
  segment: "сегмент",
};

const RUNNABLE = ["draft", "scheduled"];

export default function BroadcastsPage() {
  const broadcasts = useResource(getBroadcasts);
  const touchpoints = useResource(getTouchpoints);

  const [creatingBroadcast, setCreatingBroadcast] = useState(false);
  const [creatingTouchpoint, setCreatingTouchpoint] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (b: Broadcast) => {
    setBusyId(b.id);
    setActionError(null);
    setNotice(null);
    try {
      await runBroadcast(b.id);
      setNotice(`«${b.title}»: прогон запущен, статистика обновляется по кнопке «Обновить»`);
      broadcasts.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (b: Broadcast) => {
    setBusyId(b.id);
    setActionError(null);
    setNotice(null);
    try {
      const result = await cancelBroadcast(b.id);
      if (!result.ok) setActionError(result.reason ?? "отменить не удалось");
      broadcasts.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const toggleTouchpoint = async (t: Touchpoint, isActive: boolean) => {
    setBusyId(t.id);
    setActionError(null);
    try {
      await updateTouchpoint(t.id, { isActive });
      touchpoints.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const broadcastColumns: Column<Broadcast>[] = [
    {
      key: "title",
      title: "Рассылка",
      render: (b) => (
        <div>
          <div className="strong">{b.title}</div>
          <div className="muted small">{formatDateTime(b.createdAt)}</div>
        </div>
      ),
    },
    {
      key: "segment",
      title: "Сегмент",
      render: (b) => SEGMENT_LABELS[b.segmentKind] ?? b.segmentKind,
    },
    { key: "status", title: "Статус", render: (b) => <StatusBadge status={b.status} /> },
    {
      key: "stats",
      title: "Отправка",
      render: (b) => (
        <div className="stats-inline">
          <span className="ok">{formatNumber(b.stats.sent)} ок</span>
          <span className={b.stats.failed > 0 ? "err" : "muted"}>{formatNumber(b.stats.failed)} ошибок</span>
          <span className="muted">{formatNumber(b.stats.pending)} в очереди</span>
          <span className="muted">из {formatNumber(b.stats.total)}</span>
        </div>
      ),
    },
    { key: "throttle", title: "Троттлинг", align: "right", render: (b) => `${b.throttlePerSec}/с` },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (b) => (
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => run(b)}
            disabled={busyId === b.id || !RUNNABLE.includes(b.status)}
          >
            Запустить
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => cancel(b)}
            disabled={busyId === b.id || !["draft", "scheduled", "running"].includes(b.status)}
          >
            Отменить
          </button>
        </div>
      ),
    },
  ];

  const touchpointColumns: Column<Touchpoint>[] = [
    {
      key: "name",
      title: "Касание",
      render: (t) => (
        <div>
          <div className="strong">{t.name}</div>
          <div className="muted small mono">{t.triggerKey}</div>
        </div>
      ),
    },
    { key: "type", title: "Тип триггера", render: (t) => t.triggerType },
    { key: "delay", title: "Задержка", align: "right", render: (t) => `${t.delayHours} ч` },
    {
      key: "active",
      title: "Включено",
      render: (t) => (
        <Toggle checked={t.isActive} disabled={busyId === t.id} onChange={(next) => toggleTouchpoint(t, next)} />
      ),
    },
    { key: "created", title: "Создано", render: (t) => formatDateTime(t.createdAt) },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Рассылки</h1>
        <button
          type="button"
          className="btn"
          onClick={() => {
            broadcasts.reload();
            touchpoints.reload();
          }}
        >
          Обновить
        </button>
      </div>

      {actionError && <ErrorBox error={actionError} />}
      {notice && <div className="notice">{notice}</div>}

      <Card
        title="Рассылки"
        subtitle="Прогон идёт фоном в процессе core: прогресс виден по счётчикам после обновления."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreatingBroadcast(true)}>
            Создать рассылку
          </button>
        }
      >
        {broadcasts.loading && <Loading />}
        {broadcasts.error && <ErrorBox error={broadcasts.error} onRetry={broadcasts.reload} />}
        {broadcasts.data &&
          (broadcasts.data.length === 0 ? (
            <EmptyState text="Рассылок нет" hint="Создайте рассылку — получатели материализуются сразу." />
          ) : (
            <Table columns={broadcastColumns} rows={broadcasts.data} rowKey={(b) => b.id} />
          ))}
      </Card>

      <Card
        title="Триггерные касания"
        subtitle="Дожим по событию или состоянию подписки; прогон запускает планировщик."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreatingTouchpoint(true)}>
            Создать касание
          </button>
        }
      >
        {touchpoints.loading && <Loading />}
        {touchpoints.error && <ErrorBox error={touchpoints.error} onRetry={touchpoints.reload} />}
        {touchpoints.data &&
          (touchpoints.data.length === 0 ? (
            <EmptyState text="Касаний нет" hint="Например: expires_in_3d или churned_7d." />
          ) : (
            <Table columns={touchpointColumns} rows={touchpoints.data} rowKey={(t) => t.id} />
          ))}
      </Card>

      {creatingBroadcast && (
        <BroadcastModal
          onClose={() => setCreatingBroadcast(false)}
          onCreated={(recipients) => {
            setCreatingBroadcast(false);
            setNotice(`Рассылка создана, получателей: ${recipients}`);
            broadcasts.reload();
          }}
        />
      )}
      {creatingTouchpoint && (
        <TouchpointModal
          onClose={() => setCreatingTouchpoint(false)}
          onCreated={() => {
            setCreatingTouchpoint(false);
            touchpoints.reload();
          }}
        />
      )}
    </>
  );
}

function BroadcastModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (recipients: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [segmentKind, setSegmentKind] = useState<SegmentKind>("all");
  const [segmentId, setSegmentId] = useState("");
  const [expiringDays, setExpiringDays] = useState("3");
  const [bodyHtml, setBodyHtml] = useState("");
  const [throttle, setThrottle] = useState("20");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || !bodyHtml.trim()) {
      setError("нужны заголовок и текст");
      return;
    }
    if (segmentKind === "segment" && !segmentId.trim()) {
      setError("для сегмента нужен его uuid");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createBroadcast({
        title: title.trim(),
        segmentKind,
        segmentId: segmentKind === "segment" ? segmentId.trim() : undefined,
        expiringDays: segmentKind === "expiring" ? Number(expiringDays) || undefined : undefined,
        bodyHtml: bodyHtml.trim(),
        throttlePerSec: Number(throttle) || undefined,
      });
      onCreated(result.recipients);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Новая рассылка"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Создаём…" : "Создать"}
          </button>
        </>
      }
    >
      <Field label="Заголовок" required>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Скидка на годовой тариф" />
      </Field>

      <div className="grid-2">
        <Field label="Сегмент">
          <select value={segmentKind} onChange={(e) => setSegmentKind(e.target.value as SegmentKind)}>
            {SEGMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {SEGMENT_LABELS[k] ?? k}
              </option>
            ))}
          </select>
        </Field>
        {segmentKind === "segment" && (
          <Field label="UUID сегмента" hint="Списка сегментов API не отдаёт — нужен id из БД" required>
            <input value={segmentId} onChange={(e) => setSegmentId(e.target.value)} />
          </Field>
        )}
        {segmentKind === "expiring" && (
          <Field label="Истекают в течение, дней">
            <input type="number" value={expiringDays} onChange={(e) => setExpiringDays(e.target.value)} />
          </Field>
        )}
      </div>

      <Field label="Текст (HTML Telegram)" required>
        <textarea
          rows={6}
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          placeholder="<b>Важно</b>: подписка заканчивается"
        />
      </Field>

      <Field label="Троттлинг, сообщений в секунду" hint="Больше 30 Telegram не любит">
        <input type="number" value={throttle} onChange={(e) => setThrottle(e.target.value)} />
      </Field>
    </Modal>
  );
}

function TouchpointModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [triggerKey, setTriggerKey] = useState("");
  const [triggerType, setTriggerType] = useState("condition");
  const [delayHours, setDelayHours] = useState("0");
  const [bodyHtml, setBodyHtml] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !triggerKey.trim() || !bodyHtml.trim()) {
      setError("нужны название, ключ триггера и текст");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createTouchpoint({
        name: name.trim(),
        triggerKey: triggerKey.trim(),
        triggerType,
        delayHours: Number(delayHours) || 0,
        bodyHtml: bodyHtml.trim(),
        isActive,
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Новое касание"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Создаём…" : "Создать"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Название" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Напоминание за 3 дня" />
        </Field>
        <Field label="Ключ триггера" required>
          <input value={triggerKey} onChange={(e) => setTriggerKey(e.target.value)} placeholder="expires_in_3d" />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Тип триггера">
          <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
            <option value="condition">condition</option>
            <option value="event">event</option>
            <option value="schedule">schedule</option>
          </select>
        </Field>
        <Field label="Задержка, часов">
          <input type="number" value={delayHours} onChange={(e) => setDelayHours(e.target.value)} />
        </Field>
      </div>
      <Field label="Текст (HTML Telegram)" required>
        <textarea rows={5} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} />
      </Field>
      <Toggle checked={isActive} onChange={setIsActive} label="Включено сразу" />
    </Modal>
  );
}
