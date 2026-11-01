import "fake-indexeddb/auto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRecordRepository, type SyncableDoneRecord } from "../data/IndexedDbRecordRepository";
import { RecordSyncService } from "./RecordSyncService";

type Row = { id: string; user_id: string; content: string; happened_at: string; created_at: string; updated_at: string; is_highlighted: boolean; deleted_at: string | null; sync_version: string };
type UploadRow = Omit<Row, "sync_version">;
type ReadResult = { data: Row[] | null; error: Error | null };
type SyncRpcArgs = { p_user_id: string; p_after_version?: string; p_until_version?: string; p_page_size?: number };
type VersionResult = { data: unknown; error: (Error & { code?: string }) | null };
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
  const latestFor = (userId: string) => [...cloud.values()].filter((row) => row.user_id === userId).reduce((latest, row) => BigInt(row.sync_version) > latest ? BigInt(row.sync_version) : latest, 0n).toString();
  const read = vi.fn(async (userId: string, afterVersion: string, latestVersion: string, limit: number): Promise<ReadResult> => ({
    data: [...cloud.values()].filter((row) => row.user_id === userId && BigInt(row.sync_version) > BigInt(afterVersion) && BigInt(row.sync_version) <= BigInt(latestVersion)).sort((a, b) => BigInt(a.sync_version) < BigInt(b.sync_version) ? -1 : 1).slice(0, limit), error: null,
  }));
  const commit = (uploaded: UploadRow[]) => uploaded.forEach((row) => cloud.set(row.id, { ...structuredClone(row), sync_version: (BigInt(latestFor(row.user_id)) + 1n).toString() }));
  const upsert = vi.fn(async (uploaded: UploadRow[], _options: { onConflict: string }): Promise<{ error: Error | null }> => {
    commit(uploaded);
    return { error: null };
  });
  const rpc = vi.fn((name: string, args: SyncRpcArgs) => {
    if (name === "get_record_sync_version") return Promise.resolve<VersionResult>({ data: latestFor(args.p_user_id), error: null });
    expect(name).toBe("get_record_changes");
    return { select(columns: string) {
      expect(columns).toContain("sync_version::text");
      return { order(column: string) {
        expect(column).toBe("sync_version");
        return read(args.p_user_id, args.p_after_version!, args.p_until_version!, args.p_page_size!);
      } };
    } };
  });
  const client = { rpc, from: vi.fn((_table: string) => ({ upsert })) };
  return { store, cloud, read, upsert, rpc, commit, from: client.from, service: new RecordSyncService(client as unknown as SupabaseClient, store) };
}
function makeRow(index = 0): Row {
  return { id: `${index}`.padStart(8, "0"), user_id: "user-a", content: `云端记录 ${index}`, happened_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", is_highlighted: false, deleted_at: null, sync_version: String(index + 1) };
}
function fromRow(row: Row): SyncableDoneRecord {
  return { id: row.id, content: row.content, happenedAt: row.happened_at, createdAt: row.created_at, updatedAt: row.updated_at, isHighlighted: row.is_highlighted, deletedAt: row.deleted_at };
}

describe("RecordSyncService: persistent upload queue", () => {
  it("reads and writes the records table", async () => {
    const { store, service, from, read, upsert, rpc } = setup([makeRow(1)]);
    await store.create({ content: "使用新表名同步", happenedAt: "2026-11-01T00:00:00Z" });
    await service.sync("user-a");
    expect(read).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(from.mock.calls).toEqual([["records"]]);
    expect(rpc).toHaveBeenCalledWith("get_record_changes", { p_user_id: "user-a", p_after_version: "0", p_until_version: "2", p_page_size: 500 });
  });
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
    const { store, service, read, upsert } = setup([makeRow(1)]);
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
    const { store, service, upsert, commit } = setup();
    const record = await store.create({ content: "第一版", happenedAt: new Date().toISOString() });
    upsert.mockImplementationOnce(async (rows) => {
      commit(rows);
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
    const { store, service, read, upsert, cloud } = setup([row]);
    await service.sync("user-a");
    cloud.set(row.id, { ...row, sync_version: "3" });
    read.mockImplementationOnce(async () => {
      await store.update({ ...fromRow(row), content: "下载途中修改" });
      return { data: [{ ...row, sync_version: "3", updated_at: "2099-01-01T00:00:00Z" }], error: null };
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
    expect(read.mock.calls.map(([_userId, afterVersion]) => afterVersion)).toEqual(["0", "500", "1000"]);
    expect(await store.getAllForSync("user-a")).toHaveLength(1201);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("uses a successful read to confirm an earlier upload whose response was lost", async () => {
    const { store, service, upsert, commit } = setup();
    await store.create({ content: "确认响应丢失", happenedAt: new Date().toISOString() });
    upsert.mockImplementationOnce(async (rows) => {
      commit(rows);
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
    const { store, service, read, upsert, rpc } = setup([makeRow(1)]);
    store.setGuestScope();
    const guest = await store.create({ content: "暂不合并", happenedAt: new Date().toISOString() });
    store.setUserScope("user-a");
    const account = await store.create({ content: "账号 A", happenedAt: new Date().toISOString() });
    read.mockImplementationOnce(async () => { store.setGuestScope(); return { data: [makeRow(1)], error: null }; });
    await service.sync("user-a");
    expect(rpc).toHaveBeenCalledWith("get_record_changes", expect.objectContaining({ p_user_id: "user-a" }));
    expect(upsert.mock.calls[0][0].map((row) => row.id)).toEqual([account.id]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getRecent(10)).toEqual([guest]);
  });
});

describe("RecordSyncService: incremental downloads", () => {
  it("uses the real Supabase SDK to send bounded, account-specific page requests with exact bigint selection", async () => {
    const { store } = setup();
    const requests: { url: URL; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      const data = url.pathname.endsWith("get_record_sync_version") ? "2" : [makeRow(0), makeRow(1)];
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = createClient("https://sync-test.invalid", "test-publishable-key", {
      global: { fetch },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    await new RecordSyncService(client, store).sync("user-a");
    expect(requests.map((request) => request.url.pathname)).toEqual(["/rest/v1/rpc/get_record_sync_version", "/rest/v1/rpc/get_record_changes"]);
    expect(requests[1].body).toEqual({ p_user_id: "user-a", p_after_version: "0", p_until_version: "2", p_page_size: 500 });
    expect(requests[1].url.searchParams.get("select")).toContain("sync_version::text");
    expect(requests[1].url.searchParams.get("order")).toBe("sync_version.asc");
    expect(await store.getDownloadCursor("user-a")).toBe("2");
  });

  it("downloads 10,000 records in 500-row pages, persists each page, and skips unchanged downloads", async () => {
    const { store, service, read, rpc } = setup(Array.from({ length: 10_000 }, (_, index) => makeRow(index)));
    const sizes: number[] = [];
    await service.sync("user-a", { onDownloadedPage: async () => { sizes.push((await store.getAllForSync("user-a")).length); } });
    expect(read).toHaveBeenCalledTimes(20);
    expect(read.mock.calls.every((call) => call[3] === 500)).toBe(true);
    expect(sizes).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 500));
    expect(await store.getDownloadCursor("user-a")).toBe("10000");
    read.mockClear();
    await service.sync("user-a");
    expect(read).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith("get_record_sync_version", { p_user_id: "user-a" });
  }, 30_000);

  it("downloads only new, edited and deleted records regardless of their happened date", async () => {
    const { store, service, cloud, read } = setup([makeRow(0), makeRow(1), makeRow(2)]);
    await service.sync("user-a");
    cloud.set(makeRow(0).id, { ...makeRow(0), content: "修改很久以前的记录", sync_version: "4", updated_at: "2026-11-01T00:00:00Z" });
    cloud.set(makeRow(1).id, { ...makeRow(1), sync_version: "5", deleted_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" });
    cloud.set(makeRow(3).id, { ...makeRow(3), sync_version: "6" });
    read.mockClear();
    await service.sync("user-a");
    expect(read.mock.calls).toEqual([["user-a", "3", "6", 500]]);
    expect((await store.getRecent(10)).map((record) => record.id).sort()).toEqual([makeRow(0).id, makeRow(2).id, makeRow(3).id]);
    expect((await store.getRecent(10)).find((record) => record.id === makeRow(0).id)?.content).toBe("修改很久以前的记录");
    expect(await store.getDownloadCursor("user-a")).toBe("6");
  });

  it("resumes from the last committed page after a request failure and database reopen", async () => {
    const fixture = setup(Array.from({ length: 1201 }, (_, index) => makeRow(index)));
    const { store, service, read } = fixture;
    const originalRead = read.getMockImplementation()!;
    read.mockImplementationOnce(originalRead).mockResolvedValueOnce({ data: null, error: new Error("second page failed") });
    await expect(service.sync("user-a")).rejects.toThrow("second page failed");
    expect(await store.getDownloadCursor("user-a")).toBe("500");
    expect(await store.getAllForSync("user-a")).toHaveLength(500);
    store.db.close();
    const reopened = new IndexedDbRecordRepository(store.db.name);
    databases.push(reopened);
    read.mockClear();
    // Use the same fake server, but a newly opened local repository.
    const client = { rpc: fixture.rpc, from: fixture.from };
    await new RecordSyncService(client as unknown as SupabaseClient, reopened).sync("user-a");
    expect(read.mock.calls.map((call) => call[1])).toEqual(["500", "1000"]);
    expect(await reopened.getAllForSync("user-a")).toHaveLength(1201);
    expect(await reopened.getDownloadCursor("user-a")).toBe("1201");
  });

  it("finishes a fixed window, then fetches changes made during pagination on the next sync", async () => {
    const { store, service, cloud, read } = setup(Array.from({ length: 501 }, (_, index) => makeRow(index)));
    const originalRead = read.getMockImplementation()!;
    read.mockImplementationOnce(async (...args) => {
      const result = await originalRead(...args);
      cloud.set(makeRow(500).id, { ...makeRow(500), content: "分页期间修改", sync_version: "502", updated_at: "2026-11-01T00:00:00Z" });
      return result;
    });
    await service.sync("user-a");
    expect(await store.getDownloadCursor("user-a")).toBe("501");
    expect(await store.getAllForSync("user-a")).toHaveLength(500);
    expect(read.mock.calls.every((call) => call[2] === "501")).toBe(true);
    await service.sync("user-a");
    expect(await store.getDownloadCursor("user-a")).toBe("502");
    expect((await store.getAllForSync("user-a")).find((record) => record.id === makeRow(500).id)?.content).toBe("分页期间修改");
  });

  it("does not stop early when the server's configured row cap is lower than 500", async () => {
    const { store, service, read } = setup(Array.from({ length: 7 }, (_, index) => makeRow(index)));
    const originalRead = read.getMockImplementation()!;
    read.mockImplementation((userId, after, latest) => originalRead(userId, after, latest, 2));
    await service.sync("user-a");
    expect(await store.getAllForSync("user-a")).toHaveLength(7);
    expect(read.mock.calls.map((call) => call[1])).toEqual(["0", "2", "4", "6"]);
  });

  it("protects local edits made earlier in the same download window, not just in the current page request", async () => {
    const { store, service, cloud, read, upsert } = setup(Array.from({ length: 501 }, (_, index) => makeRow(index)));
    await service.sync("user-a");
    for (let index = 0; index < 501; index += 1) {
      const row = makeRow(index);
      cloud.set(row.id, { ...row, sync_version: String(index + 502), updated_at: "2099-01-01T00:00:00Z" });
    }
    const originalRead = read.getMockImplementation()!;
    read.mockImplementationOnce(async (...args) => {
      const result = await originalRead(...args);
      await store.update({ ...fromRow(makeRow(500)), content: "在第一页下载时编辑了第二页的记录" });
      return result;
    });
    await service.sync("user-a");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0][0].content).toBe("在第一页下载时编辑了第二页的记录");
    expect((await store.getAllForSync("user-a")).find((record) => record.id === makeRow(500).id)?.content).toBe("在第一页下载时编辑了第二页的记录");
  });

  it("preserves earlier pages and their progress if a later page cannot be saved", async () => {
    const { store, service } = setup(Array.from({ length: 501 }, (_, index) => makeRow(index)));
    const originalPut = store.db.downloadScopes.put.bind(store.db.downloadScopes);
    vi.spyOn(store.db.downloadScopes, "put").mockImplementationOnce(originalPut).mockRejectedValueOnce(new Error("disk full"));
    await expect(service.sync("user-a")).rejects.toThrow("disk full");
    expect(await store.getDownloadCursor("user-a")).toBe("500");
    expect(await store.getAllForSync("user-a")).toHaveLength(500);
    await service.sync("user-a");
    expect(await store.getAllForSync("user-a")).toHaveLength(501);
  });

  it("stops safely if the server version is lower than a previously committed local cursor", async () => {
    const { store, service, rpc, read } = setup([makeRow(0)]);
    await service.sync("user-a");
    rpc.mockResolvedValueOnce({ data: "0", error: null });
    read.mockClear();
    await expect(service.sync("user-a")).rejects.toThrow("云端版本低于");
    expect(await store.getDownloadCursor("user-a")).toBe("1");
    expect(await store.getAllForSync("user-a")).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps bigint versions exact and does not expose sync metadata in backups", async () => {
    const row = { ...makeRow(), sync_version: "9007199254740993" };
    const { store, service, cloud, read } = setup([row]);
    await service.sync("user-a");
    cloud.set(row.id, { ...row, sync_version: "9007199254740994", is_highlighted: true, updated_at: "2026-11-01T00:00:00Z" });
    read.mockClear();
    await service.sync("user-a");
    expect(read.mock.calls[0][1]).toBe("9007199254740993");
    expect(await store.getDownloadCursor("user-a")).toBe("9007199254740994");
    expect((await store.exportBackup()).records[0]).not.toHaveProperty("syncVersion");
    expect((await store.exportBackup()).records[0]).not.toHaveProperty("sync_version");
  });

  it("never jumps the download cursor to a successful upload's version", async () => {
    const { store, service, cloud } = setup([makeRow(0)]);
    await service.sync("user-a");
    await store.create({ content: "本地新增", happenedAt: "2026-11-01T00:00:00Z" });
    cloud.set(makeRow(1).id, makeRow(1));
    await service.sync("user-a");
    expect(await store.getDownloadCursor("user-a")).toBe("2");
    expect([...cloud.values()].some((row) => row.sync_version === "3")).toBe(true);
    await service.sync("user-a");
    expect(await store.getDownloadCursor("user-a")).toBe("3");
  });

  it("does not apply or upload after the account becomes inactive during a request", async () => {
    const { store, service, read, upsert } = setup([makeRow(0)]);
    await store.create({ content: "保留待上传项", happenedAt: "2026-11-01T00:00:00Z" });
    let isActive = true;
    const originalRead = read.getMockImplementation()!;
    read.mockImplementationOnce(async (...args) => { isActive = false; return originalRead(...args); });
    const onDownloadedPage = vi.fn();
    await service.sync("user-a", { isActive: () => isActive, onDownloadedPage });
    expect(await store.getDownloadCursor("user-a")).toBe("0");
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(onDownloadedPage).not.toHaveBeenCalled();
  });

  it("reports an unapplied database migration without falling back to full downloads", async () => {
    const { store, service, rpc, read, upsert } = setup();
    await store.create({ content: "先保存在本地", happenedAt: "2026-11-01T00:00:00Z" });
    rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error("function missing"), { code: "PGRST202" }) });
    await expect(service.sync("user-a")).rejects.toThrow("数据库尚未启用增量同步");
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([null, -1, 1.5, "-1", "invalid", Number.MAX_SAFE_INTEGER + 1])("rejects invalid latest version %s without changing progress", async (version) => {
    const { store, service, rpc } = setup();
    rpc.mockResolvedValueOnce({ data: version, error: null });
    await expect(service.sync("user-a")).rejects.toThrow("同步版本无效");
    expect(await store.getDownloadCursor("user-a")).toBe("0");
  });

  it("rejects unordered, out-of-window and foreign-account pages before saving any of them", async () => {
    for (const page of [
      [makeRow(1), makeRow(0)],
      [{ ...makeRow(0), sync_version: "4" }],
      [{ ...makeRow(0), user_id: "user-b" }],
    ]) {
      const { store, service, read } = setup([makeRow(0), makeRow(1)]);
      read.mockResolvedValueOnce({ data: page, error: null });
      await expect(service.sync("user-a")).rejects.toThrow("同步顺序或账号无效");
      expect(await store.getDownloadCursor("user-a")).toBe("0");
      expect(await store.getAllForSync("user-a")).toHaveLength(0);
    }
  });
});
