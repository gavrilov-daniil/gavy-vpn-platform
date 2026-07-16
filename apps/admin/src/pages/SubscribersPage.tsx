import { useEffect, useState } from "react";
import { getSubscribers, type Subscriber } from "../api";

function formatTraffic(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, exp)).toFixed(2)} ${units[exp]}`;
}

export default function SubscribersPage() {
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSubscribers()
      .then((data) => {
        if (!cancelled) setSubscribers(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1>Подписчики</h1>
      {error !== null ? (
        <div className="state state-error">Ошибка загрузки: {error}</div>
      ) : subscribers === null ? (
        <div className="state">Загрузка…</div>
      ) : subscribers.length === 0 ? (
        <div className="state">Нет данных</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Username / Telegram ID</th>
              <th>Status</th>
              <th>Expire at</th>
              <th>Used traffic</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((sub) => (
              <tr key={sub.id}>
                <td>{sub.username ?? sub.telegram_id ?? "—"}</td>
                <td>{sub.status}</td>
                <td>{sub.expire_at ?? "—"}</td>
                <td>{formatTraffic(sub.used_traffic_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
