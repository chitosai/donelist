// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncState } from "../sync/useRecordSync";
import { SyncStatus } from "./SyncStatus";

afterEach(cleanup);

const syncedState: SyncState = {
  phase: "idle",
  lastSyncedAt: new Date(2026, 9, 31, 20, 10),
  pendingChanges: 0,
  errorMessage: "",
};

describe("SyncStatus", () => {
  it.each<[Partial<SyncState>, string]>([
    [{}, "已同步 · 20:10"],
    [{ lastSyncedAt: null }, "0 项待同步"],
    [{ lastSyncedAt: null, pendingChanges: 3 }, "3 项待同步"],
    [{ pendingChanges: 3 }, "3 项待同步"],
    [{ phase: "syncing", pendingChanges: 3 }, "正在同步…"],
    [{ phase: "offline" }, "当前无网络连接，将在联网后同步"],
    [{ phase: "offline", pendingChanges: 3 }, "当前无网络连接，3 项待同步"],
    [{ phase: "error", pendingChanges: 3 }, "同步失败，点击下方按钮重试"],
  ])("renders the appropriate status for %j", (overrides, message) => {
    render(<SyncStatus syncState={{ ...syncedState, ...overrides }} />);
    expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe(message);
  });

  it("shows the detailed failure only in the error state", () => {
    const { rerender } = render(<SyncStatus syncState={{ ...syncedState, phase: "error", errorMessage: "Failed to fetch" }} />);
    expect(screen.getByText("Failed to fetch")).toBeTruthy();
    rerender(<SyncStatus syncState={{ ...syncedState, errorMessage: "Failed to fetch" }} />);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });
});
