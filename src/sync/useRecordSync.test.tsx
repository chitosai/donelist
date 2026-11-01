// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}

import "fake-indexeddb/auto";
import { deserialize, serialize } from "node:v8";
import { StrictMode, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRecordRepository } from "../data/IndexedDbRecordRepository";
import { LocalRecordRepository } from "../data/LocalRecordRepository";
import { createUser, deferred } from "../test/authTestUtils";
import { useRecordSync } from "./useRecordSync";
import type { RecordSyncOptions } from "./RecordSyncService";

const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("./RecordSyncService", () => ({
  RecordSyncService: class { sync = syncMock; },
}));

const databases: IndexedDbRecordRepository[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("structuredClone", <T,>(value: T): T => deserialize(serialize(value)));
  syncMock.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((store) => store.db.delete()));
  vi.unstubAllGlobals();
});

function createStore() {
  const store = new IndexedDbRecordRepository(`done-list-guest-consent-test-${crypto.randomUUID()}`);
  databases.push(store);
  return store;
}

async function addRecord(store: IndexedDbRecordRepository, content = "登录前的记录") {
  return store.create({ content, happenedAt: new Date().toISOString() });
}

function renderSync(localStore: IndexedDbRecordRepository, user: User | null = createUser("user-a"), isAuthReady = true, isStrictMode = false) {
  const repository = new LocalRecordRepository(localStore);
  const onRecordsChanged = vi.fn(async () => undefined);
  const wrapper = isStrictMode ? ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode> : undefined;
  const rendered = renderHook((props: { user: User | null; isAuthReady: boolean }) => useRecordSync({
    ...props, localStore, repository, onRecordsChanged,
  }), { initialProps: { user, isAuthReady }, wrapper });
  return { ...rendered, repository, onRecordsChanged };
}

