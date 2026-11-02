// Keep PostgreSQL bigint cursors exact across JSON and IndexedDB.
export function parseSyncVersion(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n) {
    return value;
  }
  throw new Error("同步版本无效，已保留本地记录和下载进度。");
}
