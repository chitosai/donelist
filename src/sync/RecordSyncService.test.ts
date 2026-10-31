import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRecordRepository, type SyncableDoneRecord } from "../data/IndexedDbRecordRepository";
import { RecordSyncService } from "./RecordSyncService";

type Row = { id: string; user_id: string; content: string; happened_at: string; created_at: string; updated_at: string; is_highlighted: boolean; deleted_at: string | null };
type ReadResult = { data: Row[] | null; error: Error | null };
type Query = { eq(column: string, value: string): Query; order(column: string): Query; limit(value: number): Query; gt(column: string, value: string): Query; then: Promise<ReadResult>["then"] };
const databases: IndexedDbRecordRepository[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map((store) => store.db.delete()));
});

function setup(rows: Row[] = []) {
  const store = new IndexedDbRecordRepository(`done-list-sync-queue-test-${crypto.randomUUID()}`);
  databases.push(store);
  store.setUserScope("user-a");
  const cloud = new Map(rows.map((row) => [row.id, row]));
  const read = vi.fn(async (userId: string, lastId: string | null, limit: number): Promise<ReadResult> => ({
    data: [...cloud.values()].filter((row) => row.user_id === userId && (!lastId || row.id > lastId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit), error: null,
  }));
  const upsert = vi.fn(async (uploaded: Row[], _options: { onConflict: string }): Promise<{ error: Error | null }> => {
    uploaded.forEach((row) => cloud.set(row.id, structuredClone(row)));
    return { error: null };
  });
  const eq = vi.fn();
  const client = { from: vi.fn(() => ({
    select: () => {
      let userId = "";
      let lastId: string | null = null;
      let limit = 500;
      const query: Query = {
        eq(column, value) { eq(column, value); userId = value; return query; },
        order() { return query; },
        limit(value) { limit = value; return query; },
        gt(_column, value) { lastId = value; return query; },
        then(resolve, reject) { return read(userId, lastId, limit).then(resolve, reject); },
      };
      return query;
    }, upsert,
  })) };
  return { store, cloud, read, upsert, eq, service: new RecordSyncService(client as unknown as SupabaseClient, store) };
}
function makeRow(index = 0): Row {
  return { id: `${index}`.padStart(8, "0"), user_id: "user-a", content: `云端记录 ${index}`, happened_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", is_highlighted: false, deleted_at: null };
}
function fromRow(row: Row): SyncableDoneRecord {
  return { id: row.id, content: row.content, happenedAt: row.happened_at, createdAt: row.created_at, updatedAt: row.updated_at, isHighlighted: row.is_highlighted, deletedAt: row.deleted_at };
}

describe("RecordSyncService: persistent upload queue", () => {
  it("does not echo downloaded rows and uploads only the one edited record", async () => {
    const { store, service, upsert } = setup([makeRow(1), makeRow(2), makeRow(3)]);
    await service.sync("user-a");
    expect(upsert).not.toHaveBeenCalled();
    const record = (await store.getRecent(10))[0];
    await store.update({ ...record, isHighlighted: true });
    await service.sync("user-a");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toHaveLength(1);
    expect(upsert.mock.calls[0][0][0].id).toBe(record.id);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
    await service.sync("user-a");
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it("retains queued changes on download or upload failure and supports retry", async () => {
    const { store, service, read, upsert } = setup();
    await store.create({ content: "保留我", happenedAt: new Date().toISOString() });
    const queued = await store.getPendingUploads("user-a");
    read.mockResolvedValueOnce({ data: null, error: new Error("download failed") });
    await expect(service.sync("user-a")).rejects.toThrow("download failed");
    expect(await store.getPendingUploads("user-a")).toEqual(queued);
    upsert.mockResolvedValueOnce({ error: new Error("upload failed") });
    await expect(service.sync("user-a")).rejects.toThrow("upload failed");
    expect(await store.getPendingUploads("user-a")).toEqual(queued);
    await service.sync("user-a");
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("keeps edits made during upload pending, including same-millisecond edits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T09:00:00Z"));
    const { store, service, upsert, cloud } = setup();
    const record = await store.create({ content: "第一版", happenedAt: new Date().toISOString() });
    upsert.mockImplementationOnce(async (rows) => {
      rows.forEach((row) => cloud.set(row.id, structuredClone(row)));
      await store.update({ ...record, content: "上传中的第二版" });
      return { error: null };
    });
    await service.sync("user-a");
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    expect((await store.getRecent(10))[0].content).toBe("上传中的第二版");
    await service.sync("user-a");
    expect(upsert.mock.calls[1][0][0].content).toBe("上传中的第二版");
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("retains edits made while the remote read is in flight", async () => {
    const row = makeRow(1);
    const { store, service, read, upsert } = setup([row]);
    await service.sync("user-a");
    read.mockImplementationOnce(async () => {
      await store.update({ ...fromRow(row), content: "下载途中修改" });
      return { data: [{ ...row, updated_at: "2099-01-01T00:00:00Z" }], error: null };
    });
    await service.sync("user-a");
    expect(upsert.mock.calls[0][0][0].content).toBe("下载途中修改");
  });
  it("uploads deletion markers", async () => {
    const row = makeRow(1);
    const { store, service, upsert } = setup([row]);
    await service.sync("user-a");
    await store.delete(row.id);
    await service.sync("user-a");
    expect(upsert.mock.calls[0][0][0].deleted_at).not.toBeNull();
    expect(await store.getRecent(10)).toEqual([]);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("acknowledges completed batches without clearing failed or unattempted batches", async () => {
    const { store, service, upsert } = setup();
    await store.importBackup({ format: "done-list-backup", version: 1, exportedAt: new Date().toISOString(), records: Array.from({ length: 201 }, (_, index) => fromRow(makeRow(index))) });
    upsert.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: new Error("second batch failed") });
    await expect(service.sync("user-a")).rejects.toThrow("second batch failed");
    expect(upsert.mock.calls[0][0]).toHaveLength(100);
    expect(await store.getPendingUploadCount("user-a")).toBe(101);
    upsert.mockClear();
    await service.sync("user-a");
    expect(upsert.mock.calls.map(([rows]) => rows.length)).toEqual([100, 1]);
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
  });
  it("paginates full downloads beyond the default API page", async () => {
    const { store, service, read, upsert } = setup(Array.from({ length: 1201 }, (_, index) => makeRow(index)));
    await service.sync("user-a");
    expect(read.mock.calls.map(([_userId, lastId]) => lastId)).toEqual([null, makeRow(499).id, makeRow(999).id]);
    expect(await store.getAllForSync("user-a")).toHaveLength(1201);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("uses a successful read to confirm an earlier upload whose response was lost", async () => {
    const { store, service, upsert, cloud } = setup();
    await store.create({ content: "确认响应丢失", happenedAt: new Date().toISOString() });
    upsert.mockImplementationOnce(async (rows) => {
      rows.forEach((row) => cloud.set(row.id, structuredClone(row)));
      return { error: new Error("response lost") };
    });
    await expect(service.sync("user-a")).rejects.toThrow("response lost");
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    await service.sync("user-a");
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it("retains the existing policy of accepting newer cloud versions", async () => {
    const { store, service, upsert, cloud } = setup();
    const local = await store.create({ content: "本地旧版", happenedAt: new Date().toISOString() });
    cloud.set(local.id, { ...makeRow(), id: local.id, content: "云端新版", updated_at: "2099-01-01T00:00:00Z" });
    await service.sync("user-a");
    expect((await store.getRecent(10))[0].content).toBe("云端新版");
    expect(await store.getPendingUploadCount("user-a")).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("keeps uploads bound to the account if the UI returns to guests during a read", async () => {
    const { store, service, read, upsert, eq } = setup([makeRow(1)]);
    store.setGuestScope();
    const guest = await store.create({ content: "暂不合并", happenedAt: new Date().toISOString() });
    store.setUserScope("user-a");
    const account = await store.create({ content: "账号 A", happenedAt: new Date().toISOString() });
    read.mockImplementationOnce(async () => { store.setGuestScope(); return { data: [makeRow(1)], error: null }; });
    await service.sync("user-a");
    expect(eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(upsert.mock.calls[0][0].map((row) => row.id)).toEqual([account.id]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getRecent(10)).toEqual([guest]);
  });
});