describe("useRecordSync: guest merge consent", () => {
  it("refreshes after each committed download page while keeping the syncing state", async () => {
    const store = createStore();
    const pending = deferred<void>();
    let callbacks: RecordSyncOptions | undefined;
    syncMock.mockImplementationOnce((_userId: string, options: RecordSyncOptions) => { callbacks = options; return pending.promise; });
    const { result, onRecordsChanged } = renderSync(store);
    await waitFor(() => expect(result.current.syncState.phase).toBe("syncing"));
    const initialCalls = onRecordsChanged.mock.calls.length;
    await act(async () => { await callbacks!.onDownloadedPage!(); });
    expect(onRecordsChanged).toHaveBeenCalledTimes(initialCalls + 1);
    expect(result.current.syncState.phase).toBe("syncing");
    expect(result.current.syncState.lastSyncedAt).toBeNull();
    await act(async () => { pending.resolve(); });
    await waitFor(() => expect(result.current.syncState.phase).toBe("idle"));
  });

  it("invalidates download callbacks on logout instead of refreshing the wrong scope", async () => {
    const store = createStore();
    const pending = deferred<void>();
    let callbacks: RecordSyncOptions | undefined;
    syncMock.mockImplementationOnce((_userId: string, options: RecordSyncOptions) => { callbacks = options; return pending.promise; });
    const { result, rerender, onRecordsChanged } = renderSync(store);
    await waitFor(() => expect(result.current.syncState.phase).toBe("syncing"));
    expect(callbacks!.isActive!()).toBe(true);
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    expect(callbacks!.isActive!()).toBe(false);
    const calls = onRecordsChanged.mock.calls.length;
    await act(async () => { await callbacks!.onDownloadedPage!(); pending.resolve(); });
    expect(onRecordsChanged).toHaveBeenCalledTimes(calls);
    expect(result.current.syncState.phase).toBe("signed-out");
  });

  it("does not ask or sync while signed out", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const { result, onRecordsChanged } = renderSync(store, null);
    await waitFor(() => expect(onRecordsChanged).toHaveBeenCalled());
    expect(result.current.guestMergeRequest).toBeNull();
    expect(await store.getRecent(10)).toEqual([guest]);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("waits for auth restoration before inspecting or changing scope", async () => {
    const store = createStore();
    await addRecord(store);
    const getGuestRecords = vi.spyOn(store, "getGuestRecords");
    const { result, rerender } = renderSync(store, createUser("user-a"), false);
    expect(getGuestRecords).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    rerender({ user: createUser("user-a"), isAuthReady: true });
    await waitFor(() => expect(result.current.guestMergeRequest?.recordIds).toHaveLength(1));
  });

  it("asks after login without moving or uploading any guest record, even on background sync triggers", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const claimGuestRecords = vi.spyOn(store, "claimGuestRecords");
    const { result } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest?.recordIds).toEqual([guest.id]));
    expect(await store.getRecent(10)).toEqual([]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    await act(async () => {
      await result.current.syncNow();
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(claimGuestRecords).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("preserves declined guest data, syncs only the account, and shows guests again after logout", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    act(() => result.current.keepGuestRecords());
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith("user-a", expect.any(Object)));
    expect(result.current.guestMergeRequest).toBeNull();
    expect(await store.getAllForSync("user-a")).toEqual([]);
    expect(await store.getGuestRecords()).toEqual([guest]);
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    expect(await store.getRecent(10)).toEqual([guest]);
  });

  it("merges only the confirmed snapshot and then syncs the selected account", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest?.recordIds).toEqual([guest.id]));
    store.setGuestScope();
    const laterGuest = await addRecord(store, "稍后新增的游客记录");
    store.setUserScope("user-a");
    await act(async () => { await result.current.mergeGuestRecords(); });
    expect(result.current.guestMergeRequest).toBeNull();
    expect((await store.getRecent(10)).map((record) => record.id)).toEqual([guest.id]);
    expect(await store.getGuestRecords()).toEqual([laterGuest]);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith("user-a", expect.any(Object));
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    expect(await store.getRecent(10)).toEqual([laterGuest]);
  });

  it("syncs normally without asking when there are no visible guest records", async () => {
    const store = createStore();
    const deleted = await addRecord(store);
    await store.delete(deleted.id);
    const { result } = renderSync(store);
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith("user-a", expect.any(Object)));
    expect(result.current.guestMergeRequest).toBeNull();
    expect(await store.getAllForSync("user-a")).toEqual([]);
  });

  it("does not ask again when the same account object is refreshed or the tab becomes visible", async () => {
    const store = createStore();
    await addRecord(store);
    const getGuestRecords = vi.spyOn(store, "getGuestRecords");
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    act(() => result.current.keepGuestRecords());
    await waitFor(() => expect(result.current.syncState.lastSyncedAt).not.toBeNull());
    rerender({ user: createUser("user-a"), isAuthReady: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.guestMergeRequest).toBeNull();
    expect(getGuestRecords).toHaveBeenCalledTimes(1);
  });

  it("asks again on a subsequent login and never applies an old account's answer to a new account", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest?.userId).toBe("user-a"));
    const oldMerge = result.current.mergeGuestRecords;
    const oldKeep = result.current.keepGuestRecords;
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    rerender({ user: createUser("user-b"), isAuthReady: true });
    await waitFor(() => expect(result.current.guestMergeRequest?.userId).toBe("user-b"));
    await act(async () => { await oldMerge(); oldKeep(); });
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(result.current.guestMergeRequest?.userId).toBe("user-b");
    await act(async () => { await result.current.mergeGuestRecords(); });
    expect((await store.getAllForSync("user-b")).map((record) => record.id)).toEqual([guest.id]);
    expect(await store.getAllForSync("user-a")).toEqual([]);
  });

  it("discards a guest lookup that finishes after logout", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const pending = deferred<Awaited<ReturnType<typeof store.getGuestRecords>>>();
    vi.spyOn(store, "getGuestRecords").mockReturnValueOnce(pending.promise);
    const { result, rerender, onRecordsChanged } = renderSync(store);
    await waitFor(() => expect(onRecordsChanged).toHaveBeenCalled());
    rerender({ user: null, isAuthReady: true });
    await act(async () => pending.resolve([guest]));
    expect(result.current.guestMergeRequest).toBeNull();
    expect(await store.getRecent(10)).toEqual([guest]);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("does not reuse a previous login's answer after logging into the same account again", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    const oldMerge = result.current.mergeGuestRecords;
    const oldKeep = result.current.keepGuestRecords;
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    rerender({ user: createUser("user-a"), isAuthReady: true });
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    await act(async () => { await oldMerge(); oldKeep(); });
    expect(result.current.guestMergeRequest?.userId).toBe("user-a");
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("can merge locally while offline without losing the pending account records", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const store = createStore();
    const guest = await addRecord(store);
    const { result } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    await act(async () => { await result.current.mergeGuestRecords(); });
    expect(result.current.guestMergeRequest).toBeNull();
    expect(result.current.syncState.phase).toBe("offline");
    expect(result.current.syncState.pendingChanges).toBe(1);
    expect((await store.getAllForSync("user-a")).map((record) => record.id)).toEqual([guest.id]);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("keeps failed merges retryable and prevents duplicate submission or dismissal while merging", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const claimGuestRecords = vi.spyOn(store, "claimGuestRecords");
    const pending = deferred<number>();
    claimGuestRecords.mockReturnValueOnce(pending.promise);
    const { result } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    let mergePromise: Promise<void>;
    act(() => {
      mergePromise = result.current.mergeGuestRecords();
      void result.current.mergeGuestRecords();
      result.current.keepGuestRecords();
    });
    expect(result.current.guestMergeRequest?.isMerging).toBe(true);
    expect(claimGuestRecords).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("磁盘暂时不可用"));
      await mergePromise;
    });
    expect(result.current.guestMergeRequest?.errorMessage).toBe("磁盘暂时不可用");
    expect(result.current.guestMergeRequest?.isMerging).toBe(false);
    expect(await store.getGuestRecords()).toEqual([guest]);
    expect(syncMock).not.toHaveBeenCalled();
    await act(async () => { await result.current.mergeGuestRecords(); });
    expect(result.current.guestMergeRequest).toBeNull();
    expect(await store.getGuestRecords()).toEqual([]);
    expect((await store.getAllForSync("user-a")).map((record) => record.id)).toEqual([guest.id]);
  });

  it("retains a successful local merge when cloud sync fails", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    syncMock.mockRejectedValueOnce(new Error("网络错误"));
    const { result } = renderSync(store);
    await waitFor(() => expect(result.current.guestMergeRequest).not.toBeNull());
    await act(async () => { await result.current.mergeGuestRecords(); });
    expect(result.current.guestMergeRequest).toBeNull();
    expect(result.current.syncState.phase).toBe("error");
    expect(result.current.syncState.pendingChanges).toBe(1);
    expect((await store.getAllForSync("user-a")).map((record) => record.id)).toEqual([guest.id]);
    expect(await store.getGuestRecords()).toEqual([]);
  });

  it("ignores an old sync result after logout", async () => {
    const store = createStore();
    const pending = deferred<void>();
    syncMock.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    await act(async () => pending.resolve());
    expect(result.current.syncState.phase).toBe("signed-out");
    expect(result.current.syncState.lastSyncedAt).toBeNull();
  });

  it("never merges automatically under StrictMode effect replay", async () => {
    const store = createStore();
    const guest = await addRecord(store);
    const claimGuestRecords = vi.spyOn(store, "claimGuestRecords");
    const { result } = renderSync(store, createUser("user-a"), true, true);
    await waitFor(() => expect(result.current.guestMergeRequest?.recordIds).toEqual([guest.id]));
    expect(claimGuestRecords).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("restores the distinct pending-record count while offline after remounting", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const store = createStore();
    store.setUserScope("user-a");
    const record = await addRecord(store);
    await addRecord(store, "第二条");
    await store.update({ ...record, content: "反复编辑仍只有一项" });
    const first = renderSync(store);
    await waitFor(() => expect(first.result.current.syncState.pendingChanges).toBe(2));
    first.unmount();
    const reopened = renderSync(store);
    await waitFor(() => expect(reopened.result.current.syncState.pendingChanges).toBe(2));
    expect(reopened.result.current.syncState.phase).toBe("offline");
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("waits one second after the latest local change before automatically syncing", async () => {
    const store = createStore();
    const subscribe = vi.spyOn(LocalRecordRepository.prototype, "subscribe");
    const { result, unmount } = renderSync(store);
    await waitFor(() => expect(result.current.syncState.lastSyncedAt).not.toBeNull());
    const onLocalChange = subscribe.mock.calls[0][0];
    expect(syncMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => onLocalChange());
      await act(async () => { await vi.advanceTimersByTimeAsync(650); });
      expect(syncMock).toHaveBeenCalledTimes(1);

      // Another edit resets the debounce window instead of starting a second sync.
      act(() => onLocalChange());
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(syncMock).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(syncMock).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("automatically follows up when a newer mutation survives an in-flight upload", async () => {
    const store = createStore();
    store.setUserScope("user-a");
    const record = await addRecord(store);
    syncMock.mockImplementationOnce(async () => {
      const batch = await store.getPendingUploads("user-a");
      await store.update({ ...record, content: "上传期间的新版本" });
      await store.acknowledgeUploads("user-a", batch);
    }).mockImplementationOnce(async () => {
      await store.acknowledgeUploads("user-a", await store.getPendingUploads("user-a"));
    });
    const { result } = renderSync(store);
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2), { timeout: 2500 });
    await waitFor(() => expect(result.current.syncState.pendingChanges).toBe(0));
    expect((await store.getAllForSync("user-a"))[0].content).toBe("上传期间的新版本");
  });

  it("keeps another account's queue after logout without displaying its pending count", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const store = createStore();
    store.setUserScope("user-a");
    await addRecord(store);
    const { result, rerender } = renderSync(store);
    await waitFor(() => expect(result.current.syncState.pendingChanges).toBe(1));
    rerender({ user: null, isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("signed-out"));
    expect(result.current.syncState.pendingChanges).toBe(0);
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
    rerender({ user: createUser("user-b"), isAuthReady: true });
    await waitFor(() => expect(result.current.syncState.phase).toBe("offline"));
    expect(result.current.syncState.pendingChanges).toBe(0);
    expect(await store.getPendingUploadCount("user-a")).toBe(1);
  });
});
