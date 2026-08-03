import { useState, type ReactNode } from "react";
import {
  FINGERPRINTS,
  INBOUND_FLOWS,
  INBOUND_NETWORKS,
  createConfigProfile,
  createHost,
  createInbound,
  createServer,
  createSquad,
  deleteConfigProfile,
  deleteHost,
  deleteInbound,
  deleteServer,
  deleteSquad,
  errorMessage,
  getConfigProfiles,
  getHosts,
  getInbounds,
  getNodes,
  getServers,
  getSquads,
  updateConfigProfile,
  updateHost,
  updateInbound,
  updateServer,
  updateSquad,
  type ConfigProfile,
  type Host,
  type Inbound,
  type Node,
  type RebuildInfo,
  type Server,
  type Squad,
} from "../api";
import { useResource } from "../useResource";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

type Editing<T> = { kind: "create" } | { kind: "edit"; row: T } | null;

export default function InfraPage() {
  const page = useResource(async () => {
    const [servers, profiles, nodes, inbounds, hosts, squads] = await Promise.all([
      getServers(),
      getConfigProfiles(),
      getNodes(),
      getInbounds(),
      getHosts(),
      getSquads(),
    ]);
    return { servers, profiles, nodes, inbounds, hosts, squads };
  });

  const [serverForm, setServerForm] = useState<Editing<Server>>(null);
  const [profileForm, setProfileForm] = useState<Editing<ConfigProfile>>(null);
  const [inboundForm, setInboundForm] = useState<Editing<Inbound>>(null);
  const [hostForm, setHostForm] = useState<Editing<Host>>(null);
  const [squadForm, setSquadForm] = useState<Editing<Squad>>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const done = (close: () => void) => (rebuilt?: RebuildInfo[]) => {
    close();
    setNotice(describeRebuild(rebuilt));
    page.reload();
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { servers, profiles, nodes, inbounds, hosts, squads } = page.data;
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  const serverColumns: Column<Server>[] = [
    {
      key: "hostname",
      title: "Сервер",
      render: (s) => (
        <div>
          <div className="strong">{s.hostname}</div>
          <div className="muted small mono">{[s.primaryIp, ...s.extraIps].join(", ")}</div>
        </div>
      ),
    },
    { key: "country", title: "Страна", render: (s) => s.country ?? "—" },
    { key: "agent", title: "Агент", render: (s) => <StatusBadge status={s.agentStatus} /> },
    { key: "versions", title: "Версии", render: (s) => [s.agentVersion, s.xrayVersion].filter(Boolean).join(" / ") || "—" },
    {
      key: "ssh",
      title: "SSH",
      render: (s) => (s.hasSshRef ? <span className="ok small">ссылка в vault</span> : <span className="muted">—</span>),
    },
    { key: "nodes", title: "Нод", align: "right", render: (s) => s.nodeCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setServerForm({ kind: "edit", row: s })}>
          Изменить
        </button>
      ),
    },
  ];

  const profileColumns: Column<ConfigProfile>[] = [
    { key: "name", title: "Профиль", render: (p) => <span className="strong">{p.name}</span> },
    {
      key: "node",
      title: "Нода",
      render: (p) => p.nodeName ?? <span className="muted">свободен</span>,
    },
    { key: "inbounds", title: "Inbound'ов", align: "right", render: (p) => p.inboundCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (p) => (
        <button type="button" className="btn btn-sm" onClick={() => setProfileForm({ kind: "edit", row: p })}>
          Изменить
        </button>
      ),
    },
  ];

  const inboundColumns: Column<Inbound>[] = [
    {
      key: "tag",
      title: "Inbound",
      render: (i) => (
        <div>
          <div className="strong mono">{i.tag}</div>
          <div className="muted small">
            {profileName(i.configProfileId)}
            {i.nodeName ? ` → ${i.nodeName}` : " → нода не заведена"}
          </div>
        </div>
      ),
    },
    { key: "port", title: "Порт", align: "right", render: (i) => i.port },
    { key: "transport", title: "Транспорт", render: (i) => `${i.network}/${i.security}${i.flow ? ` +${i.flow}` : ""}` },
    { key: "sni", title: "SNI", render: (i) => i.sni ?? <span className="err">не задан</span> },
    { key: "fp", title: "Fingerprint", render: (i) => i.fingerprint ?? "—" },
    {
      key: "reality",
      title: "Reality",
      render: (i) =>
        i.realityPublicKey ? (
          <span className="mono small">{`${i.realityPublicKey.slice(0, 10)}… / ${i.shortIds.join(",") || "—"}`}</span>
        ) : (
          <span className="warn small">ждёт энроллмента</span>
        ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (i) => (
        <button type="button" className="btn btn-sm" onClick={() => setInboundForm({ kind: "edit", row: i })}>
          Изменить
        </button>
      ),
    },
  ];

  const hostColumns: Column<Host>[] = [
    {
      key: "remark",
      title: "Host",
      render: (h) => (
        <div>
          <div className="strong">{h.remark}</div>
          <div className="muted small mono">
            {h.address}:{h.port}
          </div>
        </div>
      ),
    },
    { key: "inbound", title: "Inbound", render: (h) => <span className="mono small">{h.inboundTag ?? "—"}</span> },
    { key: "node", title: "Нода", render: (h) => h.nodeName ?? "—" },
    {
      key: "reality",
      title: "pbk / sid",
      render: (h) => <span className="mono small">{`${h.pbk ? `${h.pbk.slice(0, 10)}…` : "—"} / ${h.sid ?? "—"}`}</span>,
    },
    { key: "prefix", title: "tagPrefix", render: (h) => h.tagPrefix ?? "—" },
    {
      key: "state",
      title: "Состояние",
      render: (h) =>
        h.isDisabled ? (
          <StatusBadge status="disabled" />
        ) : h.isHidden ? (
          <StatusBadge status="unknown" label="скрыт" />
        ) : (
          <StatusBadge status="active" />
        ),
    },
    { key: "channels", title: "Каналов", align: "right", render: (h) => h.channelCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (h) => (
        <button type="button" className="btn btn-sm" onClick={() => setHostForm({ kind: "edit", row: h })}>
          Изменить
        </button>
      ),
    },
  ];

  const squadColumns: Column<Squad>[] = [
    { key: "name", title: "Squad", render: (s) => <span className="strong">{s.name}</span> },
    {
      key: "inbounds",
      title: "Inbound'ы",
      render: (s) =>
        s.inbounds.length === 0 ? (
          <span className="muted">пусто</span>
        ) : (
          <span className="mono small">{s.inbounds.map((i) => i.tag).join(", ")}</span>
        ),
    },
    { key: "subs", title: "Подписок", align: "right", render: (s) => s.subscriptionCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setSquadForm({ kind: "edit", row: s })}>
          Изменить
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Инфраструктура</h1>
        <button type="button" className="btn" onClick={page.reload}>
          Обновить
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <Card
        title="Серверы"
        subtitle="Физические VPS. SSH-ключ в базе не лежит — только ссылка на него в vault."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setServerForm({ kind: "create" })}>
            Добавить сервер
          </button>
        }
      >
        {servers.length === 0 ? (
          <EmptyState text="Серверов нет" hint="С сервера начинается любая нода." />
        ) : (
          <Table columns={serverColumns} rows={servers} rowKey={(s) => s.id} />
        )}
      </Card>

      <Card
        title="Config-профили"
        subtitle="Набор inbound'ов ноды. Профиль занимает ровно одна нода: Reality-ключи живут на inbound'ах профиля."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setProfileForm({ kind: "create" })}>
            Добавить профиль
          </button>
        }
      >
        {profiles.length === 0 ? (
          <EmptyState text="Профилей нет" hint="Профиль нужен, чтобы завести ноду." />
        ) : (
          <Table columns={profileColumns} rows={profiles} rowKey={(p) => p.id} />
        )}
      </Card>

      <Card
        title="Inbound'ы"
        subtitle="Правка порта или транспорта сразу пересобирает desired-state ноды профиля."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={profiles.length === 0}
            onClick={() => setInboundForm({ kind: "create" })}
          >
            Добавить inbound
          </button>
        }
      >
        {inbounds.length === 0 ? (
          <EmptyState text="Inbound'ов нет" hint="Без inbound'а нода поднимется пустой." />
        ) : (
          <Table columns={inboundColumns} rows={inbounds} rowKey={(i) => i.id} />
        )}
      </Card>

      <Card
        title="Host'ы"
        subtitle="Endpoint'ы для клиента. Отсюда генератор подписки берёт адрес, pbk и sid — правка видна в следующей выдаче."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={inbounds.length === 0 || nodes.length === 0}
            onClick={() => setHostForm({ kind: "create" })}
          >
            Добавить host
          </button>
        }
      >
        {hosts.length === 0 ? (
          <EmptyState text="Host'ов нет" hint="Host привязывает inbound к конкретному адресу и ноде." />
        ) : (
          <Table columns={hostColumns} rows={hosts} rowKey={(h) => h.id} />
        )}
      </Card>

      <Card
        title="Squad'ы"
        subtitle="Access-control: какие inbound'ы получает подписка. Правка состава меняет список клиентов на ноде."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setSquadForm({ kind: "create" })}>
            Добавить squad
          </button>
        }
      >
        {squads.length === 0 ? (
          <EmptyState text="Squad'ов нет" hint="Squad связывает подписки с inbound'ами нод." />
        ) : (
          <Table columns={squadColumns} rows={squads} rowKey={(s) => s.id} />
        )}
      </Card>

      {serverForm && (
        <ServerModal
          row={serverForm.kind === "edit" ? serverForm.row : undefined}
          onClose={() => setServerForm(null)}
          onSaved={done(() => setServerForm(null))}
        />
      )}
      {profileForm && (
        <ProfileModal
          row={profileForm.kind === "edit" ? profileForm.row : undefined}
          onClose={() => setProfileForm(null)}
          onSaved={done(() => setProfileForm(null))}
        />
      )}
      {inboundForm && (
        <InboundModal
          row={inboundForm.kind === "edit" ? inboundForm.row : undefined}
          profiles={profiles}
          onClose={() => setInboundForm(null)}
          onSaved={done(() => setInboundForm(null))}
        />
      )}
      {hostForm && (
        <HostModal
          row={hostForm.kind === "edit" ? hostForm.row : undefined}
          inbounds={inbounds}
          nodes={nodes}
          onClose={() => setHostForm(null)}
          onSaved={done(() => setHostForm(null))}
        />
      )}
      {squadForm && (
        <SquadModal
          row={squadForm.kind === "edit" ? squadForm.row : undefined}
          inbounds={inbounds}
          onClose={() => setSquadForm(null)}
          onSaved={done(() => setSquadForm(null))}
        />
      )}
    </>
  );
}

