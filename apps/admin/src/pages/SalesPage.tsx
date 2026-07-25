import { useState } from "react";
import {
  createCampaign,
  createCampaignLink,
  errorMessage,
  getCampaigns,
  getCampaignStats,
  getFunnel,
  updateCampaign,
  type Campaign,
  type Funnel,
} from "../api";
import { useResource } from "../useResource";
import {
  formatDateTime,
  formatKopeks,
  formatNumber,
  formatPercent,
  rublesInputToKopeks,
} from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";
import CopyButton from "../components/CopyButton";

const STAGE_LABELS: Record<string, string> = {
  start: "Запуск бота",
  plans_open: "Открыл тарифы",
  plan_selected: "Выбрал тариф",
  pay_method_open: "Открыл оплату",
  payment_created: "Счёт создан",
  payment_paid: "Оплачено",
};

const BOT_KEY = "vpn-admin:bot-username";

export default function SalesPage() {
  const [days, setDays] = useState(30);
  const funnel = useResource(() => getFunnel(days), [days]);
  const campaigns = useResource(getCampaigns);

  const [creating, setCreating] = useState(false);
  const [statsFor, setStatsFor] = useState<Campaign | null>(null);
  const [linkFor, setLinkFor] = useState<Campaign | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bot, setBot] = useState(() => localStorage.getItem(BOT_KEY) ?? "");

  const saveBot = (value: string) => {
    setBot(value);
    localStorage.setItem(BOT_KEY, value);
  };

  const changeStatus = async (campaign: Campaign, status: string) => {
    setActionError(null);
    try {
      await updateCampaign(campaign.id, { status });
      campaigns.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const columns: Column<Campaign>[] = [
    {
      key: "name",
      title: "Кампания",
      render: (c) => (
        <div>
          <div className="strong">{c.name}</div>
          <div className="muted small">{c.slug}</div>
        </div>
      ),
    },
    { key: "channel", title: "Канал", render: (c) => c.channel ?? "—" },
    {
      key: "status",
      title: "Статус",
      render: (c) => (
        <select value={c.status} onChange={(e) => changeStatus(c, e.target.value)}>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="finished">finished</option>
        </select>
      ),
    },
    { key: "cost", title: "Потрачено", align: "right", render: (c) => formatKopeks(c.costKopeks) },
    {
      key: "revenue",
      title: "Выручка",
      align: "right",
      render: (c) => formatKopeks(c.links.reduce((sum, l) => sum + l.revenueKopeks, 0)),
    },
    {
      key: "roi",
      title: "ROI",
      align: "right",
      render: (c) => {
        const revenue = c.links.reduce((sum, l) => sum + l.revenueKopeks, 0);
        return <RoiCell revenueKopeks={revenue} costKopeks={c.costKopeks} />;
      },
    },
    {
      key: "links",
      title: "Ссылки",
      align: "right",
      render: (c) => formatNumber(c.links.length),
    },
    { key: "created", title: "Создана", render: (c) => formatDateTime(c.createdAt) },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (c) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => setStatsFor(c)}>
            Статистика
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setLinkFor(c)}>
            Новая ссылка
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Продажи</h1>
        <div className="head-tools">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 дней</option>
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
          </select>
          <button
            type="button"
            className="btn"
            onClick={() => {
              funnel.reload();
              campaigns.reload();
            }}
          >
            Обновить
          </button>
        </div>
      </div>

      {actionError && <ErrorBox error={actionError} />}

      <Card title="Воронка" subtitle={funnel.data ? `с ${formatDateTime(funnel.data.from)}` : undefined}>
        {funnel.loading && <Loading />}
        {funnel.error && <ErrorBox error={funnel.error} onRetry={funnel.reload} />}
        {funnel.data && <FunnelView funnel={funnel.data} />}
      </Card>

      <Card title="Динамика по дням">
        {funnel.loading && <Loading />}
        {funnel.error && <ErrorBox error={funnel.error} />}
        {funnel.data &&
          (funnel.data.daily.length === 0 ? (
            <EmptyState text="За период нет ни регистраций, ни оплат" />
          ) : (
            <DailyChart daily={funnel.data.daily} />
          ))}
      </Card>

      <Card
        title="Кампании"
        subtitle="ROI считается как (выручка − расход) / расход по денормализованным счётчикам ссылок."
        actions={
          <div className="head-tools">
            <input
              className="search"
              value={bot}
              onChange={(e) => saveBot(e.target.value)}
              placeholder="username бота для ссылок"
            />
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Создать кампанию
            </button>
          </div>
        }
      >
        {campaigns.loading && <Loading />}
        {campaigns.error && <ErrorBox error={campaigns.error} onRetry={campaigns.reload} />}
        {campaigns.data &&
          (campaigns.data.length === 0 ? (
            <EmptyState text="Кампаний нет" hint="Заведите кампанию и сгенерируйте ссылку для рекламы." />
          ) : (
            <Table columns={columns} rows={campaigns.data} rowKey={(c) => c.id} />
          ))}
      </Card>

      {statsFor && <StatsModal campaign={statsFor} bot={bot} onClose={() => setStatsFor(null)} />}
      {linkFor && (
        <LinkModal
          campaign={linkFor}
          bot={bot}
          onClose={() => {
            setLinkFor(null);
            campaigns.reload();
          }}
        />
      )}
      {creating && (
        <CampaignModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            campaigns.reload();
          }}
        />
      )}
    </>
  );
}

