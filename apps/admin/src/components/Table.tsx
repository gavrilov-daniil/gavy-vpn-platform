import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  title: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeKey?: string | null;
}

export default function Table<T>({ columns, rows, rowKey, onRowClick, activeKey }: Props<T>) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? "left" }}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={`${onRowClick ? "row-clickable" : ""} ${activeKey === key ? "row-active" : ""}`.trim()}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
