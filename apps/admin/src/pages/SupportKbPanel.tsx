import { useState } from "react";
import {
  createKbDocument,
  errorMessage,
  getKbDocuments,
  searchKbDocuments,
  updateKbDocument,
  type KbDocument,
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

/** База знаний: то, на что опирается подсказка ИИ. Без неё подсказки будут пустыми. */
export default function SupportKbPanel() {
  const docs = useResource(() => getKbDocuments());
  const [editing, setEditing] = useState<{ doc: KbDocument | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; title: string }[] | null>(null);

  const toggleActive = async (doc: KbDocument, next: boolean) => {
    setBusyId(doc.id);
    setActionError(null);
    try {
      await updateKbDocument(doc.id, { isActive: next });
      docs.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const runSearch = async () => {
    setActionError(null);
    try {
      setFound(await searchKbDocuments(query.trim()));
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  if (docs.loading) return <Loading />;
  if (docs.error) return <ErrorBox error={docs.error} onRetry={docs.reload} />;
  if (!docs.data) return null;

  const columns: Column<KbDocument>[] = [
    {
      key: "title",
      title: "Документ",
      render: (d) => (
        <div>
          <div className="strong">{d.title}</div>
          <div className="muted small">{d.body.slice(0, 120)}…</div>
        </div>
      ),
    },
    { key: "source", title: "Источник", render: (d) => d.source ?? "—" },
    { key: "updated", title: "Изменён", render: (d) => formatDateTime(d.updatedAt) },
    {
      key: "active",
      title: "В поиске",
      render: (d) => (
        <Toggle checked={d.isActive} disabled={busyId === d.id} onChange={(next) => toggleActive(d, next)} />
      ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (d) => (
        <button type="button" className="btn btn-sm" onClick={() => setEditing({ doc: d })}>
          Править
        </button>
      ),
    },
  ];

  return (
    <>
      {actionError && <ErrorBox error={actionError} />}

      <Card
        title="База знаний"
        subtitle="Из этих документов ИИ берёт факты. Выключенный документ не попадает в подсказки, но остаётся виден в старых."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ doc: null })}>
            Добавить документ
          </button>
        }
      >
        {docs.data.length === 0 ? (
          <EmptyState text="Документов нет" hint="Без базы знаний подсказка предложит эскалацию на оператора." />
        ) : (
          <Table columns={columns} rows={docs.data} rowKey={(d) => d.id} />
        )}
      </Card>

      <Card title="Проверка поиска" subtitle="Что именно уйдёт в модель по такому вопросу клиента.">
        <div className="inline-form">
          <Field label="Вопрос клиента">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="не подключается Германия" />
          </Field>
          <button type="button" className="btn" onClick={runSearch} disabled={!query.trim()}>
            Найти
          </button>
        </div>
        {found && (
          <div className="stats-inline">
            {found.length === 0 ? (
              <span className="muted">ничего не найдено — подсказка предложит эскалацию</span>
            ) : (
              found.map((d) => <StatusBadge key={d.id} status="info" label={d.title} />)
            )}
          </div>
        )}
      </Card>

      {editing && (
        <KbModal
          doc={editing.doc}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            docs.reload();
          }}
        />
      )}
    </>
  );
}

function KbModal({ doc, onClose, onSaved }: { doc: KbDocument | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [source, setSource] = useState(doc?.source ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || !body.trim()) {
      setError("нужны заголовок и текст");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (doc) await updateKbDocument(doc.id, { title, body, source: source.trim() || null });
      else await createKbDocument({ title, body, source: source.trim() || undefined });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={doc ? `Документ «${doc.title}»` : "Новый документ"}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </>
      }
    >
      <Field label="Заголовок" required>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Подключение Германии" />
      </Field>
      <Field label="Текст" hint="Факты, на которые модели можно ссылаться: условия, шаги, ограничения." required>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
      </Field>
      <Field label="Источник" hint="Откуда взят текст — ссылка или название раздела">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="docs/subscription.md" />
      </Field>
    </Modal>
  );
}
