/** Счётчик сущности: сколько было в панели, сколько завели, сколько обновили, сколько не смогли. */
export interface EntityCount {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface ImportReport {
  dryRun: boolean;
  /** adopted — подписка, созданная ботом до импорта, переведена на идентичность панели. */
  users: { total: number; created: number; updated: number; adopted: number; skipped: number };
  squads: { total: number; created: number };
  /** Связи squad→inbound. Без них squad ничего не открывает и клиента нет ни на одной ноде. */
  squadInbounds: { total: number; created: number };
  devices: { total: number; created: number };
  servers: EntityCount;
  /** У нас 1 профиль = 1 нода, поэтому профилей будет столько же, сколько нод, а не сколько в панели. */
  configProfiles: EntityCount;
  nodes: EntityCount;
  inbounds: EntityCount;
  hosts: EntityCount;
  /**
   * Подписки без единого squad'а — конфиг отдаётся, доступа к нодам нет.
   * В dry-run считается по данным панели (юзер без активных squad'ов),
   * при записи — по факту в нашей БД.
   */
  subscriptionsWithoutSquad: number;
  warnings: string[];
}

export function emptyReport(dryRun: boolean): ImportReport {
  return {
    dryRun,
    users: { total: 0, created: 0, updated: 0, adopted: 0, skipped: 0 },
    squads: { total: 0, created: 0 },
    squadInbounds: { total: 0, created: 0 },
    devices: { total: 0, created: 0 },
    servers: entity(),
    configProfiles: entity(),
    nodes: entity(),
    inbounds: entity(),
    hosts: entity(),
    subscriptionsWithoutSquad: 0,
    warnings: [],
  };
}

function entity(): EntityCount {
  return { total: 0, created: 0, updated: 0, skipped: 0 };
}
