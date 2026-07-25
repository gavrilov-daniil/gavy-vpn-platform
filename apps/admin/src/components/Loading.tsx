export default function Loading({ text = "Загрузка…" }: { text?: string }) {
  return <div className="loading">{text}</div>;
}
