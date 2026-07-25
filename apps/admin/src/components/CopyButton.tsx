import { useState } from "react";

export default function CopyButton({ value, title = "Скопировать" }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard недоступен без https/разрешения — падать из-за копирования нельзя
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {copied ? "Скопировано" : title}
    </button>
  );
}
