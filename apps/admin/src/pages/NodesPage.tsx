import { useEffect, useState } from "react";
import { getNodes, type Node } from "../api";

export default function NodesPage() {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNodes()
      .then((data) => {
        if (!cancelled) setNodes(data);
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
      <h1>Ноды</h1>
      {error !== null ? (
        <div className="state state-error">Ошибка загрузки: {error}</div>
      ) : nodes === null ? (
        <div className="state">Загрузка…</div>
      ) : nodes.length === 0 ? (
        <div className="state">Нет данных</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id}>
                <td>{node.name}</td>
                <td>{node.roles.join(", ")}</td>
                <td>{node.status}</td>
                <td>{node.last_heartbeat_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
