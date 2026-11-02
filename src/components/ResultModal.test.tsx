// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultModal } from "./ResultModal";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ResultModal", () => {
  it("requires explicit confirmation instead of dismissing on the backdrop, Escape or a timer", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(<ResultModal message="数据格式不合法" detail="Unexpected end of JSON input" onConfirm={onConfirm} />);
    const modal = screen.getByRole("alertdialog", { name: "数据格式不合法" });
    fireEvent.mouseDown(modal.parentElement!);
    fireEvent.click(modal.parentElement!);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("alertdialog")).toBe(modal);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders globally, traps keyboard focus, locks scrolling and restores focus on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const previousOverflow = document.body.style.overflow;
    const { container, unmount } = render(<ResultModal message="已导入 1 条记录" onConfirm={vi.fn()} />);
    const modal = screen.getByRole("alertdialog");
    const confirm = screen.getByRole("button", { name: "确认" });
    expect(container.contains(modal)).toBe(false);
    expect(document.body.contains(modal)).toBe(true);
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(confirm);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    opener.focus();
    expect(document.activeElement).toBe(confirm);
    unmount();
    expect(document.body.style.overflow).toBe(previousOverflow);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("shows technical details as muted literal text, not executable markup", () => {
    const detail = '<img src=x onerror="alert(1)">';
    render(<ResultModal message="数据格式不合法" detail={detail} onConfirm={vi.fn()} />);
    const modal = screen.getByRole("alertdialog");
    const detailElement = screen.getByText(detail);
    expect(detailElement.className).toBe("result-modal-detail");
    expect(modal.getAttribute("aria-describedby")).toBe(detailElement.id);
    expect(modal.querySelector("img")).toBeNull();
  });

  it("supports an explicit cancel choice, defaults focus to it, and cycles focus between both actions", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ResultModal message="将账号备份导入本地？" confirmLabel="继续导入" onConfirm={onConfirm} onCancel={onCancel} />);
    const cancel = screen.getByRole("button", { name: "取消" });
    const confirm = screen.getByRole("button", { name: "继续导入" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