/** Пересборка — единственный видимый признак, что правка доехала до ноды. */
function describeRebuild(rebuilt?: RebuildInfo[]): string | null {
  if (!rebuilt || rebuilt.length === 0) return "Сохранено. Конфиг нод не затронут.";
  const changed = rebuilt.filter((r) => r.changed);
  if (changed.length === 0) return "Сохранено. Конфиг нод не изменился — версия не поднималась.";
  return `Сохранено. Пересобраны: ${changed.map((r) => `${r.name} → v${r.version}`).join(", ")}`;
}

type SavedHandler = (rebuilt?: RebuildInfo[]) => void;

interface FormShellProps {
  title: string;
  editing: boolean;
  onClose: () => void;
  onSubmit: () => Promise<RebuildInfo[] | undefined>;
  onDelete?: () => Promise<RebuildInfo[] | undefined>;
  deleteHint?: string;
  onSaved: SavedHandler;
  children: ReactNode;
}

/**
 * Общая обвязка форм раздела: сохранение, удаление и показ ошибки сервера.
 * Тексты валидации приходят с бэкенда — дублировать проверки на клиенте значит
 * заводить второй, расходящийся набор правил.
 */
function FormShell({ title, editing, onClose, onSubmit, onDelete, deleteHint, onSaved, children }: FormShellProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<RebuildInfo[] | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await action());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          {editing && onDelete && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                if (window.confirm(deleteHint ?? "Удалить запись?")) void run(onDelete);
              }}
            >
              Удалить
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(onSubmit)}>
            {busy ? "Сохраняем…" : editing ? "Сохранить" : "Создать"}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Пустая строка = «не задано» (null в БД), а не пустое значение. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function toInt(value: string, fallback = 0): number {
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : fallback;
}

