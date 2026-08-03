import { useEffect, useRef } from "react";
import type { TelegramAuthPayload } from "../api";

interface Props {
  botUsername: string;
  onAuth: (payload: TelegramAuthPayload) => void;
}

/** Виджет зовёт глобальную функцию по имени из data-onauth — своего колбэка он не принимает. */
declare global {
  interface Window {
    corelinkTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

/**
 * Кнопка Telegram Login Widget. Скрипт грузится с telegram.org и рисует свою кнопку
 * в iframe — подменить её содержимое или прочитать оттуда данные нельзя, поэтому
 * вся вёрстка здесь сводится к контейнеру.
 *
 * Домен админки должен быть привязан к боту через /setdomain в BotFather, иначе
 * виджет отрисуется, но по нажатию ответит ошибкой домена.
 */
export default function TelegramLoginButton({ botUsername, onAuth }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handler = useRef(onAuth);
  handler.current = onAuth;

  useEffect(() => {
    const node = container.current;
    if (!node || !botUsername) return;

    window.corelinkTelegramAuth = (user) => handler.current(user);

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-onauth", "corelinkTelegramAuth(user)");
    node.appendChild(script);

    return () => {
      node.replaceChildren();
      delete window.corelinkTelegramAuth;
    };
  }, [botUsername]);

  return <div className="tg-login" ref={container} />;
}
