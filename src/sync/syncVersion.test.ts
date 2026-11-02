import { describe, expect, it } from "vitest";
import { parseSyncVersion } from "./syncVersion";

describe("parseSyncVersion", () => {
  it.each(["0", "1", "9007199254740993", "9223372036854775807"])("preserves exact bigint cursor %s", (value) => {
    expect(parseSyncVersion(value)).toBe(value);
  });
  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts safe numeric cursor %s", (value) => {
    expect(parseSyncVersion(value)).toBe(String(value));
  });
  it.each([null, undefined, "", "01", "-1", -1, 1.1, NaN, Infinity, "1e3", "9223372036854775808", Number.MAX_SAFE_INTEGER + 1])("rejects invalid cursor %s", (value) => {
    expect(() => parseSyncVersion(value)).toThrow("同步版本无效");
  });
});
