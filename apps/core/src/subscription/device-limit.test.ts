import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeviceWithinLimit } from "./device-limit.js";

describe("hwid device-limit", () => {
  it("слоты держат самые ранние устройства, новое сверх лимита отсекается", () => {
    const active = ["dev-1", "dev-2", "dev-3"];
    assert.equal(isDeviceWithinLimit(active, 2, "dev-1"), true);
    assert.equal(isDeviceWithinLimit(active, 2, "dev-2"), true);
    assert.equal(isDeviceWithinLimit(active, 2, "dev-3"), false);
  });

  it("лимит 1: первое устройство продолжает работать, второе получает отказ", () => {
    assert.equal(isDeviceWithinLimit(["dev-1", "dev-2"], 1, "dev-1"), true);
    assert.equal(isDeviceWithinLimit(["dev-1", "dev-2"], 1, "dev-2"), false);
  });

  it("лимита нет (null в схеме приходит нулём) — пускаем всех", () => {
    assert.equal(isDeviceWithinLimit(["a", "b", "c"], 0, "c"), true);
  });

  it("устройств меньше лимита — вопросов нет", () => {
    assert.equal(isDeviceWithinLimit(["dev-1"], 3, "dev-1"), true);
  });
});
