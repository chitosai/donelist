// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}

import "fake-indexeddb/auto";
import { deserialize, serialize } from "node:v8";
import { StrictMode } from "react";
import type { User } from "@supabase/supabase-js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexedDbRecordRepository } from "./data/IndexedDbRecordRepository";
import type { DoneRecord } from "./domain/DoneRecord";
import { createUser, deferred } from "./test/authTestUtils";
import { App } from "./App";

const { fixture, syncMock } = vi.hoisted(() => ({
  fixture: {
    store: null as IndexedDbRecordRepository | null,
    auth: { user: null as User | null, isAuthReady: false },
  },
  syncMock: vi.fn(),
}));
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => fixture.auth }));
vi.mock("./lib/supabase", () => ({ supabase: {} }));
vi.mock("./sync/RecordSyncService", () => ({ RecordSyncService: class { sync = syncMock; } }));
vi.mock("./data/IndexedDbRecordRepository", async (importOriginal) => {
  const original = await importOriginal<typeof import("./data/IndexedDbRecordRepository")>();
  return {
    ...original,
    IndexedDbRecordRepository: class extends original.IndexedDbRecordRepository {
      constructor(_databaseName?: string, syncTarget?: string) {
        super(`done-list-app-test-${crypto.randomUUID()}`, syncTarget);
        fixture.store = this;
      }
    },
  };
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("structuredClone", <T,>(value: T): T => deserialize(serialize(value)));
  fixture.auth = { user: null, isAuthReady: false };
  fixture.store!.setGuestScope();
  await fixture.store!.db.records.clear();
  await fixture.store!.db.pendingUploads.clear();
  await fixture.store!.db.uploadScopes.clear();
  await fixture.store!.db.downloadScopes.clear();
  syncMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => { await fixture.store!.db.delete(); });

async function seedAccount(userId = "user-a", content = "已经存在本地的记录") {
  fixture.store!.setUserScope(userId);
  const record = await fixture.store!.create({ content, happenedAt: new Date().toISOString() });
  fixture.store!.setGuestScope();
  return record;
}

function restoreAccount(userId = "user-a") {
  fixture.auth = { user: createUser(userId), isAuthReady: true };
}

describe("App: local records before background sync", () => {
  it("exports only the signed-in account through the collapsed data-management entry", async () => {
    const accountRecord = await seedAccount("user-a", "当前账号的备份记录");
    await seedAccount("user-b", "不能混入导出的其他账号记录");
    const exportBackup = vi.spyOn(fixture.store!, "exportBackup");
    const createObjectURL = vi.fn(() => "blob:account-backup-test");
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByText(accountRecord.content)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "同步与账户" }));
    fireEvent.click(screen.getByText("数据管理"));
    fireEvent.click(screen.getByRole("button", { name: "导出数据" }));
    await screen.findByText("备份已导出");
    expect(exportBackup).toHaveBeenCalledTimes(1);
    expect((await exportBackup.mock.results[0].value).records).toEqual([accountRecord]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:account-backup-test");
  });

  it("imports a backup into the signed-in account and queues its records for cloud sync", async () => {
    const accountRecord = await seedAccount();
    const otherRecord = await seedAccount("user-b", "其他账号保持不变");
    const importedRecord = { ...accountRecord, id: crypto.randomUUID(), content: "从备份导入当前账号" };
    restoreAccount();
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText(accountRecord.content)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "同步与账户" }));
    fireEvent.click(screen.getByText("数据管理"));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const chooseFile = vi.spyOn(fileInput, "click");
    fireEvent.click(screen.getByRole("button", { name: "导入数据" }));
    expect(chooseFile).toHaveBeenCalledTimes(1);
    const backup = { format: "done-list-backup", version: 1, exportedAt: new Date().toISOString(), records: [importedRecord] };
    const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByText("已导入 1 条记录");
    expect(screen.getByRole("alertdialog", { name: "已导入 1 条记录" })).toBeTruthy();
    expect(container.querySelector(".toast")).toBeNull();
    expect(screen.getByText(importedRecord.content)).toBeTruthy();
    expect((await fixture.store!.getAllForSync("user-a")).map((record) => record.id)).toContain(importedRecord.id);
    expect((await fixture.store!.getAllForSync("user-b")).map((record) => record.id)).toEqual([otherRecord.id]);
    expect((await fixture.store!.getPendingUploads("user-a")).map((upload) => upload.recordId)).toContain(importedRecord.id);
  });

  it("uses a decorative calendar icon while preserving the Review button's accessible name", async () => {
    fixture.auth.isAuthReady = true;
    render(<App />);
    const review = screen.getByRole("button", { name: /^回顾$/ }) as HTMLButtonElement;
    await waitFor(() => expect(review.disabled).toBe(false));
    expect(review.textContent?.trim()).toBe("回顾");
    expect(review.querySelector(".review-button-label")?.textContent).toBe("回顾");
    expect(review.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(review.querySelector("svg")?.getAttribute("focusable")).toBe("false");
  });

  it("waits for identity without querying guests or showing a false empty state, then displays cache while syncing", async () => {
    const localRecord = await seedAccount();
    const cloud = deferred<void>();
    syncMock.mockReturnValue(cloud.promise);
    const getRecent = vi.spyOn(fixture.store!, "getRecent");
    const { rerender } = render(<App />);
    expect(getRecent).not.toHaveBeenCalled();
    expect(screen.getByText("正在读取本地记录…")).toBeTruthy();
    expect(screen.queryByText("这里会列出你刚刚完成的事情。")).toBeNull();
    expect((screen.getByLabelText("记录内容") as HTMLTextAreaElement).disabled).toBe(true);

    restoreAccount();
    rerender(<App />);
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(localRecord.content)).toBeTruthy();
    expect(screen.getByRole("button", { name: "同步与账户" }).classList.contains("is-syncing")).toBe(true);
    expect((screen.getByLabelText("记录内容") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText("这里会列出你刚刚完成的事情。")).toBeNull();
    await act(async () => cloud.resolve());
  });

  it("refreshes the displayed cache after the background sync applies a new cloud record", async () => {
    const localRecord = await seedAccount();
    const cloud = deferred<void>();
    const cloudRecord = { ...localRecord, id: crypto.randomUUID(), content: "从另一台设备同步来的记录", deletedAt: null };
    syncMock.mockImplementation(async () => {
      await cloud.promise;
      await fixture.store!.mergeFromSync([cloudRecord], "user-a");
    });
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByText(localRecord.content)).toBeTruthy());
    expect(screen.queryByText(cloudRecord.content)).toBeNull();
    await act(async () => cloud.resolve());
    await waitFor(() => expect(screen.getByText(cloudRecord.content)).toBeTruthy());
    expect(screen.getByText(localRecord.content)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "同步与账户" }).classList.contains("is-syncing")).toBe(false));
  });

  it("does not wait for outbox initialization before showing local records", async () => {
    const record = await seedAccount();
    const outbox = deferred<void>();
    vi.spyOn(fixture.store!, "prepareUploadQueue").mockReturnValue(outbox.promise);
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByText(record.content)).toBeTruthy());
    expect(syncMock).not.toHaveBeenCalled();
    await act(async () => outbox.resolve());
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
  });

  it("keeps cached records visible and editable when cloud sync fails", async () => {
    const record = await seedAccount();
    syncMock.mockRejectedValue(new Error("Failed to fetch"));
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByText(record.content)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "同步与账户" }));
    await waitFor(() => expect(screen.getByText("同步失败，点击下方按钮重试")).toBeTruthy());
    expect(screen.getByText(record.content)).toBeTruthy();
    expect((screen.getByLabelText("记录内容") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("loads the signed-in account's local records even when offline", async () => {
    const record = await seedAccount();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByText(record.content)).toBeTruthy());
    expect(syncMock).not.toHaveBeenCalled();
    expect(screen.queryByText("这里会列出你刚刚完成的事情。")).toBeNull();
  });

  it("loads only guest records when signed out", async () => {
    const accountRecord = await seedAccount();
    const guest = await fixture.store!.create({ content: "游客区的本地记录", happenedAt: new Date().toISOString() });
    fixture.auth.isAuthReady = true;
    render(<App />);
    await waitFor(() => expect(screen.getByText(guest.content)).toBeTruthy());
    expect(screen.queryByText(accountRecord.content)).toBeNull();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("ignores a slow account read that completes after switching to another account", async () => {
    const recordA = await seedAccount("user-a", "账号 A 的记录");
    const recordB = await seedAccount("user-b", "账号 B 的记录");
    const oldRead = deferred<DoneRecord[]>();
    vi.spyOn(fixture.store!, "getRecent").mockReturnValueOnce(oldRead.promise);
    restoreAccount();
    const { rerender } = render(<App />);
    expect(screen.getByText("正在读取本地记录…")).toBeTruthy();
    restoreAccount("user-b");
    rerender(<App />);
    await waitFor(() => expect(screen.getByText(recordB.content)).toBeTruthy());
    await act(async () => oldRead.resolve([recordA]));
    expect(screen.getByText(recordB.content)).toBeTruthy();
    expect(screen.queryByText(recordA.content)).toBeNull();
    expect(syncMock).not.toHaveBeenCalledWith("user-a", expect.any(Object));
  });

  it("ignores a slow account read after logout and displays the preserved guests", async () => {
    const accountRecord = await seedAccount();
    const guest = await fixture.store!.create({ content: "退出后显示的游客记录", happenedAt: new Date().toISOString() });
    const oldRead = deferred<DoneRecord[]>();
    vi.spyOn(fixture.store!, "getRecent").mockReturnValueOnce(oldRead.promise);
    restoreAccount();
    const { rerender } = render(<App />);
    fixture.auth = { user: null, isAuthReady: true };
    rerender(<App />);
    await waitFor(() => expect(screen.getByText(guest.content)).toBeTruthy());
    await act(async () => oldRead.resolve([accountRecord]));
    expect(screen.getByText(guest.content)).toBeTruthy();
    expect(screen.queryByText(accountRecord.content)).toBeNull();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("ignores StrictMode's stale initial read rather than clearing an already visible cache", async () => {
    const record = await seedAccount();
    const oldRead = deferred<DoneRecord[]>();
    const cloud = deferred<void>();
    syncMock.mockReturnValue(cloud.promise);
    vi.spyOn(fixture.store!, "getRecent").mockReturnValueOnce(oldRead.promise);
    restoreAccount();
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(record.content)).toBeTruthy();
    await act(async () => oldRead.resolve([]));
    expect(screen.getByText(record.content)).toBeTruthy();
    expect(screen.queryByText("这里会列出你刚刚完成的事情。")).toBeNull();
    await act(async () => cloud.resolve());
  });

  it("shows a read failure rather than claiming that the local database is empty", async () => {
    vi.spyOn(fixture.store!, "getRecent").mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    restoreAccount();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("读取记录失败"));
    expect(screen.queryByText("这里会列出你刚刚完成的事情。")).toBeNull();
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("App: import result confirmation", () => {
  async function renderImportApp() {
    const original = await fixture.store!.create({ content: "导入前的记录不能丢", happenedAt: new Date().toISOString() });
    fixture.auth.isAuthReady = true;
    const { container } = render(<App />);
    await screen.findByText(original.content);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    return { original, container, input };
  }

  function selectSource(input: HTMLInputElement, source: string) {
    const file = new File([source], "selected-file.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => source });
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("shows the exact JSON parsing error below a clear title and keeps the result until confirmed", async () => {
    const { original, container, input } = await renderImportApp();
    const source = '{"records":';
    let parsingMessage = "";
    try { JSON.parse(source); } catch (error) { parsingMessage = (error as Error).message; }
    selectSource(input, source);
    const modal = await screen.findByRole("alertdialog", { name: "数据格式不合法" });
    expect(within(modal).getByText(parsingMessage).className).toBe("result-modal-detail");
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector(".toast")).toBeNull();
    expect((await fixture.store!.getRecent(10))).toEqual([original]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(modal.parentElement!);
    expect(screen.getByRole("alertdialog")).toBe(modal);
    fireEvent.click(within(modal).getByRole("button", { name: "确认" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(input.value).toBe("");
    selectSource(input, source);
    await screen.findByRole("alertdialog", { name: "数据格式不合法" });
  });

  it.each([{}, [], null, 42, "unrelated", { format: "done-list-backup", version: 2, records: [] }, { format: "done-list-backup", version: 1, records: "wrong" }])(
    "rejects unrelated JSON %j with the requested copy and no record changes", async (value) => {
      const { original, input } = await renderImportApp();
      selectSource(input, JSON.stringify(value));
      await screen.findByRole("alertdialog", { name: "这个文件似乎并不是 Donelist 数据备份" });
      expect(await fixture.store!.getRecent(10)).toEqual([original]);
      expect(await fixture.store!.db.pendingUploads.count()).toBe(0);
    },
  );

  it("clearly reports both imported and skipped records without changing the existing filtering policy", async () => {
    const { original, input } = await renderImportApp();
    const valid = { ...original, id: crypto.randomUUID(), content: "这条可以导入" };
    selectSource(input, JSON.stringify({ format: "done-list-backup", version: 1, records: [valid, null, {}] }));
    const modal = await screen.findByRole("alertdialog", { name: "已导入 1 条记录" });
    expect(within(modal).getByText("另有 2 条记录格式不完整，已跳过。")).toBeTruthy();
    expect((await fixture.store!.getRecent(10)).map((record) => record.id).sort()).toEqual([original.id, valid.id].sort());
  });

  it.each([
    [[{}, null], "未导入任何记录", "文件中有 2 条记录格式不完整，均已跳过。"],
    [[], "备份中没有可导入的记录", null],
  ] as const)("makes a zero-record result explicit for %j", async (records, title, detail) => {
    const { original, input } = await renderImportApp();
    selectSource(input, JSON.stringify({ format: "done-list-backup", version: 1, records }));
    const modal = await screen.findByRole("alertdialog", { name: title });
    if (detail) expect(within(modal).getByText(detail)).toBeTruthy();
    expect(await fixture.store!.getRecent(10)).toEqual([original]);
  });

  it("distinguishes a file-read failure from malformed JSON", async () => {
    const { original, input } = await renderImportApp();
    const file = new File([], "unreadable.json");
    Object.defineProperty(file, "text", { value: async () => { throw new Error("File cannot be read"); } });
    fireEvent.change(input, { target: { files: [file] } });
    const modal = await screen.findByRole("alertdialog", { name: "无法读取文件" });
    expect(within(modal).getByText("File cannot be read").className).toBe("result-modal-detail");
    expect(await fixture.store!.getRecent(10)).toEqual([original]);
  });
});
