import type { ReactNode } from "react";

interface Props {
  text: string;
  hint?: ReactNode;
}

export default function EmptyState({ text, hint }: Props) {
  return (
    <div className="empty">
      <div className="empty-text">{text}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}
