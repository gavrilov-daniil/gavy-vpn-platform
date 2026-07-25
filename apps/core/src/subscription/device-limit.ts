/**
 * Занимает ли устройство слот hwid-лимита.
 *
 * `activeHwids` — устройства подписки, виденные внутри окна, отсортированные по
 * first_seen_at. Слоты держат самые РАННИЕ: сортировка по last_seen_at заставила бы
 * лишнее устройство вытеснять рабочее на каждом опросе, и оба клиента моргали бы
 * по очереди вместо честного «этот сверх лимита».
 *
 * `limit <= 0` — лимита нет (в схеме hwid_device_limit nullable).
 */
export function isDeviceWithinLimit(activeHwids: string[], limit: number, hwid: string): boolean {
  if (limit <= 0) return true;
  return activeHwids.slice(0, limit).includes(hwid);
}
