import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRecordRepository } from "../data/IndexedDbRecordRepository";
import { RecordSyncService } from "./RecordSyncService";

const databases: IndexedDbRecordRepository[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((store) => store.db.delete()));
});

describe("RecordSyncService: explicit account scope", () => {
  it("does not read or merge guest records when the active UI scope changes during a request", async () => {
    const store = new IndexedDbRecordRepository(`done-list-sync-scope-test-${crypto.randomUUID()}`);
    databases.push(store);
    const guest = await store.create({ content: "暂不合并的游客记录", happenedAt: new Date().toISOString() });
    store.setUserScope("user-a");
    const account = await store.create({ content: "账号 A", happenedAt: new Date().toISOString() });
    const cloud = { ...account, id: crypto.randomUUID(), content: "云端记录" };
    const eq = vi.fn(async () => {
      store.setGuestScope();
      return { data: [{
        id: cloud.id, user_id: "user-a", content: cloud.content,
        happened_at: cloud.happenedAt, created_at: cloud.createdAt,
        updated_at: cloud.updatedAt, is_highlighted: false, deleted_at: null,
      }], error: null };
    });
    const upsert = vi.fn(async (_rows: Array<{ id: string; user_id: string }>, _options: { onConflict: string }) => ({ error: null }));
    const client = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq })), upsert })) };

    await new RecordSyncService(client as unknown as SupabaseClient, store).sync("user-a");
    expect(eq).toHaveBeenCalledWith("user_id", "user-a");
    const uploaded = upsert.mock.calls[0][0];
    expect(uploaded.map((record) => record.id).sort()).toEqual([account.id, cloud.id].sort());
    expect(uploaded.every((record) => record.user_id === "user-a")).toBe(true);
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(await store.getRecent(10)).toEqual([guest]);
  });
});
