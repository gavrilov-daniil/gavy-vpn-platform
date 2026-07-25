import { Injectable, Logger } from "@nestjs/common";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { loadConfig } from "../config.js";

export interface SignedEnvelope<T> {
  payload: T;
  signature: string;
}

/**
 * Подпись desired-state (RS256) — root of trust агента: без приватного ключа
 * control-plane подделать конфиг ноды нельзя даже при скомпрометированном TLS.
 *
 * Ключ не задан — отдаём голый JSON. Это переходный режим для уже развёрнутых
 * агентов; агент принимает голый JSON, только если у него самого не задан
 * cp_public_key_path (анти-даунгрейд на его стороне).
 */
@Injectable()
export class DesiredStateSigner {
  private readonly log = new Logger(DesiredStateSigner.name);
  private readonly key: KeyObject | null;

  constructor() {
    const pem = loadConfig().desiredStateSigningKey;
    if (!pem) {
      this.key = null;
      this.log.warn("DESIRED_STATE_SIGNING_KEY не задан: desired-state уходит без подписи");
      return;
    }
    // Битый ключ роняет старт намеренно: молчаливый откат на неподписанную выдачу —
    // это ровно тот даунгрейд, от которого механизм и защищает.
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error(`DESIRED_STATE_SIGNING_KEY: агент проверяет RS256, нужен RSA-ключ (получен ${key.asymmetricKeyType})`);
    }
    this.key = key;
    this.log.log("desired-state подписывается RS256");
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /**
   * Конверт `{payload, signature}` из agent'ского `unwrap`: подпись считается по
   * байтам payload, а не по пересобранной структуре — так нет расхождения
   * канонизации JSON между сторонами.
   *
   * Байты те же, потому что вложенный объект сериализуется тем же JSON.stringify,
   * которым мы его подписали. Значит, между этим местом и ответом payload трогать
   * нельзя (интерсептор, меняющий тело, сломает подпись).
   */
  wrap<T>(payload: T): T | SignedEnvelope<T> {
    if (!this.key) return payload;
    const signature = createSign("RSA-SHA256")
      .update(Buffer.from(JSON.stringify(payload), "utf8"))
      .sign(this.key)
      .toString("base64");
    return { payload, signature };
  }
}
