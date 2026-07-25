import type { OverviewDto, PlanDto } from "../core-api/core-api.client.js";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatMoney(kopeks: number): string {
  const rubles = kopeks / 100;
  const text = Number.isInteger(rubles) ? String(rubles) : rubles.toFixed(2);
  return `${text.replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "бессрочно";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} ГБ`;
  return `${(bytes / 1024 ** 2).toFixed(0)} МБ`;
}

export function planLimits(plan: PlanDto): string {
  const parts = [`${plan.periodDays} дн.`];
  parts.push(plan.trafficGb ? `${plan.trafficGb} ГБ` : "безлимит");
  if (plan.deviceLimit) parts.push(`${plan.deviceLimit} устр.`);
  return parts.join(" · ");
}

export const messages = {
  home: (name: string) =>
    [
      `Привет, ${escapeHtml(name)}!`,
      "",
      "Быстрый VPN без рекламы и логов: 4 страны, автопереключение при блокировках, работает на всех устройствах.",
      "",
      "Выберите, с чего начать:",
    ].join("\n"),

  plansHeader: "<b>Тарифы</b>\n\nЧем длиннее период — тем дешевле месяц. Оплата разовая, автосписаний нет.",

  plansEmpty: "Тарифы временно недоступны. Мы уже чиним — загляните через пару минут.",

  planCard: (plan: PlanDto) =>
    [
      `<b>${escapeHtml(plan.title)}</b>`,
      planLimits(plan),
      "",
      `Стоимость: <b>${formatMoney(plan.priceKopeks)}</b>`,
      "",
      "Выберите способ оплаты:",
    ].join("\n"),

  methodsEmpty: "Оплата временно недоступна. Напишите в поддержку — подключим вручную.",

  payLink: (plan: PlanDto) =>
    [
      `<b>${escapeHtml(plan.title)}</b> — ${formatMoney(plan.priceKopeks)}`,
      "",
      "Счёт создан. Нажмите кнопку ниже, чтобы оплатить.",
      "Доступ откроется автоматически сразу после оплаты.",
    ].join("\n"),

  starsInvoiceDescription: (plan: PlanDto) => `${plan.title} · ${planLimits(plan)}`,

  topupHeader: (balanceKopeks: number) =>
    [
      `<b>Баланс:</b> ${formatMoney(balanceKopeks)}`,
      "",
      "Пополните счёт — деньги спишутся при продлении подписки.",
      "Выберите сумму и способ оплаты:",
    ].join("\n"),

  topupLink: (amountKopeks: number) =>
    `Счёт на <b>${formatMoney(amountKopeks)}</b> создан. Нажмите кнопку ниже, чтобы оплатить.`,

  status: (o: OverviewDto) => {
    if (!o.subscription) {
      return [
        "<b>Подписка</b>",
        "",
        "Активной подписки нет.",
        "Начните с бесплатного пробного периода или выберите тариф.",
      ].join("\n");
    }
    const s = o.subscription;
    const lines = [
      "<b>Подписка</b>",
      "",
      `Статус: <b>${statusLabel(s.status)}</b>`,
      `Действует до: ${formatDate(s.expireAt)}`,
      `Трафик: ${formatBytes(s.usedTrafficBytes)}${s.trafficLimitBytes ? ` из ${formatBytes(s.trafficLimitBytes)}` : " (безлимит)"}`,
    ];
    if (s.deviceLimit) lines.push(`Устройств: до ${s.deviceLimit}`);
    lines.push("", "Ссылка подписки — по кнопке ниже.");
    return lines.join("\n");
  },

  subscriptionMissing: "Сначала оформите подписку или активируйте пробный период.",

  trialOffer: [
    "<b>Пробный период</b>",
    "",
    "Дадим доступ бесплатно — без карты и автопродления.",
    "Подключение занимает пару минут: ставите приложение, открываете ссылку, готово.",
  ].join("\n"),

  trialUsed: "Пробный период уже использован. Выберите тариф — там полная скорость и все страны.",

  trialActivated: (expireAt?: string) =>
    [
      "<b>Готово, доступ открыт.</b>",
      expireAt ? `Пробный период действует до ${formatDate(expireAt)}.` : "",
      "",
      "Нажмите «Подключиться» и следуйте инструкции.",
    ]
      .filter(Boolean)
      .join("\n"),

  balance: (o: OverviewDto) => `<b>Баланс:</b> ${formatMoney(o.balanceKopeks)}`,

  referral: (o: OverviewDto, link: string) =>
    [
      "<b>Приглашайте друзей</b>",
      "",
      "За каждого друга, который оплатит подписку, начислим бонус на баланс.",
      "",
      `Приглашено: <b>${o.referral.invitedCount}</b>`,
      `Заработано: <b>${formatMoney(o.referral.earnedKopeks)}</b>`,
      "",
      "Ваша ссылка:",
      `<code>${escapeHtml(link)}</code>`,
    ].join("\n"),

  devices: (o: OverviewDto) => {
    if (o.devices.length === 0) {
      return "<b>Устройства</b>\n\nПодключённых устройств пока нет. Откройте ссылку подписки в приложении — устройство появится здесь.";
    }
    const rows = o.devices.map((d) => {
      const title = escapeHtml(d.model ?? d.os ?? "Устройство");
      return `• ${title}${d.lastSeenAt ? ` — был(о) ${formatDate(d.lastSeenAt)}` : ""}`;
    });
    return ["<b>Устройства</b>", "", ...rows].join("\n");
  },

  instructions: (subscriptionUrl: string | null, happUrl: string) =>
    [
      "<b>Как подключиться</b>",
      "",
      "1. Установите приложение Happ по кнопке ниже.",
      "2. Откройте ссылку подписки — профили добавятся сами.",
      "3. Выберите страну и нажмите «Подключить».",
      "",
      subscriptionUrl ? "Ссылка подписки — по кнопке ниже." : "Ссылка появится после оформления подписки.",
      "",
      `Приложение: ${escapeHtml(happUrl)}`,
    ].join("\n"),

  supportPrompt:
    "<b>Поддержка</b>\n\nОпишите проблему одним сообщением — оператор ответит прямо здесь. Если не работает подключение, укажите страну и устройство.",

  supportReceived: "Сообщение принято, оператор скоро ответит. Обычно отвечаем в течение часа.",

  supportOnlyText: "Пока принимаем только текст. Опишите проблему сообщением.",

  paymentSuccess: (confirm: { planTitle?: string; expireAt?: string }) =>
    [
      "<b>Оплата прошла.</b>",
      confirm.planTitle ? `Тариф: ${escapeHtml(confirm.planTitle)}` : "",
      confirm.expireAt ? `Действует до ${formatDate(confirm.expireAt)}.` : "",
      "",
      "Доступ уже активен — откройте «Моя подписка».",
    ]
      .filter(Boolean)
      .join("\n"),

  paymentPending:
    "Оплата получена, но подтверждение задержалось. Доступ откроется автоматически в течение пары минут — если нет, напишите в поддержку.",

  preCheckoutRejected: "Не удалось подтвердить счёт. Создайте оплату заново.",

  staleButton: "Кнопка устарела — список обновился. Откройте раздел заново.",

  payInProgress: "Счёт уже создаётся, секунду…",

  failure: "Что-то пошло не так. Попробуйте ещё раз или напишите в поддержку.",

  adminNewPayment: (input: { telegramUserId: number; username?: string; amountStars: number; planTitle?: string }) =>
    [
      "💸 <b>Новый платёж (Stars)</b>",
      `Юзер: ${input.username ? `@${escapeHtml(input.username)}` : input.telegramUserId}`,
      input.planTitle ? `Тариф: ${escapeHtml(input.planTitle)}` : "",
      `Сумма: ${input.amountStars} ⭐`,
    ]
      .filter(Boolean)
      .join("\n"),

  adminConfirmFailed: (input: { telegramUserId: number; chargeId: string; detail: string }) =>
    [
      "🚨 <b>Оплата не подтвердилась в core</b>",
      `Юзер: ${input.telegramUserId}`,
      `charge_id: <code>${escapeHtml(input.chargeId)}</code>`,
      `Ошибка: ${escapeHtml(input.detail)}`,
      "",
      "Деньги списаны — нужен ручной разбор.",
    ].join("\n"),
};

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "активна",
    trial: "пробный период",
    expired: "истекла",
    suspended: "приостановлена",
    disabled: "отключена",
  };
  return labels[status] ?? status;
}