function RoiCell({ revenueKopeks, costKopeks }: { revenueKopeks: number; costKopeks: number }) {
  if (costKopeks <= 0) return <span className="muted">—</span>;
  const roi = (revenueKopeks - costKopeks) / costKopeks;
  return <span className={roi >= 0 ? "ok" : "err"}>{formatPercent(roi)}</span>;
}

function FunnelView({ funnel }: { funnel: Funnel }) {
  const max = Math.max(...funnel.stages.map((s) => s.users), 1);
  if (funnel.stages.every((s) => s.users === 0)) {
    return <EmptyState text="За период нет событий воронки" hint="Бот ещё не присылал bot-events." />;
  }

  return (
    <>
      <div className="funnel">
        {funnel.stages.map((stage, i) => {
          const prev = i > 0 ? funnel.stages[i - 1].users : null;
          const conv = prev && prev > 0 ? stage.users / prev : null;
          return (
            <div key={stage.key} className="funnel-row">
              <div className="funnel-label">{STAGE_LABELS[stage.key] ?? stage.key}</div>
              <div className="funnel-bar-wrap">
                <div className="funnel-bar" style={{ width: `${(stage.users / max) * 100}%` }} />
                <span className="funnel-value">
                  {formatNumber(stage.users)} чел · {formatNumber(stage.events)} событий
                </span>
              </div>
              <div className="funnel-conv">{conv === null ? "" : formatPercent(conv)}</div>
            </div>
          );
        })}
      </div>
      <div className="kv">
        <div>
          <span className="kv-key">Старт → оплата</span>
          <span className="kv-val">{formatPercent(funnel.startToPaid)}</span>
        </div>
        <div>
          <span className="kv-key">Выручка за период</span>
          <span className="kv-val">{formatKopeks(funnel.revenueKopeks)}</span>
        </div>
      </div>
    </>
  );
}

