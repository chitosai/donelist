import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoneRecord, RecordBackup } from "../domain/DoneRecord";
import { IndexedDbRecordRepository } from "./IndexedDbRecordRepository";

const stores: IndexedDbRecordRepository[] = [];
const legacyDatabases: Dexie[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const names = new Set([...stores.map((store) => store.db.name), ...legacyDatabases.map((db) => db.name)]);
  stores.splice(0).forEach((store) => store.db.close());
  legacyDatabases.splice(0).forEach((db) => db.close());
  await Promise.all([...names].map((name) => Dexie.delete(name)));
});

function createStore(name = `done-list-scoped-test-${crypto.randomUUID()}`) {
  const store = new IndexedDbRecordRepository(name, "project-a");
  stores.push(store);
  return store;
}

function makeRecord(): DoneRecord {
  return { id: crypto.randomUUID(), content: "保留原来的记录", happenedAt: "2026-11-02T00:00:00Z", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", isHighlighted: false };
}

function backup(records: DoneRecord[]): RecordBackup {
  return { format: "done-list-backup", version: 1, exportedAt: "2026-11-02T00:00:00Z", records };
}

describe("records keyed by scope and ID", () => {
  it("keeps same-ID guest and account copies isolated across imports, reads, edits, highlights and deletion", async () => {
    const store = createStore();
    const guest = makeRecord();
    await store.importBackup(backup([guest]));
    store.setUserScope("user-b");
    const accountB = { ...guest, content: "账号 B 的副本" };
    await store.importBackup(backup([accountB]));
    const uploadsB = await store.getPendingUploads("user-b");
    store.setUserScope("user-a");
    const accountA = { ...guest, content: "账号 A 的副本" };
    await store.importBackup(backup([accountA]));
    expect((await store.exportBackup()).records).toEqual([accountA]);
    expect(await store.getByMonth(2026, 10)).toEqual([accountA]);
    await store.update({ ...accountA, content: "只修改 A", isHighlighted: true });
    expect((await store.getRecent(10))[0]).toMatchObject({ content: "只修改 A", isHighlighted: true });
    await store.delete(accountA.id);
    expect(await store.getRecent(10)).toEqual([]);
    expect((await store.getAllForSync("user-a"))[0].deletedAt).not.toBeNull();
    expect((await store.getPendingUploads("user-a"))[0].record.deletedAt).not.toBeNull();
    expect(await store.getPendingUploads("user-b")).toEqual(uploadsB);
    expect(await store.getAllForSync("user-b")).toEqual([{ ...accountB, deletedAt: null }]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    store.setUserScope("user-b");
    expect((await store.exportBackup()).records).toEqual([accountB]);
    store.setGuestScope();
    expect((await store.exportBackup()).records).toEqual([guest]);
  });

  it("cannot edit or delete a record that exists only in a different account", async () => {
    const store = createStore();
    store.setUserScope("user-b");
    const other = await store.create({ content: "其他账号的记录", happenedAt: "2026-11-02T00:00:00Z" });
    const pending = await store.getPendingUploads("user-b");
    store.setUserScope("user-a");
    await expect(store.update({ ...other, content: "不应写入" })).rejects.toThrow("找不到");
    await store.delete(other.id);
    expect(await store.getAllForSync("user-a")).toEqual([]);
    expect(await store.getPendingUploads("user-a")).toEqual([]);
    expect(await store.getAllForSync("user-b")).toEqual([{ ...other, deletedAt: null }]);
    expect(await store.getPendingUploads("user-b")).toEqual(pending);
  });

  it.each(["guest-newer", "account-newer", "same-time"])("deduplicates an explicitly confirmed same-ID guest merge using timestamps: %s", async (scenario) => {
    const store = createStore();
    const guest = { ...makeRecord(), content: "游客副本", updatedAt: scenario === "guest-newer" ? "2026-11-03T00:00:00Z" : "2026-11-02T00:00:00Z" };
    await store.importBackup(backup([guest]));
    store.setUserScope("user-a");
    const account = { ...guest, content: "账号副本", updatedAt: scenario === "account-newer" ? "2026-11-03T00:00:00Z" : "2026-11-02T00:00:00Z" };
    await store.importBackup(backup([account]));
    const pending = await store.getPendingUploads("user-a");
    expect(await store.claimGuestRecords("user-a", [guest.id, guest.id])).toBe(1);
    expect(await store.getGuestRecords()).toEqual([]);
    expect(await store.getAllForSync("user-a")).toEqual([{ ...(scenario === "guest-newer" ? guest : account), deletedAt: null }]);
    if (scenario === "guest-newer") {
      const next = await store.getPendingUploads("user-a");
      expect(next).toHaveLength(1);
      expect(next[0].record.content).toBe(guest.content);
      expect(next[0].mutationId).not.toBe(pending[0].mutationId);
    } else {
      expect(await store.getPendingUploads("user-a")).toEqual(pending);
    }
  });

  it.each(["queue", "guest-removal"])("rolls back an overlapping guest merge when %s fails", async (failure) => {
    const store = createStore();
    const guest = { ...makeRecord(), content: "较新的游客副本", updatedAt: "2026-11-03T00:00:00Z" };
    await store.importBackup(backup([guest]));
    store.setUserScope("user-a");
    const account = { ...guest, content: "原有账号副本", updatedAt: "2026-11-02T00:00:00Z" };
    await store.importBackup(backup([account]));
    const pending = await store.getPendingUploads("user-a");
    if (failure === "queue") vi.spyOn(store.db.pendingUploads, "put").mockRejectedValueOnce(new Error("queue failed"));
    else vi.spyOn(store.db.scopedRecords, "bulkDelete").mockRejectedValueOnce(new Error("guest-removal failed"));
    await expect(store.claimGuestRecords("user-a", [guest.id])).rejects.toThrow("failed");
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getAllForSync("user-a")).toEqual([{ ...account, deletedAt: null }]);
    expect(await store.getPendingUploads("user-a")).toEqual(pending);
  });
});

async function seedLegacyDatabase(version: number) {
  const name = `done-list-scoped-upgrade-test-${crypto.randomUUID()}`;
  const legacy = new Dexie(name);
  legacyDatabases.push(legacy);
  legacy.version(version).stores({
    records: version === 1 ? "&id, happenedAt, createdAt, updatedAt" : "&id, scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]",
    ...(version >= 3 ? { pendingUploads: "[syncTarget+scopeId+recordId], [syncTarget+scopeId]", uploadScopes: "[syncTarget+scopeId]" } : {}),
    ...(version >= 4 ? { downloadScopes: "[syncTarget+scopeId]" } : {}),
  });
  const guest = makeRecord();
  const account = { ...makeRecord(), content: "旧账号待上传的删除记录", scopeId: "user:user-b", deletedAt: "2026-11-03T00:00:00Z" };
  const expectedRecords = [{ ...guest, scopeId: "guest", deletedAt: null }, ...(version >= 2 ? [account] : [])];
  await legacy.table("records").bulkPut(version === 1 ? [guest] : expectedRecords);
  const { scopeId, ...accountPayload } = account;
  const pending = version >= 3 ? [{ syncTarget: "project-a", scopeId, recordId: account.id, mutationId: "unchanged-mutation", record: accountPayload }] : [];
  if (version >= 3) {
    await legacy.table("pendingUploads").bulkPut(pending);
    await legacy.table("uploadScopes").put({ syncTarget: "project-a", scopeId: "user:user-b", initializedAt: "2026-11-01T00:00:00Z" });
  }
  if (version >= 4) await legacy.table("downloadScopes").put({ syncTarget: "project-a", scopeId: "user:user-b", cursor: "9007199254740993" });
  const uploads = version >= 3 ? await legacy.table("pendingUploads").toArray() : [];
  const uploadScopes = version >= 3 ? await legacy.table("uploadScopes").toArray() : [];
  const downloadScopes = version >= 4 ? await legacy.table("downloadScopes").toArray() : [];
  legacy.close();
  return { legacy, name, expectedRecords, uploads, uploadScopes, downloadScopes };
}

describe("non-destructive scoped-record upgrade", () => {
  it.each([1, 2, 3, 4])("upgrades v%s, preserving IDs, ownership, deletion markers, pending mutations and progress", async (version) => {
    const fixture = await seedLegacyDatabase(version);
    const store = createStore(fixture.name);
    await store.db.open();
    const sort = (records: typeof fixture.expectedRecords) => records.sort((a, b) => `${a.scopeId}:${a.id}`.localeCompare(`${b.scopeId}:${b.id}`));
    expect(store.db.verno).toBe(6);
    expect(store.db.scopedRecords.schema.primKey.keyPath).toEqual(["scopeId", "id"]);
    expect(store.db.tables.map((table) => table.name)).not.toContain("records");
    expect(sort(await store.db.scopedRecords.toArray())).toEqual(sort(fixture.expectedRecords));
    expect(await store.db.pendingUploads.toArray()).toEqual(fixture.uploads);
    expect(await store.db.uploadScopes.toArray()).toEqual(fixture.uploadScopes);
    expect(await store.db.downloadScopes.toArray()).toEqual(fixture.downloadScopes);
    if (version >= 3) {
      await store.prepareUploadQueue("user-b");
      expect(await store.getPendingUploads("user-b")).toEqual(fixture.uploads);
    }
    store.db.close();
    const reopened = createStore(fixture.name);
    expect(await reopened.db.scopedRecords.count()).toBe(fixture.expectedRecords.length);
    expect(await reopened.getDownloadCursor("user-b")).toBe(version >= 4 ? "9007199254740993" : "0");
  });

  it("rolls back a failed copy, keeping the old store and metadata usable, then retries safely", async () => {
    const fixture = await seedLegacyDatabase(4);
    const failed = createStore(fixture.name);
    vi.spyOn(Object.getPrototypeOf(failed.db.scopedRecords), "bulkPut").mockRejectedValueOnce(new Error("migration copy failed"));
    await expect(failed.db.open()).rejects.toThrow("migration copy failed");
    failed.db.close();
    vi.restoreAllMocks();
    await fixture.legacy.open();
    expect(await fixture.legacy.table("records").count()).toBe(fixture.expectedRecords.length);
    expect(await fixture.legacy.table("pendingUploads").toArray()).toEqual(fixture.uploads);
    expect(await fixture.legacy.table("uploadScopes").toArray()).toEqual(fixture.uploadScopes);
    expect(await fixture.legacy.table("downloadScopes").toArray()).toEqual(fixture.downloadScopes);
    expect(fixture.legacy.tables.map((table) => table.name)).not.toContain("scopedRecords");
    fixture.legacy.close();
    const retried = createStore(fixture.name);
    expect(await retried.db.scopedRecords.count()).toBe(fixture.expectedRecords.length);
    expect(await retried.getPendingUploads("user-b")).toEqual(fixture.uploads);
    expect(await retried.getDownloadCursor("user-b")).toBe("9007199254740993");
  });
});
