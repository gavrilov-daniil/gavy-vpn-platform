import { getPlans, type Plan } from "../api";
import { useResource } from "../useResource";
import { formatKopeks } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

export default function PlansPage() {
  const plans = useResource(getPlans);

  const columns: Column<Plan>[] = [
    {
      key: "title",
      title: "Тариф",
      render: (p) => (
        <div>
          <div className="strong">{p.title}</div>
          <div className="muted small mono">{p.code}</div>
        </div>
      ),
    },
    { key: "period", title: "Период", align: "right", render: (p) => `${p.periodDays} дн` },
    { key: "price", title: "Цена", align: "right", render: (p) => formatKopeks(p.priceKopeks) },
    { key: "traffic", title: "Трафик", align: "right", render: (p) => (p.trafficGb ? `${p.trafficGb} ГБ` : "без лимита") },
    {
      key: "devices",
      title: "Устройств",
      align: "right",
      render: (p) => (p.deviceLimit ? String(p.deviceLimit) : "без лимита"),
    },
    { key: "trial", title: "Триал", render: (p) => (p.isTrial ? <StatusBadge status="ok" label="да" /> : "—") },
    { key: "squads", title: "Squad'ы", align: "right", render: (p) => p.squadIds.length },
    { key: "sort", title: "Порядок", align: "right", render: (p) => p.sortOrder },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Тарифы</h1>
        <button type="button" className="btn" onClick={plans.reload}>
          Обновить
        </button>
      </div>

      <Card
        title="Активные тарифы"
        subtitle="Только просмотр: эндпоинтов создания и правки тарифов в API пока нет."
      >
        {plans.loading && <Loading />}
        {plans.error && <ErrorBox error={plans.error} onRetry={plans.reload} />}
        {plans.data &&
          (plans.data.length === 0 ? (
            <EmptyState text="Активных тарифов нет" hint="Тарифы заводятся сидингом или напрямую в БД." />
          ) : (
            <Table columns={columns} rows={plans.data} rowKey={(p) => p.id} />
          ))}
      </Card>
    </>
  );
}
