import type { XrayConfig } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Инвариант-валидатор. Нарушение любого пункта = молчаливый отвал клиента,
 * поэтому конфиг НЕ публикуется, пока не пройдёт. Спайк 1 сверяет ещё и byte-diff с Remnawave.
 */
export function validateConfig(config: XrayConfig): ValidationResult {
  const errors: string[] = [];
  const routing = (config.routing ?? {}) as Record<string, unknown>;
  const outbounds = (config.outbounds ?? []) as Array<Record<string, unknown>>;
  const inbounds = (config.inbounds ?? []) as Array<Record<string, unknown>>;
  const balancers = (routing.balancers ?? []) as Array<Record<string, unknown>>;
  const rules = (routing.rules ?? []) as Array<Record<string, unknown>>;
  const outboundTags = new Set(outbounds.map((o) => String(o.tag)));

  // 1. никаких geoip:/geosite: (валят XrayCore в Happ)
  const raw = JSON.stringify(config);
  if (/geoip:|geosite:/.test(raw)) {
    errors.push("найдено geoip:/geosite: — в Happ нет geo-баз, XrayCore упадёт");
  }

  // 2. freedom-outbound назван ровно "freedom"
  if (!outboundTags.has("freedom")) {
    errors.push('нет outbound с тегом "freedom" (локальный direct для РФ-трафика)');
  }

  // 3. селектор балансера префиксный: ни один префикс не должен цеплять "freedom",
  //    и каждый элемент селектора должен резолвиться в существующий outbound.
  for (const b of balancers) {
    const sel = (b.selector ?? []) as string[];
    for (const s of sel) {
      if ("freedom".startsWith(s)) {
        errors.push(`селектор балансера "${b.tag}" содержит "${s}" — префиксно зацепит freedom, рунет уйдёт в туннель`);
      }
      const matches = [...outboundTags].some((tag) => tag.startsWith(s));
      if (!matches) errors.push(`селектор "${s}" балансера "${b.tag}" не матчит ни один outbound`);
    }
  }

  // 4. loopback-цепочка целостна; последний tier — без fallbackTag
  const balancerByTag = new Map(balancers.map((b) => [String(b.tag), b]));
  const loopbackOutByTag = new Map(
    outbounds.filter((o) => o.protocol === "loopback").map((o) => [String(o.tag), o]),
  );
  const dokodemoByTag = new Map(
    inbounds.filter((i) => i.protocol === "dokodemo-door").map((i) => [String(i.tag), i]),
  );
  let terminalCount = 0;
  for (const b of balancers) {
    const fb = b.fallbackTag as string | undefined;
    if (!fb) {
      terminalCount++;
      continue;
    }
    const lo = loopbackOutByTag.get(fb);
    if (!lo) {
      errors.push(`balancer "${b.tag}" fallbackTag="${fb}" не ссылается на loopback-outbound`);
      continue;
    }
    const loInTag = String((lo.settings as Record<string, unknown>)?.inboundTag ?? "");
    const dk = dokodemoByTag.get(loInTag);
    if (!dk) {
      errors.push(`loopback "${fb}" → inboundTag "${loInTag}" не найден как dokodemo-door`);
      continue;
    }
    if (dk.listen !== "127.0.0.1" || dk.port !== 0) {
      errors.push(`dokodemo "${loInTag}" должен быть listen 127.0.0.1, port 0`);
    }
    const net = String((dk.settings as Record<string, unknown>)?.network ?? "");
    if (!net.includes("tcp") || !net.includes("udp")) {
      errors.push(`dokodemo "${loInTag}" network должен быть "tcp,udp" (сейчас "${net}")`);
    }
    const reinject = rules.find(
      (r) => Array.isArray(r.inboundTag) && (r.inboundTag as string[]).includes(loInTag) && r.balancerTag,
    );
    if (!reinject) {
      errors.push(`нет routing-rule inboundTag:["${loInTag}"] → следующий tier (loopback молча сломан)`);
    }
  }
  if (balancers.length > 0 && terminalCount === 0) {
    errors.push("нет ни одного балансера без fallbackTag — вечная петля реинжекта при полном отказе");
  }

  // 5. routing balancerTag ссылается на существующий балансер
  for (const r of rules) {
    if (r.balancerTag && !balancerByTag.has(String(r.balancerTag))) {
      errors.push(`routing-rule ссылается на несуществующий balancerTag "${r.balancerTag}"`);
    }
  }

  // 6. observatory top-level, subjectSelector ⊇ union всех selector
  const obs = config.observatory as Record<string, unknown> | undefined;
  if (!obs) {
    errors.push("нет top-level observatory (burstObservatory не использовать — баг Xray #5897)");
  } else {
    const subj = new Set((obs.subjectSelector ?? []) as string[]);
    for (const b of balancers) {
      for (const s of (b.selector ?? []) as string[]) {
        if (!subj.has(s)) errors.push(`observatory.subjectSelector не содержит "${s}" — забытая нода не меряется`);
      }
    }
  }

  // 7. domainStrategy AsIs
  if (routing.domainStrategy && routing.domainStrategy !== "AsIs") {
    errors.push(`routing.domainStrategy должен быть "AsIs" (сейчас "${routing.domainStrategy}")`);
  }

  return { ok: errors.length === 0, errors };
}
