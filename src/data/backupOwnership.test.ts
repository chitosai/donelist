import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { DoneRecord, OwnedRecordBackup, RecordBackup } from "../domain/DoneRecord";
import { IndexedDbRecordRepository } from "./IndexedDbRecordRepository";

const stores: IndexedDbRecordRepository[] = [];
function createStore() {
  const store = new IndexedDbRecordRepository(`done-list-backup-owner-test-${crypto.randomUUID()}`, "test-project");
  stores.push(store);
  return store;
}
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.db.delete())); });

function owned(userId: string): OwnedRecordBackup {
  const now = "2026-11-02T00:00:00Z";
  const record: DoneRecord = { id: crypto.randomUUID(), content: "待恢复的备份记录", createdAt: now, updatedAt: now, happenedAt: now, isHighlighted: true };
  return { format: "done-list-backup", version: 2, owner: { userId }, exportedAt: now, records: [record] };
}

describe("backup ownership in local storage", () => {
  it("exports a v2 guest backup with only userId, no email or storage metadata", async () => {
    const store = createStore();
    const record = await store.create({ content: "游客记录", happenedAt: "2026-11-02T00:00:00Z" });
    const backup = await store.exportBackup();
    expect(backup).toEqual({ format: "done-list-backup", version: 2, exportedAt: expect.any(String), owner: { userId: "guest" }, records: [record] });
  });

  it("exports the captured account's identity and records even if the scope changes during the read", async () => {
    const store = createStore();
    await store.create({ content: "不能混入的游客记录", happenedAt: "2026-11-02T00:00:00Z" });
    store.setUserScope("user-b");
    await store.create({ content: "不能混入的 B 记录", happenedAt: "2026-11-02T00:00:00Z" });
    store.setUserScope("user-a");
    const record = await store.create({ content: "A 的备份", happenedAt: "2026-11-02T00:00:00Z" });
    const deleted = await store.create({ content: "已删除不导出", happenedAt: "2026-11-02T00:00:00Z" });
    await store.delete(deleted.id);
    const exporting = store.exportBackup();
    store.setUserScope("user-b");
    expect(await exporting).toMatchObject({ version: 2, owner: { userId: "user-a" }, records: [record] });
  });

  it("imports matching records and queues only domain data under the checked current scope", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const backup = owned("user-a");
    Object.assign(backup.records[0], { scopeId: "user:user-b", owner: { userId: "user-b" }, email: "ignored@example.com", sync_version: "999" });
    expect(await store.importBackup(backup, { expectedUserId: "user-a" })).toBe(1);
    const stored = (await store.db.scopedRecords.toArray())[0];
    expect(stored.scopeId).toBe("user:user-a");
    for (const key of ["owner", "email", "sync_version"]) expect(stored).not.toHaveProperty(key);
    expect(await store.getAllForSync("user-b")).toEqual([]);
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
  });

  it("always blocks another signed-in account, even with the confirmation flag", async () => {
    const store = createStore();
    store.setUserScope("user-b");
    const original = await store.create({ content: "原有数据", happenedAt: "2026-11-02T00:00:00Z" });
    const pending = await store.getPendingUploads("user-b");
    await expect(store.importBackup(owned("user-a"), { isOwnerConfirmed: true })).rejects.toThrow("这个备份不属于当前账号");
    expect(await store.getRecent(10)).toEqual([original]);
    expect(await store.getPendingUploads("user-b")).toEqual(pending);
    expect(await store.getAllForSync("user-a")).toEqual([]);
  });

  it("requires explicit confirmation before importing a guest backup into an account", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const backup = owned("guest");
    await expect(store.importBackup(backup)).rejects.toThrow("把登录前的备份导入当前账号？");
    expect(await store.db.scopedRecords.count()).toBe(0);
    expect(await store.importBackup(backup, { expectedUserId: "user-a", isOwnerConfirmed: true })).toBe(1);
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    expect(await store.getGuestRecords()).toEqual([]);
  });

  it("requires confirmation before restoring an account backup as local guest data, without queuing uploads", async () => {
    const store = createStore();
    const backup = owned("user-a");
    await expect(store.importBackup(backup)).rejects.toThrow("将账号备份导入本地？");
    expect(await store.importBackup(backup, { expectedUserId: "guest", isOwnerConfirmed: true })).toBe(1);
    expect(await store.getGuestRecords()).toEqual(backup.records);
    expect(await store.getAllForSync("user-a")).toEqual([]);
    expect(await store.db.pendingUploads.count()).toBe(0);
  });

  it.each(["guest", "user-a"])("blocks ownerless legacy backups as mismatches into %s, even with confirmation", async (userId) => {
    const store = createStore();
    if (userId !== "guest") store.setUserScope(userId);
    const { owner: _owner, ...base } = owned("guest");
    const backup: RecordBackup = { ...base, version: 1 };
    const original = await store.create({ content: "原有记录不能改变", happenedAt: "2026-11-02T00:00:00Z" });
    const pending = await store.db.pendingUploads.toArray();
    await expect(store.importBackup(backup)).rejects.toThrow("这个备份不属于当前账号");
    await expect(store.importBackup(backup, { expectedUserId: userId, isOwnerConfirmed: true })).rejects.toThrow("这个备份不属于当前账号");
    expect(await store.getRecent(10)).toEqual([original]);
    expect(await store.db.pendingUploads.toArray()).toEqual(pending);
  });

  it("does not treat a v2 backup missing its owner as a legacy backup", async () => {
    const store = createStore();
    const { owner: _owner, ...malformed } = owned("guest");
    await expect(store.importBackup(malformed as RecordBackup, { isOwnerConfirmed: true })).rejects.toThrow("这个文件似乎并不是 Donelist 数据备份");
    expect(await store.db.scopedRecords.count()).toBe(0);
  });

  it("refuses to use confirmation for a previous destination after an account switch", async () => {
    const store = createStore();
    store.setUserScope("user-b");
    await expect(store.importBackup(owned("guest"), { expectedUserId: "user-a", isOwnerConfirmed: true })).rejects.toThrow("当前账号已改变");
    expect(await store.db.scopedRecords.count()).toBe(0);
    expect(await store.db.pendingUploads.count()).toBe(0);
  });

  it("aborts if the destination changes before the import transaction starts writing", async () => {
    const store = createStore();
    await store.db.open();
    store.setUserScope("user-a");
    const importing = store.importBackup(owned("user-a"), { expectedUserId: "user-a" });
    store.setUserScope("user-b");
    await expect(importing).rejects.toThrow("当前账号已改变");
    expect(await store.db.scopedRecords.count()).toBe(0);
    expect(await store.db.pendingUploads.count()).toBe(0);
  });
});