function ServerModal({ row, onClose, onSaved }: { row?: Server; onClose: () => void; onSaved: SavedHandler }) {
  const [hostname, setHostname] = useState(row?.hostname ?? "");
  const [primaryIp, setPrimaryIp] = useState(row?.primaryIp ?? "");
  const [extraIps, setExtraIps] = useState((row?.extraIps ?? []).join(", "));
  const [country, setCountry] = useState(row?.country ?? "");
  const [sshRef, setSshRef] = useState("");

  return (
    <FormShell
      title={row ? `Сервер ${row.hostname}` : "Новый сервер"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить сервер? Сработает, только если на нём нет нод."
      onDelete={row ? async () => void (await deleteServer(row.id)) : undefined}
      onSubmit={async () => {
        const body = {
          hostname: hostname.trim(),
          primaryIp: primaryIp.trim(),
          extraIps: toList(extraIps),
          country: orNull(country),
          // пустое поле при правке ничего не меняет: показать текущее значение
          // мы не можем (это указатель на секрет), значит и затирать его молча нельзя
          ...(sshRef.trim() ? { sshRef: sshRef.trim() } : {}),
        };
        if (row) await updateServer(row.id, body);
        else await createServer(body);
        return undefined;
      }}
    >
      <div className="grid-2">
        <Field label="Hostname" required hint="доменное имя сервера">
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="de1.example.com" />
        </Field>
        <Field label="Страна" hint="код: DE, FI, RU">
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={8} placeholder="DE" />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Основной IP" required>
          <input value={primaryIp} onChange={(e) => setPrimaryIp(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Дополнительные IP" hint="через запятую">
          <input value={extraIps} onChange={(e) => setExtraIps(e.target.value)} placeholder="203.0.113.11" />
        </Field>
      </div>
      <Field
        label="Ссылка на SSH-доступ в vault"
        hint={row?.hasSshRef ? "ссылка задана; пустое поле её не меняет" : "именно ссылка, не ключ: ключей в БД нет"}
      >
        <input value={sshRef} onChange={(e) => setSshRef(e.target.value)} placeholder="vault://projects/vpn/ssh/de1" />
      </Field>
    </FormShell>
  );
}

function ProfileModal({ row, onClose, onSaved }: { row?: ConfigProfile; onClose: () => void; onSaved: SavedHandler }) {
  const [name, setName] = useState(row?.name ?? "");

  return (
    <FormShell
      title={row ? `Профиль «${row.name}»` : "Новый config-профиль"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить профиль? Сработает, только если на нём нет ноды и inbound'ов."
      onDelete={row ? async () => void (await deleteConfigProfile(row.id)) : undefined}
      onSubmit={async () => {
        if (row) return (await updateConfigProfile(row.id, { name: name.trim() })).rebuilt;
        await createConfigProfile({ name: name.trim() });
        return undefined;
      }}
    >
      <Field label="Название" required hint="под одну ноду: DE-exit, RU2-relay">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="de1-exit" />
      </Field>
      {row?.nodeName && <p className="muted small">Профиль занят нодой «{row.nodeName}».</p>}
    </FormShell>
  );
}

function InboundModal({
  row,
  profiles,
  onClose,
  onSaved,
}: {
  row?: Inbound;
  profiles: ConfigProfile[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [configProfileId, setConfigProfileId] = useState(row?.configProfileId ?? profiles[0]?.id ?? "");
  const [tag, setTag] = useState(row?.tag ?? "");
  const [port, setPort] = useState(String(row?.port ?? 443));
  const [network, setNetwork] = useState(row?.network ?? "tcp");
  const [flow, setFlow] = useState(row?.flow ?? "xtls-rprx-vision");
  const [sni, setSni] = useState(row?.sni ?? "");
  const [fingerprint, setFingerprint] = useState(row?.fingerprint ?? "firefox");
  const [shortIds, setShortIds] = useState((row?.shortIds ?? []).join(", "));
  const [privkeyRef, setPrivkeyRef] = useState("");

  return (
    <FormShell
      title={row ? `Inbound ${row.tag}` : "Новый inbound"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить inbound? Сработает, только если его не держат squad, host или каскад."
      onDelete={row ? async () => (await deleteInbound(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const common = {
          tag: tag.trim(),
          port: toInt(port, 0),
          network,
          flow,
          sni: orNull(sni),
          fingerprint,
          shortIds: toList(shortIds),
          ...(privkeyRef.trim() ? { realityPrivkeyRef: privkeyRef.trim() } : {}),
        };
        if (row) return (await updateInbound(row.id, common)).rebuilt;
        return (await createInbound({ configProfileId, ...common })).rebuilt;
      }}
    >
      <Field label="Config-профиль" required hint={row ? "профиль inbound'а не меняется" : "профиль ноды, которой он принадлежит"}>
        <select value={configProfileId} onChange={(e) => setConfigProfileId(e.target.value)} disabled={Boolean(row)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.nodeName ? ` (${p.nodeName})` : ""}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Тег" required hint="буквы, цифры, . _ - ; на него ссылаются каскады">
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="VLESS_REALITY_DE" />
        </Field>
        <Field label="Порт" required>
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Транспорт">
          <select value={network} onChange={(e) => setNetwork(e.target.value)}>
            {INBOUND_NETWORKS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flow" hint="vision работает только на tcp">
          <select value={flow} onChange={(e) => setFlow(e.target.value)}>
            {INBOUND_FLOWS.map((f) => (
              <option key={f || "none"} value={f}>
                {f || "без flow"}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="SNI" required hint="обязателен для reality">
          <input value={sni} onChange={(e) => setSni(e.target.value)} placeholder="ads.x5.ru" />
        </Field>
        <Field label="Fingerprint">
          <select value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}>
            {FINGERPRINTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="shortIds" hint="hex чётной длины, через запятую; обычно приезжают с ноды при энроллменте">
        <input value={shortIds} onChange={(e) => setShortIds(e.target.value)} placeholder="aa01, bb02" />
      </Field>

      <Field
        label="Ссылка на приватник Reality в vault"
        hint={
          row?.hasRealityPrivkeyRef
            ? "ссылка задана; пустое поле её не меняет"
            : "приватник живёт на ноде, в БД только ссылка"
        }
      >
        <input value={privkeyRef} onChange={(e) => setPrivkeyRef(e.target.value)} placeholder="vault://…" />
      </Field>

      {row && !row.realityPublicKey && (
        <p className="muted small">
          Публичного ключа ещё нет: он приезжает с ноды при энроллменте агента и тогда же попадает в host'ы этой ноды.
        </p>
      )}
    </FormShell>
  );
}

function HostModal({
  row,
  inbounds,
  nodes,
  onClose,
  onSaved,
}: {
  row?: Host;
  inbounds: Inbound[];
  nodes: Node[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [inboundId, setInboundId] = useState(row?.inboundId ?? inbounds[0]?.id ?? "");
  const [nodeId, setNodeId] = useState(row?.nodeId ?? nodes[0]?.id ?? "");
  const [remark, setRemark] = useState(row?.remark ?? "");
  const [address, setAddress] = useState(row?.address ?? "");
  const [port, setPort] = useState(String(row?.port ?? 443));
  const [sni, setSni] = useState(row?.sni ?? "");
  const [fingerprint, setFingerprint] = useState(row?.fingerprint ?? "firefox");
  const [pbk, setPbk] = useState(row?.pbk ?? "");
  const [sid, setSid] = useState(row?.sid ?? "");
  const [flow, setFlow] = useState(row?.flow ?? "xtls-rprx-vision");
  const [tagPrefix, setTagPrefix] = useState(row?.tagPrefix ?? "");
  const [isHidden, setIsHidden] = useState(row?.isHidden ?? false);
  const [isDisabled, setIsDisabled] = useState(row?.isDisabled ?? false);
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0));

  return (
    <FormShell
      title={row ? `Host «${row.remark}»` : "Новый host"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить host? Сработает, только если на него не ссылается канал подписки."
      onDelete={row ? async () => (await deleteHost(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const body = {
          inboundId,
          nodeId,
          remark: remark.trim(),
          address: address.trim(),
          port: toInt(port, 0),
          sni: orNull(sni),
          fingerprint,
          pbk: orNull(pbk),
          sid: orNull(sid),
          flow,
          tagPrefix: orNull(tagPrefix),
          isHidden,
          isDisabled,
          sortOrder: toInt(sortOrder),
        };
        if (row) return (await updateHost(row.id, body)).rebuilt;
        return (await createHost(body)).rebuilt;
      }}
    >
      <div className="grid-2">
        <Field label="Inbound" required>
          <select value={inboundId} onChange={(e) => setInboundId(e.target.value)}>
            {inbounds.map((i) => (
              <option key={i.id} value={i.id}>
                {i.tag}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Нода" required hint="чью Reality-личность обслуживает этот адрес">
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Название" required hint="видно оператору, не клиенту">
          <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="DE direct" />
        </Field>
        <Field label="tagPrefix" hint="front — если это RU-front для client-chain">
          <input value={tagPrefix} onChange={(e) => setTagPrefix(e.target.value)} placeholder="" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Адрес" required hint="IP или домен">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Порт" required>
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="SNI">
          <input value={sni} onChange={(e) => setSni(e.target.value)} placeholder="ads.x5.ru" />
        </Field>
        <Field label="Fingerprint">
          <select value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}>
            {FINGERPRINTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="pbk" hint="перезапишется при энроллменте ноды">
          <input value={pbk} onChange={(e) => setPbk(e.target.value)} />
        </Field>
        <Field label="sid" hint="один из shortIds инбаунда">
          <input value={sid} onChange={(e) => setSid(e.target.value)} placeholder="aa01" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Flow">
          <select value={flow} onChange={(e) => setFlow(e.target.value)}>
            {INBOUND_FLOWS.map((f) => (
              <option key={f || "none"} value={f}>
                {f || "без flow"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Порядок" hint="меньше — выше в выдаче">
          <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Выключен" hint="выключенный host исчезает из подписки">
          <Toggle checked={isDisabled} onChange={setIsDisabled} label={isDisabled ? "да" : "нет"} />
        </Field>
        <Field label="Скрыт" hint="скрытый тоже не попадает в выдачу">
          <Toggle checked={isHidden} onChange={setIsHidden} label={isHidden ? "да" : "нет"} />
        </Field>
      </div>
    </FormShell>
  );
}

function SquadModal({
  row,
  inbounds,
  onClose,
  onSaved,
}: {
  row?: Squad;
  inbounds: Inbound[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [selected, setSelected] = useState<string[]>((row?.inbounds ?? []).map((i) => i.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  return (
    <FormShell
      title={row ? `Squad «${row.name}»` : "Новый squad"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить squad? Сработает, только если к нему не привязаны подписки и тарифы."
      onDelete={row ? async () => (await deleteSquad(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const body = { name: name.trim(), inboundIds: selected };
        if (row) return (await updateSquad(row.id, body)).rebuilt;
        return (await createSquad(body)).rebuilt;
      }}
    >
      <Field label="Название" required>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Базовый доступ" />
      </Field>

      <h3 className="form-section">Inbound'ы</h3>
      {inbounds.length === 0 ? (
        <p className="muted small">Inbound'ов пока нет — привязывать нечего.</p>
      ) : (
        <div className="checks">
          {inbounds.map((i) => (
            <label key={i.id} className="check">
              <input
                type="checkbox"
                checked={selected.includes(i.id)}
                onChange={(e) => toggle(i.id, e.target.checked)}
              />
              <span className="mono">{i.tag}</span>
              <span className="muted small">{i.nodeName ?? "нода не заведена"}</span>
            </label>
          ))}
        </div>
      )}
      <p className="muted small">
        Набор заменяется целиком: снятая галочка убирает подписчиков squad'а с этого inbound'а на ноде.
      </p>
    </FormShell>
  );
}
