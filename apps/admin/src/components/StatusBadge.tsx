type Tone = "ok" | "warn" | "err" | "muted" | "info";

const TONES: Record<string, Tone> = {
  active: "ok",
  ok: "ok",
  live: "ok",
  done: "ok",
  sent: "ok",
  paid: "ok",
  resolved: "ok",
  open: "info",
  running: "info",
  trial: "info",
  proposed: "info",
  accepted: "ok",
  edited: "warn",
  rejected: "muted",
  planned: "muted",
  draft: "muted",
  scheduled: "info",
  pending: "warn",
  exit_ready: "warn",
  relay_ready: "warn",
  provisioning: "warn",
  test: "warn",
  paused: "warn",
  retiring: "warn",
  expiring: "warn",
  inactive: "muted",
  closed: "muted",
  skipped: "muted",
  finished: "muted",
  unknown: "muted",
  disabled: "err",
  suspended: "err",
  expired: "err",
  failed: "err",
  canceled: "err",
  error: "err",
};

const LABELS: Record<string, string> = {
  active: "активна",
  provisioning: "разворачивается",
  planned: "план",
  exit_ready: "exit готов",
  relay_ready: "relay готов",
  retiring: "выводится",
  open: "открыт",
  pending: "ожидает",
  resolved: "решён",
  closed: "закрыт",
  draft: "черновик",
  scheduled: "запланирована",
  running: "идёт",
  done: "завершена",
  canceled: "отменена",
  trial: "триал",
  expired: "истекла",
  suspended: "приостановлена",
  disabled: "отключена",
  inactive: "неактивен",
  paused: "на паузе",
  finished: "завершена",
  live: "live",
  test: "test",
  sent: "отправлено",
  proposed: "предложена",
  accepted: "принята",
  edited: "с правками",
  rejected: "отклонена",
  failed: "ошибка",
  skipped: "пропущено",
  unknown: "неизвестно",
};

interface Props {
  status: string;
  tone?: Tone;
  label?: string;
}

export default function StatusBadge({ status, tone, label }: Props) {
  const resolved = tone ?? TONES[status] ?? "muted";
  return <span className={`badge badge-${resolved}`}>{label ?? LABELS[status] ?? status}</span>;
}
