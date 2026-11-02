import { describe, expect, it } from "vitest";
import type { RecordBackup } from "./DoneRecord";
import { checkBackupImport, parseRecordBackup } from "./recordBackup";

function owned(userId: string): RecordBackup {
  return { format: "done-list-backup", version: 2, owner: { userId }, exportedAt: "2026-11-02T00:00:00Z", records: [] };
}

describe("backup ownership envelope", () => {
  it.each(["guest", "6064f561-8f11-408c-9676-31d7e38802b0"])("accepts a v2 backup with owner %s", (userId) => {
    const backup = owned(userId);
    expect(parseRecordBackup(JSON.parse(JSON.stringify(backup)))).toEqual(backup);
  });

  it("recognizes legacy v1 explicitly, not as a fallback for malformed v2", () => {
    const backup = { format: "done-list-backup", version: 1, exportedAt: "2026-11-02T00:00:00Z", records: [] };
    expect(parseRecordBackup(backup)).toEqual(backup);
  });

  it.each([undefined, null, {}, [], "guest", { userId: null }, { userId: 42 }, { userId: "" }, { userId: " " }, { userId: " user-a" }, { email: "user@example.com" }])(
    "rejects a v2 backup with malformed owner %j", (owner) => {
      expect(() => parseRecordBackup({ ...owned("guest"), owner })).toThrow("这个文件似乎并不是 Donelist 数据备份");
    },
  );

  it.each([0, 3, "2", null])("rejects unsupported format version %j", (version) => {
    expect(() => parseRecordBackup({ ...owned("guest"), version })).toThrow("这个文件似乎并不是 Donelist 数据备份");
  });
});

describe("backup import checks", () => {
  it.each(["guest", "user-a"])("allows a matching owner %s", (userId) => {
    expect(checkBackupImport(owned(userId), userId)).toEqual({ status: "allowed" });
  });

  it("blocks a different account, rather than treating it as an unowned backup", () => {
    expect(checkBackupImport(owned("user-a"), "user-b")).toMatchObject({ status: "blocked", message: "这个备份不属于当前账号" });
  });

  it("asks before importing guest records into an account", () => {
    expect(checkBackupImport(owned("guest"), "user-a")).toMatchObject({ status: "confirmation", message: "把登录前的备份导入当前账号？" });
  });

  it("asks before importing an account backup into guests", () => {
    expect(checkBackupImport(owned("user-a"), "guest")).toMatchObject({ status: "confirmation", message: "将账号备份导入本地？" });
  });

  it.each(["guest", "user-a"])("treats an ownerless legacy backup as an account mismatch for %s, without a separate version notice", (userId) => {
    const backup: RecordBackup = { format: "done-list-backup", version: 1, exportedAt: "2026-11-02T00:00:00Z", records: [] };
    const check = checkBackupImport(backup, userId);
    expect(check).toEqual(checkBackupImport(owned("user-b"), "user-a"));
    expect(check).toMatchObject({ status: "blocked", message: "这个备份不属于当前账号" });
  });
});
