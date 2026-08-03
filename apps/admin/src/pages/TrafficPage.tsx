import { useState } from "react";
import {
  getSubscriptionDevices,
  getTopSubscribers,
  getTrafficOverview,
  type TopSubscriber,
  type TrafficOverview,
} from "../api";
import { useResource } from "../useResource";
import { formatAgo, formatBytes, formatDate, formatNumber } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

const PERIODS = [7, 30, 90];

/** bigint приезжает строкой — складывать до Number() нельзя, получится конкатенация. */
function total(up: string, down: string): number {
  return Number(up) + Number(down);
}

export default function TrafficPage() {
  const [days, setDays] = useState(30);
  const [devicesFor, setDevicesFor] = useState<TopSubscriber | null>(null);

  const overview = useResource(() => getTrafficOverview(days), [days]);
  const top = useResource(() => getTopSubscribers(days, 25), [days]);

  const periodPicker = (
    <div className="head-tools">
      {PERIODS.map((d) => (
        <button key={d} className={d === days ? "btn btn-primary" : "btn"} onClick={() => setDays(d)}>
          {d} дн.
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h1>Трафик</h1>
        {periodPicker}
      </div>

      {overview.error && <ErrorBox error={overview.error} onRetry={overview.reload} />}
      {overview.loading && !overview.data && <Loading />}
      {overview.data && <Overview data={overview.data} />}

      <Card
        title="Кто расходует больше всех"
        subtitle="Байты считаются по подписке: у всех устройств клиента один vless_uuid, разделить их Xray не может"
      >
        {top.error && <ErrorBox error={top.error} onRetry={top.reload} />}
        {top.loading && !top.data && <Loading />}
        {top.data && top.data.length === 0 && (
          <EmptyState text="Данных пока нет" hint="Статистика появится, когда ноды начнут присылать отчёты." />
        )}
        {top.data && top.data.length > 0 && (
          <Table
            columns={topColumns}
            rows={top.data}
            rowKey={(r) => r.shortUuid}
            onRowClick={(r) => setDevicesFor(r)}
          />
        )}
      </Card>

      {devicesFor && <DevicesModal subscriber={devicesFor} onClose={() => setDevicesFor(null)} />}
    </>
  );
}

const topColumns: Column<TopSubscriber>[] = [
  {
    key: "sub",
    title: "Подписка",
    render: (r) => (
      <div>
        <code>{r.shortUuid}</code>
        {r.telegramId != null && <div className="muted">tg {r.telegramId}</div>}
      </div>
    ),
  },
  {
    key: "status",
    title: "Статус",
    render: (r) => r.status ?? <span className="muted">подписка удалена</span>,
  },
  { key: "up", title: "Отдано", align: "right", render: (r) => formatBytes(Number(r.up)) },
  { key: "down", title: "Принято", align: "right", render: (r) => formatBytes(Number(r.down)) },
  {
    key: "total",
    title: "Всего",
    align: "right",
    render: (r) => <strong>{formatBytes(total(r.up, r.down))}</strong>,
  },
];

function Overview({ data }: { data: TrafficOverview }) {
  const { traffic, devices } = data;
  const grand = total(traffic.up, traffic.down);
  const peak = Math.max(1, ...traffic.byDay.map((d) => total(d.up, d.down)));

  return (
    <>
      <Card>
        <div className="kv">
          <Stat label="Всего за период" value={formatBytes(grand)} />
          <Stat label="Отдано" value={formatBytes(Number(traffic.up))} />
          <Stat label="Принято" value={formatBytes(Number(traffic.down))} />
          <Stat label="Подписок с трафиком" value={formatNumber(traffic.subscribers)} />
          <Stat label="Устройств в парке" value={formatNumber(devices.total)} />
        </div>
      </Card>

      <Card title="По дням">
        {traffic.byDay.length === 0 ? (
          <EmptyState text="Данных пока нет" hint="Ноды ещё не присылали отчёты за этот период." />
        ) : (
          <div className="funnel">
            {traffic.byDay.map((d) => {
              const value = total(d.up, d.down);
              return (
                <div key={d.day} className="funnel-row">
                  <div className="funnel-label">{formatDate(d.day)}</div>
                  <div className="funnel-bar-wrap">
                    <div className="funnel-bar" style={{ width: `${(value / peak) * 100}%` }} />
                    <span className="funnel-value">{formatBytes(value)}</span>
                  </div>
                  <div className="funnel-conv" />
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="По странам и нодам">
          {traffic.byNode.length === 0 ? (
            <EmptyState text="Данных пока нет" />
          ) : (
            <Table
              columns={[
                {
                  key: "node",
                  title: "Нода",
                  render: (n) => (
                    <div>
                      {n.country ?? "—"} · {n.nodeName}
                    </div>
                  ),
                },
                {
                  key: "total",
                  title: "Трафик",
                  align: "right",
                  render: (n) => formatBytes(total(n.up, n.down)),
                },
              ]}
              rows={traffic.byNode}
              rowKey={(n) => n.nodeId}
            />
          )}
        </Card>

        <Card
          title="Платформы"
          subtitle="Считаются устройствами, а не байтами — трафик по устройству Xray не разделяет"
        >
          {devices.byPlatform.length === 0 ? (
            <EmptyState text="Устройств пока нет" hint="Появятся, когда клиенты начнут открывать подписку." />
          ) : (
            <Table
              columns={[
                {
                  key: "os",
                  title: "Платформа",
                  render: (p) => p.os ?? <span className="muted">не сообщает hwid</span>,
                },
                { key: "devices", title: "Устройств", align: "right", render: (p) => formatNumber(p.devices) },
                { key: "subs", title: "Подписок", align: "right", render: (p) => formatNumber(p.subscriptions) },
              ]}
              rows={devices.byPlatform}
              rowKey={(p) => p.os ?? "unknown"}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="kv-key">{label}</span>
      <span className="kv-val">{value}</span>
    </div>
  );
}

function DevicesModal({ subscriber, onClose }: { subscriber: TopSubscriber; onClose: () => void }) {
  const devices = useResource(() => getSubscriptionDevices(subscriber.shortUuid), [subscriber.shortUuid]);

  return (
    <Modal title={`Устройства ${subscriber.shortUuid}`} onClose={onClose}>
      {devices.error && <ErrorBox error={devices.error} onRetry={devices.reload} />}
      {devices.loading && !devices.data && <Loading />}
      {devices.data && devices.data.length === 0 && (
        <EmptyState text="Устройств нет" hint="Клиент ещё не открывал подписку в приложении." />
      )}
      {devices.data && devices.data.length > 0 && (
        <Table
          columns={[
            {
              key: "device",
              title: "Устройство",
              render: (d) => (
                <div>
                  <div>{d.deviceModel ?? d.deviceOs ?? "неизвестно"}</div>
                  <div className="muted">
                    {d.deviceOs ?? "—"} {d.osVer ?? ""}
                  </div>
                </div>
              ),
            },
            { key: "hwid", title: "HWID", render: (d) => <code>{d.hwid}</code> },
            { key: "first", title: "Впервые", render: (d) => formatDate(d.firstSeenAt) },
            { key: "last", title: "Последний раз", render: (d) => formatAgo(d.lastSeenAt) },
          ]}
          rows={devices.data}
          rowKey={(d) => d.hwid}
        />
      )}
    </Modal>
  );
}
