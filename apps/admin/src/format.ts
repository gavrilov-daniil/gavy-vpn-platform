const BYTE_UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / Math.pow(1024, exp);
  return `${scaled.toFixed(exp === 0 ? 0 : scaled >= 100 ? 0 : 1).replace(".", ",")} ${BYTE_UNITS[exp]}`;
}

const rubles = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatKopeks(kopeks: number | null | undefined): string {
  return rubles.format(Number(kopeks ?? 0) / 100);
}

export function rublesInputToKopeks(value: string): number {
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateOnly = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateOnly.format(d);
}

export function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} дн назад`;
  return dateOnly.format(d);
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1).replace(".", ",")} %`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n);
}

export function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}
