import { useEffect, useState } from "react";
import {
  CONVERSATION_STATUSES,
  errorMessage,
  getConversation,
  getConversations,
  patchConversation,
  replyToConversation,
  type ConversationListItem,
} from "../api";
import { useResource } from "../useResource";
import { formatAgo, formatDateTime } from "../format";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";
import Field from "../components/Field";

const POLL_MS = 10_000;

export default function SupportPage() {
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useResource(() => getConversations(status || undefined), [status]);
  const { setData } = list;

  useEffect(() => {
    const timer = setInterval(() => {
      getConversations(status || undefined)
        .then(setData)
        .catch(() => {
          // тихо: следующий тик повторит, экран не мигает ошибкой на каждой сетевой икоте
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status, setData]);

  return (
    <>
      <div className="page-head">
        <h1>Поддержка</h1>
        <div className="head-tools">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Все статусы</option>
            {CONVERSATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={list.reload}>
            Обновить
          </button>
        </div>
      </div>

      <div className="split">
        <aside className="split-list">
          {list.loading && <Loading />}
          {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
          {list.data && list.data.length === 0 && <EmptyState text="Диалогов нет" />}
          {list.data?.map((c) => (
            <ConversationRow
              key={c.id}
              item={c}
              active={c.id === selectedId}
              onSelect={() => setSelectedId(c.id)}
            />
          ))}
          {list.data && <div className="poll-note">обновляется автоматически раз в 10 с</div>}
        </aside>

        <section className="split-detail">
          {selectedId ? (
            <ConversationPane key={selectedId} id={selectedId} onChanged={list.reload} />
          ) : (
            <EmptyState text="Выберите диалог" hint="Слева список обращений, отсортированных по последнему сообщению." />
          )}
        </section>
      </div>
    </>
  );
}

function ConversationRow({
  item,
  active,
  onSelect,
}: {
  item: ConversationListItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`conv ${active ? "conv-active" : ""}`.trim()} onClick={onSelect}>
      <div className="conv-top">
        <span className="strong">
          {item.contact?.username ? `@${item.contact.username}` : `tg ${item.contact?.telegramUserId ?? "—"}`}
        </span>
        <StatusBadge status={item.status} />
      </div>
      <div className="muted small">{formatAgo(item.lastMessageAt ?? item.createdAt)}</div>
    </button>
  );
}

function ConversationPane({ id, onChanged }: { id: string; onChanged: () => void }) {
  const conv = useResource(() => getConversation(id), [id]);
  const { setData } = conv;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");

  useEffect(() => {
    const timer = setInterval(() => {
      getConversation(id)
        .then(setData)
        .catch(() => {
          // тихо: переписка догрузится на следующем тике
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, setData]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await replyToConversation(id, text.trim());
      setText("");
      setNotice(
        result.deduped
          ? "Такое сообщение уже отправлялось — дубль отброшен"
          : result.delivered
            ? "Отправлено в Telegram"
            : `Сохранено, но не доставлено: ${result.reason ?? "бот не ответил"}`,
      );
      conv.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const changeStatus = async (next: string) => {
    setError(null);
    try {
      await patchConversation(id, { status: next });
      conv.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const changeAssignee = async (value: string | null) => {
    setError(null);
    try {
      await patchConversation(id, { assigneeUserId: value });
      setAssignee("");
      conv.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (conv.loading) return <Loading />;
  if (conv.error) return <ErrorBox error={conv.error} onRetry={conv.reload} />;
  if (!conv.data) return null;

  const c = conv.data;

  return (
    <div className="pane">
      <header className="pane-head">
        <div>
          <div className="strong">
            {c.contact?.username ? `@${c.contact.username}` : `tg ${c.contact?.telegramUserId ?? "—"}`}
          </div>
          <div className="muted small">
            создан {formatDateTime(c.createdAt)} · последнее сообщение {formatAgo(c.lastMessageAt)}
          </div>
        </div>
        <div className="head-tools">
          <select value={c.status} onChange={(e) => changeStatus(e.target.value)}>
            {CONVERSATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <ErrorBox error={error} />}

      <div className="messages">
        {c.messages.length === 0 ? (
          <EmptyState text="Сообщений нет" />
        ) : (
          c.messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.direction}`}>
              <div className="msg-meta">
                {m.senderType} · {formatDateTime(m.createdAt)}
                {m.direction === "out" && ` · ${m.deliveryStatus}`}
              </div>
              <div className="msg-body">{m.content}</div>
              {m.error && <div className="err small">{m.error}</div>}
            </div>
          ))
        )}
      </div>

      <div className="reply">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Ответ оператора — уйдёт подписчику в Telegram"
        />
        <div className="reply-actions">
          {notice && <span className="muted small">{notice}</span>}
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !text.trim()}>
            {sending ? "Отправляем…" : "Ответить"}
          </button>
        </div>
      </div>

      <div className="assign">
        <Field
          label="Назначенный оператор"
          hint={
            c.assigneeUserId
              ? `сейчас: ${c.assigneeUserId}`
              : "не назначен; списка операторов API не отдаёт — нужен uuid пользователя"
          }
        >
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="uuid оператора" />
        </Field>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => changeAssignee(assignee.trim())}
            disabled={!assignee.trim()}
          >
            Назначить
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => changeAssignee(null)}
            disabled={!c.assigneeUserId}
          >
            Снять
          </button>
        </div>
      </div>
    </div>
  );
}
