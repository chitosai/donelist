import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoneRecord, RecordBackup } from "../domain/DoneRecord";
import { IndexedDbRecordRepository } from "./IndexedDbRecordRepository";

const stores: IndexedDbRecordRepository[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  const names = new Set(stores.map((store) => store.db.name));
  stores.splice(0).forEach((store) => store.db.close());
  await Promise.all([...names].map((name) => Dexie.delete(name)));
});
function createStore(name = `done-list-outbox-test-${crypto.randomUUID()}`, syncTarget = "project-a") {
  const store = new IndexedDbRecordRepository(name, syncTarget);
  stores.push(store);
  return store;
}
function makeBackup(records: DoneRecord[]): RecordBackup {
  return { format: "done-list-backup", version: 1, exportedAt: new Date().toISOString(), records };
}
async function addRecord(store: IndexedDbRecordRepository, content = "待上传记录") {
  return store.create({ content, happenedAt: new Date().toISOString() });
}

describe("persistent pending uploads", () => {
  it("never queues guest changes and queues only explicitly claimed records", async () => {
    const store = createStore();
    const first = await addRecord(store);
    const second = await addRecord(store, "不合并");
    await store.update({ ...second, isHighlighted: true });
    expect(await store.db.pendingUploads.count()).toBe(0);
    await store.claimGuestRecords("user-a", [first.id]);
    expect((await store.getPendingUploads("user-a")).map((upload) => upload.recordId)).toEqual([first.id]);
    expect((await store.getGuestRecords()).map((record) => record.id)).toEqual([second.id]);
    expect(await store.getPendingUploadCount("user-b")).toBe(0);
  });
  it("coalesces edits and deletion into one latest payload", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const record = await addRecord(store);
    const first = (await store.getPendingUploads("user-a"))[0];
    await store.update({ ...record, content: "修改后的内容", isHighlighted: true });
    const second = (await store.getPendingUploads("user-a"))[0];
    expect(second.mutationId).not.toBe(first.mutationId);
    expect(second.record.isHighlighted).toBe(true);
    await store.delete(record.id);
    const uploads = await store.getPendingUploads("user-a");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].record.deletedAt).not.toBeNull();
    expect(uploads[0].record.content).toBe("修改后的内容");
    expect(await store.getRecent(10)).toEqual([]);
  });
  it("retains queue versions across database reopen and does not reseed acknowledged records", async () => {
    const first = createStore();
    first.setUserScope("user-a");
    await addRecord(first);
    const uploads = await first.getPendingUploads("user-a");
    await first.prepareUploadQueue("user-a");
    first.db.close();
    const reopened = createStore(first.db.name);
    expect(await reopened.getPendingUploads("user-a")).toEqual(uploads);
    await reopened.acknowledgeUploads("user-a", uploads);
    reopened.db.close();
    const again = createStore(first.db.name);
    await again.prepareUploadQueue("user-a");
    expect(await again.getPendingUploadCount("user-a")).toBe(0);
    expect(await again.getAllForSync("user-a")).toHaveLength(1);
  });
  it("does not acknowledge a newer mutation even with identical timestamps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T09:00:00Z"));
    const store = createStore();
    store.setUserScope("user-a");
    const record = await addRecord(store);
    const old = await store.getPendingUploads("user-a");
    await store.update({ ...record, content: "同一毫秒的新修改" });
    const latest = await store.getPendingUploads("user-a");
    expect(latest[0].record.updatedAt).toBe(old[0].record.updatedAt);
    await store.acknowledgeUploads("user-a", old);
    expect(await store.getPendingUploads("user-a")).toEqual(latest);
    await store.acknowledgeUploads("user-a", latest);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("isolates queue reads and acknowledgements by project and account", async () => {
    const first = createStore();
    first.setUserScope("user-a");
    await addRecord(first);
    const uploads = await first.getPendingUploads("user-a");
    const other = createStore(first.db.name, "project-b");
    expect(await other.getPendingUploads("user-a")).toEqual([]);
    await other.acknowledgeUploads("user-a", uploads);
    await first.acknowledgeUploads("user-b", uploads);
    expect(await first.getPendingUploads("user-a")).toEqual(uploads);
  });
  it("rolls back creation if its queue write fails", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    vi.spyOn(store.db.pendingUploads, "put").mockRejectedValueOnce(new Error("queue write failed"));
    await expect(addRecord(store)).rejects.toThrow("queue write failed");
    expect(await store.getRecent(10)).toEqual([]);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it.each(["update", "delete"] as const)("rolls back %s if its queue write fails", async (operation) => {
    const store = createStore();
    store.setUserScope("user-a");
    const record = await addRecord(store);
    const uploads = await store.getPendingUploads("user-a");
    vi.spyOn(store.db.pendingUploads, "put").mockRejectedValueOnce(new Error("queue write failed"));
    await expect(operation === "update" ? store.update({ ...record, content: "不应保存" }) : store.delete(record.id)).rejects.toThrow("queue write failed");
    expect(await store.getRecent(10)).toEqual([record]);
    expect(await store.getPendingUploads("user-a")).toEqual(uploads);
  });
  it("rolls back guest ownership if the queue cannot be saved", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    vi.spyOn(store.db.pendingUploads, "put").mockRejectedValueOnce(new Error("queue write failed"));
    await expect(store.claimGuestRecords("user-a", [guest.id])).rejects.toThrow("queue write failed");
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("queues imports without exporting internal queue metadata", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const backup = await store.exportBackup();
    await store.claimGuestRecords("user-a", [guest.id]);
    store.setUserScope("user-a");
    await store.acknowledgeUploads("user-a", await store.getPendingUploads("user-a"));
    await store.importBackup(backup);
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    expect(Object.keys((await store.exportBackup()).records[0]).sort()).toEqual(Object.keys(guest).sort());
    const other = createStore();
    await other.importBackup(backup);
    expect(await other.db.pendingUploads.count()).toBe(0);
  });
  it("rolls back failed imports and rejects other scopes' record IDs", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    store.setUserScope("user-a");
    await expect(store.importBackup(makeBackup([guest]))).rejects.toThrow("未导入任何记录");
    vi.spyOn(store.db.pendingUploads, "put").mockRejectedValueOnce(new Error("queue write failed"));
    await expect(store.importBackup(makeBackup([{ ...guest, id: crypto.randomUUID() }]))).rejects.toThrow("queue write failed");
    expect(await store.getAllForSync("user-a")).toEqual([]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("upgrades v2 without deleting data and seeds legacy account records once", async () => {
    const name = `done-list-outbox-test-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({ records: "&id, scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]" });
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), content: "升级前的数据", happenedAt: now, createdAt: now, updatedAt: now, isHighlighted: true, deletedAt: null, scopeId: "user:user-a" };
    await legacy.table("records").bulkAdd([record, { ...record, id: crypto.randomUUID(), scopeId: "guest" }]);
    legacy.close();
    const store = createStore(name);
    expect(await store.db.records.count()).toBe(2);
    await store.prepareUploadQueue("user-a");
    const uploads = await store.getPendingUploads("user-a");
    expect(uploads.map((upload) => upload.recordId)).toEqual([record.id]);
    await store.acknowledgeUploads("user-a", uploads);
    await store.prepareUploadQueue("user-a");
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
    expect(await store.db.records.count()).toBe(2);
  });
  it("recognizes equivalent cloud timestamps and does not queue downloaded rows", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    await store.prepareUploadQueue("user-a");
    const local = await addRecord(store);
    const cloud = { ...local, updatedAt: local.updatedAt.replace("Z", "+00:00"), deletedAt: null };
    await store.mergeFromSync([cloud], "user-a", await store.getPendingUploads("user-a"));
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
    await store.mergeFromSync([{ ...cloud, id: crypto.randomUUID() }], "user-a", []);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("protects changes made during a read even when the remote clock is ahead", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const local = await addRecord(store);
    const observed = await store.getPendingUploads("user-a");
    await store.update({ ...local, content: "请求途中修改" });
    const latest = await store.getPendingUploads("user-a");
    await store.mergeFromSync([{ ...local, updatedAt: "2099-01-01T00:00:00Z", deletedAt: null }], "user-a", observed);
    expect(await store.getPendingUploads("user-a")).toEqual(latest);
    expect((await store.getRecent(10))[0].content).toBe("请求途中修改");
  });
});