function DailyChart({ daily }: { daily: Funnel["daily"] }) {
  const width = 820;
  const height = 200;
  const padding = { left: 8, right: 8, top: 12, bottom: 28 };
  const maxRevenue = Math.max(...daily.map((d) => d.revenueKopeks), 1);
  const slot = (width - padding.left - padding.right) / daily.length;
  const barWidth = Math.max(4, Math.min(28, slot * 0.6));
  const step = Math.ceil(daily.length / 12);

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`}>
      {daily.map((d, i) => {
        const h = ((height - padding.top - padding.bottom) * d.revenueKopeks) / maxRevenue;
        const x = padding.left + slot * i + (slot - barWidth) / 2;
        const y = height - padding.bottom - h;
        return (
          <g key={d.date}>
            <rect x={x} y={y} width={barWidth} height={Math.max(h, d.revenueKopeks > 0 ? 2 : 0)} className="bar">
              <title>
                {d.date}: {formatKopeks(d.revenueKopeks)}, оплат {d.payments}, новых {d.newSubscribers}
              </title>
            </rect>
            {i % step === 0 && (
              <text x={x + barWidth / 2} y={height - 8} className="chart-label" textAnchor="middle">
                {d.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={height - padding.bottom}
        y2={height - padding.bottom}
        className="chart-axis"
      />
    </svg>
  );
}

function StatsModal({ campaign, bot, onClose }: { campaign: Campaign; bot: string; onClose: () => void }) {
  const stats = useResource(() => getCampaignStats(campaign.id), [campaign.id]);

  return (
    <Modal title={`Статистика: ${campaign.name}`} onClose={onClose} wide>
      {stats.loading && <Loading />}
      {stats.error && <ErrorBox error={stats.error} onRetry={stats.reload} />}
      {stats.data && (
        <>
          <div className="kv">
            <div>
              <span className="kv-key">Регистраций</span>
              <span className="kv-val">{formatNumber(stats.data.total.registrations)}</span>
            </div>
            <div>
              <span className="kv-key">Платящих</span>
              <span className="kv-val">{formatNumber(stats.data.total.payingUsers)}</span>
            </div>
            <div>
              <span className="kv-key">Конверсия</span>
              <span className="kv-val">{formatPercent(stats.data.total.conversion)}</span>
            </div>
            <div>
              <span className="kv-key">Выручка</span>
              <span className="kv-val">{formatKopeks(stats.data.total.revenueKopeks)}</span>
            </div>
            <div>
              <span className="kv-key">Расход</span>
              <span className="kv-val">{formatKopeks(stats.data.total.costKopeks)}</span>
            </div>
            <div>
              <span className="kv-key">Прибыль</span>
              <span className={`kv-val ${stats.data.total.profitKopeks >= 0 ? "ok" : "err"}`}>
                {formatKopeks(stats.data.total.profitKopeks)}
              </span>
            </div>
            <div>
              <span className="kv-key">ROI</span>
              <span className="kv-val">
                <RoiCell
                  revenueKopeks={stats.data.total.revenueKopeks}
                  costKopeks={stats.data.total.costKopeks}
                />
              </span>
            </div>
            <div>
              <span className="kv-key">CPA</span>
              <span className="kv-val">
                {stats.data.total.cpaKopeks === null ? "—" : formatKopeks(stats.data.total.cpaKopeks)}
              </span>
            </div>
          </div>

          <h3 className="form-section">Ссылки</h3>
          {stats.data.links.length === 0 ? (
            <EmptyState text="Ссылок нет" />
          ) : (
            <Table
              rows={stats.data.links}
              rowKey={(l) => l.id}
              columns={[
                {
                  key: "code",
                  title: "Ссылка",
                  render: (l) => (
                    <div className="link-cell">
                      <span className="mono">{botLink(bot, l.code)}</span>
                      <CopyButton value={botLink(bot, l.code)} />
                    </div>
                  ),
                },
                { key: "label", title: "Метка", render: (l) => l.label ?? "—" },
                { key: "reg", title: "Регистраций", align: "right", render: (l) => formatNumber(l.registrations) },
                { key: "pay", title: "Платящих", align: "right", render: (l) => formatNumber(l.payingUsers) },
                {
                  key: "revenue",
                  title: "Выручка",
                  align: "right",
                  render: (l) => formatKopeks(l.revenueKopeks),
                },
              ]}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function LinkModal({ campaign, bot, onClose }: { campaign: Campaign; bot: string; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const link = await createCampaignLink(campaign.id, label.trim() || undefined);
      setCreated(botLink(bot, link.code));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Ссылка для «${campaign.name}»`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
          {!created && (
            <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
              {saving ? "Создаём…" : "Сгенерировать"}
            </button>
          )}
        </>
      }
    >
      {created ? (
        <>
          <p>Ссылка готова:</p>
          <div className="link-cell">
            <span className="mono strong">{created}</span>
            <CopyButton value={created} />
          </div>
          {!bot && <p className="warn small">Укажите username бота в шапке списка кампаний — сейчас он подставлен как &lt;bot&gt;.</p>}
        </>
      ) : (
        <Field label="Метка" hint="Чтобы отличать площадки: «пост 1», «сторис», «канал X»">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="пост 1" />
        </Field>
      )}
    </Modal>
  );
}

function CampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [cost, setCost] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!slug.trim() || !name.trim()) {
      setError("нужны slug и название");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createCampaign({
        slug: slug.trim(),
        name: name.trim(),
        channel: channel.trim() || undefined,
        costKopeks: rublesInputToKopeks(cost),
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Новая кампания"
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
        <Field label="Slug" hint="Уникальный, латиницей" required>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="tg-blog-july" />
        </Field>
        <Field label="Название" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Telegram блогер июль" />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Канал">
          <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="tg_channel" />
        </Field>
        <Field label="Расход, ₽" hint="Для расчёта ROI и CPA">
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
        </Field>
      </div>
    </Modal>
  );
}

function botLink(bot: string, code: string): string {
  return `https://t.me/${bot.replace(/^@/, "") || "<bot>"}?start=c_${code}`;
}
