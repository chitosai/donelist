// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestMergeRequest } from "../sync/useRecordSync";
import { GuestRecordsMergeDialog } from "./GuestRecordsMergeDialog";

afterEach(cleanup);

const request: GuestMergeRequest = {
  userId: "user-a", scopeVersion: 1, recordIds: ["one", "two"], isMerging: false, errorMessage: "",
};

function renderDialog(overrides: Partial<GuestMergeRequest> = {}) {
  const onMerge = vi.fn();
  const onKeepGuest = vi.fn();
  const rendered = render(<GuestRecordsMergeDialog request={{ ...request, ...overrides }} accountEmail="test@example.com" onMerge={onMerge} onKeepGuest={onKeepGuest} />);
  return { ...rendered, onMerge, onKeepGuest };
}

describe("GuestRecordsMergeDialog", () => {
  it("shows the account, count and both choices without merging automatically", async () => {
    const { onMerge, onKeepGuest } = renderDialog();
    expect(screen.getByRole("alertdialog", { name: "合并登录前的记录？" })).toBeTruthy();
    const email = screen.getByText("test@example.com");
    expect(email.classList.contains("guest-merge-email")).toBe(true);
    expect(email.parentElement?.textContent).toBe("当前账号：test@example.com");
    expect(screen.getByText(/有 2 条登录前的记录/)).toBeTruthy();
    expect(screen.getByText(/退出登录后仍能看到/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "暂不合并" }));
    expect(onMerge).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "合并到当前账号" }));
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(onKeepGuest).not.toHaveBeenCalled();
  });

  it.each(["button", "Escape", "backdrop"])("keeps guest data when dismissed via %s", async (method) => {
    const { onMerge, onKeepGuest } = renderDialog();
    if (method === "button") await userEvent.click(screen.getByRole("button", { name: "暂不合并" }));
    else if (method === "Escape") await userEvent.keyboard("{Escape}");
    else fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onKeepGuest).toHaveBeenCalledTimes(1);
    expect(onMerge).not.toHaveBeenCalled();
  });

  it("locks both choices while merging and cannot be dismissed", async () => {
    const { onMerge, onKeepGuest } = renderDialog({ isMerging: true });
    expect((screen.getByRole("button", { name: "暂不合并" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在合并…" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onKeepGuest).not.toHaveBeenCalled();
    expect(onMerge).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside the dialog and restores prior focus on close", async () => {
    const previousFocus = document.createElement("button");
    document.body.append(previousFocus);
    previousFocus.focus();
    const { unmount } = renderDialog();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "合并到当前账号" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "暂不合并" }));
    unmount();
    expect(document.activeElement).toBe(previousFocus);
    previousFocus.remove();
  });

  it("shows a merge error and keeps retry and decline available", () => {
    renderDialog({ errorMessage: "合并失败，请重试。" });
    expect(screen.getByRole("alert").textContent).toBe("合并失败，请重试。");
    expect((screen.getByRole("button", { name: "合并到当前账号" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "暂不合并" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
