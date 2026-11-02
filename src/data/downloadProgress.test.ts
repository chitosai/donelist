import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRecordRepository, type SyncableDoneRecord } from "./IndexedDbRecordRepository";

const stores: IndexedDbRecordRepository[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const names = new Set(stores.map((store) => store.db.name));
  stores.splice(0).forEach((store) => store.db.close());
  await Promise.all([...names].map((name) => Dexie.delete(name)));
});
function createStore(name = `done-list-download-test-${crypto.randomUUID()}`, syncTarget = "project-a") {
  const store = new IndexedDbRecordRepository(name, syncTarget);
  stores.push(store);
  return store;
}
function makeRecord(): SyncableDoneRecord {
  return { id: crypto.randomUUID(), content: "下载的记录", happenedAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", isHighlighted: false, deletedAt: null };
}

describe("persistent download progress", () => {
  it("starts at zero and persists the cursor across reopen", async () => {
    const store = createStore();
    expect(await store.getDownloadCursor("user-a")).toBe("0");
    await store.applyDownloadedPage("user-a", [makeRecord()], "0", "500", []);
    store.db.close();
    const reopened = createStore(store.db.name);
    expect(await reopened.getDownloadCursor("user-a")).toBe("500");
    expect(await reopened.getAllForSync("user-a")).toHaveLength(1);
  });

  it("isolates cursors by project and account", async () => {
    const store = createStore();
    await store.applyDownloadedPage("user-a", [makeRecord()], "0", "42", []);
    expect(await store.getDownloadCursor("user-b")).toBe("0");
    const other = createStore(store.db.name, "project-b");
    expect(await other.getDownloadCursor("user-a")).toBe("0");
    await other.applyDownloadedPage("user-a", [], "0", "8", []);
    expect(await store.getDownloadCursor("user-a")).toBe("42");
  });

  it("rolls back both downloaded records and queue changes when saving progress fails", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const local = await store.create({ content: "等待确认", happenedAt: "2026-08-01T00:00:00Z" });
    const pending = await store.getPendingUploads("user-a");
    const incoming = { ...local, deletedAt: null };
    vi.spyOn(store.db.downloadScopes, "put").mockRejectedValueOnce(new Error("progress write failed"));
    await expect(store.applyDownloadedPage("user-a", [incoming, makeRecord()], "0", "500", pending)).rejects.toThrow("progress write failed");
    expect(await store.getDownloadCursor("user-a")).toBe("0");
    expect(await store.getPendingUploads("user-a")).toEqual(pending);
    expect(await store.getRecent(10)).toEqual([local]);
  });

  it("commits the page and cursor without changing a same-ID guest copy", async () => {
    const store = createStore();
    const guest = await store.create({ content: "游客自己的记录", happenedAt: "2026-08-01T00:00:00Z" });
    const cloud = { ...guest, content: "账号自己的云端记录", deletedAt: null };
    expect(await store.applyDownloadedPage("user-a", [cloud], "0", "1", [])).toBe(true);
    expect(await store.getDownloadCursor("user-a")).toBe("1");
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getAllForSync("user-a")).toEqual([cloud]);
  });

  it("refuses a stale page after another tab advanced the cursor", async () => {
    const store = createStore();
    const first = makeRecord();
    await store.applyDownloadedPage("user-a", [first], "0", "500", []);
    expect(await store.applyDownloadedPage("user-a", [makeRecord()], "0", "200", [])).toBe(false);
    expect(await store.getDownloadCursor("user-a")).toBe("500");
    expect(await store.getAllForSync("user-a")).toEqual([first]);
    await expect(store.applyDownloadedPage("user-a", [], "500", "499", [])).rejects.toThrow("不能倒退");
  });

  it("upgrades a v3 database without changing records, uploads or their initialization marker", async () => {
    const name = `done-list-download-test-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      records: "&id, scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]",
      pendingUploads: "[syncTarget+scopeId+recordId], [syncTarget+scopeId]",
      uploadScopes: "[syncTarget+scopeId]",
    });
    const record = makeRecord();
    const pending = { syncTarget: "project-a", scopeId: "user:user-a", recordId: record.id, mutationId: crypto.randomUUID(), record };
    await legacy.table("records").put({ ...record, scopeId: "user:user-a" });
    await legacy.table("pendingUploads").put(pending);
    await legacy.table("uploadScopes").put({ syncTarget: "project-a", scopeId: "user:user-a", initializedAt: "2026-10-31T00:00:00Z" });
    legacy.close();
    const store = createStore(name);
    expect(await store.getDownloadCursor("user-a")).toBe("0");
    expect(await store.getAllForSync("user-a")).toEqual([record]);
    await store.prepareUploadQueue("user-a");
    expect(await store.getPendingUploads("user-a")).toEqual([pending]);
  });
});
