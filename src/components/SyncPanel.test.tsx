// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import type { SyncState } from "../sync/useRecordSync";
import {
  authMock, createSession, createUser, deferred, emitAuthEvent, resetAuthMock,
} from "../test/authTestUtils";
import { SyncPanel } from "./SyncPanel";

vi.mock("../lib/supabase", async () => {
  const { authMock: auth } = await import("../test/authTestUtils");
  return { supabase: { auth } };
});

const confirmationMessage = "我们向您发送了一封确认邮件，请点击邮件中的链接完成注册。";
const signedOutState: SyncState = {
  phase: "signed-out", lastSyncedAt: null, pendingChanges: 0, errorMessage: "",
};

beforeEach(resetAuthMock);
afterEach(cleanup);

async function renderPanel(syncState = signedOutState) {
  const user = userEvent.setup();
  const callbacks = { onSync: vi.fn(), onExport: vi.fn(), onImport: vi.fn() };
  const panel = render(
    <AuthProvider><SyncPanel syncState={syncState} {...callbacks} /></AuthProvider>,
  );
  await user.click(screen.getByRole("button", { name: "登录与数据同步" }));
  await screen.findByRole("button", { name: "注册" });
  return { user, callbacks, ...panel };
}

async function openAuth(view: "注册" | "登录" = "注册") {
  const panel = await renderPanel();
  await panel.user.click(screen.getByRole("button", { name: view }));
  return panel;
}

async function fillRegistration(user: ReturnType<typeof userEvent.setup>, values: {
  email?: string; password?: string; confirmation?: string;
} = {}) {
  const { email = "preview+test1@example.com", password = "password123", confirmation = password } = values;
  if (email) await user.type(screen.getByLabelText("邮箱"), email);
  if (password) await user.type(screen.getByLabelText("密码", { exact: true }), password);
  if (confirmation) await user.type(screen.getByLabelText("确认密码"), confirmation);
}

async function renderSignedInPanel(syncState: SyncState = { ...signedOutState, phase: "idle" }) {
  authMock.getSession.mockResolvedValue({ data: { session: createSession() }, error: null });
  const user = userEvent.setup();
  const callbacks = { onSync: vi.fn(), onExport: vi.fn(), onImport: vi.fn() };
  render(<AuthProvider><SyncPanel syncState={syncState} {...callbacks} /></AuthProvider>);
  await user.click(await screen.findByRole("button", { name: "同步与账户" }));
  return { user, callbacks };
}

describe("SyncPanel: entry and local validation", () => {
  it("shows password length guidance only on the registration form", async () => {
    const { user } = await openAuth("登录");
    expect(screen.queryByText("至少 6 个字符")).toBeNull();
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(screen.getByText("至少 6 个字符")).toBeTruthy();
  });

  it("keeps login, registration, export and import available to guests", async () => {
    const { user, callbacks } = await renderPanel();
    expect(screen.getByText("数据仅保存在本地")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "导出数据" }));
    await user.click(screen.getByRole("button", { name: "导入数据" }));
    expect(callbacks.onExport).toHaveBeenCalledTimes(1);
    expect(callbacks.onImport).toHaveBeenCalledTimes(1);
    expect(authMock.signUp).not.toHaveBeenCalled();
  });

  it("shows loading instead of authentication forms while restoring a session", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.getSession>>>();
    authMock.getSession.mockReturnValue(pending.promise);
    render(<AuthProvider><SyncPanel syncState={signedOutState} onSync={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} /></AuthProvider>);
    fireEvent.click(screen.getByRole("button", { name: "登录与数据同步" }));
    expect(screen.getByText("正在读取登录状态…")).toBeTruthy();
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    await act(async () => pending.resolve({ data: { session: null }, error: null }));
    expect(screen.getByRole("button", { name: "注册" })).toBeTruthy();
  });

  it.each([
    ["empty email", { email: "" }],
    ["empty password", { password: "", confirmation: "" }],
    ["password shorter than six characters", { password: "12345" }],
    ["empty password confirmation", { confirmation: "" }],
    ["whitespace-only email", { email: "   " }],
  ] as const)("does not submit with %s", async (_label, values) => {
    const { user } = await openAuth();
    await fillRegistration(user, values);
    const button = screen.getByRole("button", { name: "创建账户" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(authMock.signUp).not.toHaveBeenCalled();
  });

  it.each(["not-an-email", "preview@", "@example.com"])(
    "uses native email validation for %s", async (email) => {
      const { user } = await openAuth();
      await fillRegistration(user, { email });
      const input = screen.getByLabelText("邮箱") as HTMLInputElement;
      expect(input.validity.typeMismatch).toBe(true);
      await user.click(screen.getByRole("button", { name: "创建账户" }));
      expect(authMock.signUp).not.toHaveBeenCalled();
      expect(screen.queryByText(confirmationMessage)).toBeNull();
    },
  );

  it("accepts the six-character boundary and preserves plus-address aliases", async () => {
    const { user } = await openAuth();
    await fillRegistration(user, { password: "123456" });
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    expect(authMock.signUp).toHaveBeenCalledWith({
      email: "preview+test1@example.com", password: "123456",
      options: { emailRedirectTo: "http://127.0.0.1:5173" },
    });
  });

  it("trims surrounding email whitespace without altering the password", async () => {
    const { user } = await openAuth();
    await fillRegistration(user, { email: " preview@example.com ", password: " pass word " });
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    expect(authMock.signUp.mock.calls[0][0]).toMatchObject({
      email: "preview@example.com", password: " pass word ",
    });
  });

  it("shows a mismatch on blur and focuses confirmation if submission is attempted", async () => {
    const { user } = await openAuth();
    await fillRegistration(user, { confirmation: "different-password" });
    await user.tab();
    expect(screen.getByRole("alert").textContent).toBe("两次输入的密码不一致，请再确认一下。");
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    expect(document.activeElement).toBe(screen.getByLabelText("确认密码"));
    expect(screen.getByLabelText("确认密码").getAttribute("aria-invalid")).toBe("true");
    expect(authMock.signUp).not.toHaveBeenCalled();
  });

  it("clears mismatch feedback as soon as the passwords agree", async () => {
    const { user } = await openAuth();
    await fillRegistration(user, { confirmation: "wrong-password" });
    await user.tab();
    await user.clear(screen.getByLabelText("确认密码"));
    await user.type(screen.getByLabelText("确认密码"), "password123");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("确认密码").getAttribute("aria-invalid")).toBeNull();
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
  });

  it("rechecks mismatch if the original password changes after confirmation", async () => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.tab();
    await user.type(screen.getByLabelText("密码", { exact: true }), "changed");
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    expect(authMock.signUp).not.toHaveBeenCalled();
  });
});

describe("SyncPanel: registration success and request lifecycle", () => {
  it("replaces the entire successful signup form with only the green confirmation notice", async () => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    const message = await screen.findByText(confirmationMessage);
    const dialog = screen.getByRole("dialog", { name: "同步与账户" });
    expect(message.classList.contains("is-success")).toBe(true);
    expect(message.getAttribute("role")).toBe("status");
    expect(dialog.querySelectorAll("input, form, button")).toHaveLength(0);
    expect(dialog.textContent).toBe(confirmationMessage);
    expect(screen.getByRole("button", { name: "登录与数据同步" })).toBeTruthy();
  });

  it("also submits registration using Enter", async () => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.keyboard("{Enter}");
    await screen.findByText(confirmationMessage);
    expect(authMock.signUp).toHaveBeenCalledTimes(1);
  });

  it("disables submission and suppresses a double click while signup is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.signUp>>>();
    authMock.signUp.mockReturnValue(pending.promise);
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.dblClick(screen.getByRole("button", { name: "创建账户" }));
    const button = screen.getByRole("button", { name: "请稍候…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(authMock.signUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(confirmationMessage)).toBeNull();
    await act(async () => pending.resolve({ data: { user: createUser(), session: null }, error: null }));
    expect(screen.getByText(confirmationMessage)).toBeTruthy();
  });

  it("returns to account entry after closing and reopening confirmation", async () => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    await user.click(screen.getByRole("button", { name: "登录与数据同步" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "登录与数据同步" }));
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    expect(screen.queryByText(confirmationMessage)).toBeNull();
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect((screen.getByLabelText("密码", { exact: true }) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("确认密码") as HTMLInputElement).value).toBe("");
  });

  it.each(["Escape", "outside click"] as const)("closes confirmation via %s", async (method) => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("enters the signed-in view if signup returns an immediate session", async () => {
    authMock.signUp.mockImplementation(async () => {
      const session = createSession();
      emitAuthEvent("SIGNED_IN", session);
      return { data: { user: session.user, session }, error: null };
    });
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByRole("button", { name: "退出登录" });
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    expect(screen.queryByText(confirmationMessage)).toBeNull();
  });

  it("reflects a successful email-confirmation session event while the notice is open", async () => {
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    act(() => emitAuthEvent("SIGNED_IN", createSession()));
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(screen.queryByText(confirmationMessage)).toBeNull();
  });

  it("does not replace a newly opened login form when an older signup finishes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.signUp>>>();
    authMock.signUp.mockReturnValue(pending.promise);
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await user.click(screen.getByRole("button", { name: "登录" }));
    await act(async () => pending.resolve({ data: { user: createUser(), session: null }, error: null }));
    expect(screen.queryByText(confirmationMessage)).toBeNull();
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
  });

  it("does not leave account entry when an abandoned signup finishes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.signUp>>>();
    authMock.signUp.mockReturnValue(pending.promise);
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await act(async () => pending.resolve({ data: { user: createUser(), session: null }, error: null }));
    expect(screen.getByText("数据仅保存在本地")).toBeTruthy();
    expect(screen.queryByText(confirmationMessage)).toBeNull();
  });

  it("does not let an old signup failure show in or unlock a newer pending login", async () => {
    const pendingSignup = deferred<Awaited<ReturnType<typeof authMock.signUp>>>();
    const pendingLogin = deferred<Awaited<ReturnType<typeof authMock.signInWithPassword>>>();
    authMock.signUp.mockReturnValue(pendingSignup.promise);
    authMock.signInWithPassword.mockReturnValue(pendingLogin.promise);
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await user.click(screen.getByRole("button", { name: "登录" }));
    await user.type(screen.getByLabelText("密码", { exact: true }), "password123");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await act(async () => pendingSignup.resolve({ data: { user: null, session: null }, error: new Error("email rate limit exceeded") }));
    expect(screen.queryByText("邮件发送得太频繁，请稍后再试。")).toBeNull();
    expect((screen.getByRole("button", { name: "请稍候…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pendingLogin.resolve({ data: { user: null, session: null }, error: new Error("Invalid login credentials") }));
    expect(screen.getByText("邮箱或密码不正确。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SyncPanel: server failures and recovery", () => {
  it.each([
    ["User already registered", "这个邮箱已经注册过了。"],
    ["email rate limit exceeded", "邮件发送得太频繁，请稍后再试。"],
    ["Password should be at least 8 characters.", "密码至少需要 6 个字符。"],
    ["Error sending confirmation email", "Error sending confirmation email"],
    ["For security purposes, you can only request this after 60 seconds.", "For security purposes, you can only request this after 60 seconds."],
    ["Signup is disabled", "Signup is disabled"],
    ["Email address is invalid", "Email address is invalid"],
    ["Failed to fetch", "Failed to fetch"],
  ])("keeps the editable form and displays signup failure: %s", async (serverMessage, displayedMessage) => {
    authMock.signUp.mockResolvedValue({ data: { user: null, session: null }, error: new Error(serverMessage) });
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    const message = await screen.findByText(displayedMessage);
    expect(message.classList.contains("is-success")).toBe(false);
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
    expect(screen.getByLabelText("确认密码")).toBeTruthy();
    expect((screen.getByRole("button", { name: "创建账户" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(confirmationMessage)).toBeNull();
  });

  it("shows a safe generic message for non-Error failures", async () => {
    authMock.signUp.mockRejectedValue({ status: 500 });
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText("操作失败，请稍后重试。");
    expect(screen.queryByText(confirmationMessage)).toBeNull();
  });

  it("allows retry after a network failure and clears the obsolete error on success", async () => {
    authMock.signUp.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText("Failed to fetch");
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(confirmationMessage);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    expect(authMock.signUp).toHaveBeenCalledTimes(2);
  });

  it("renders unexpected server text literally rather than as HTML", async () => {
    const unsafeMessage = "<img src=x onerror=alert(1)>";
    authMock.signUp.mockRejectedValue(new Error(unsafeMessage));
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText(unsafeMessage);
    expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
  });

  it("clears registration secrets, validation and errors when switching to login", async () => {
    authMock.signUp.mockRejectedValue(new Error("email rate limit exceeded"));
    const { user } = await openAuth();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await screen.findByText("邮件发送得太频繁，请稍后再试。");
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect((screen.getByLabelText("密码", { exact: true }) as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("确认密码")).toBeNull();
    expect(screen.queryByText("邮件发送得太频繁，请稍后再试。")).toBeNull();
  });
});

describe("SyncPanel: login, signout and sync state", () => {
  it("suppresses duplicate login requests and restores the button after failure", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.signInWithPassword>>>();
    authMock.signInWithPassword.mockReturnValue(pending.promise);
    const { user } = await openAuth("登录");
    await user.type(screen.getByLabelText("邮箱"), "preview@example.com");
    await user.type(screen.getByLabelText("密码", { exact: true }), "password123");
    await user.dblClick(screen.getByRole("button", { name: "登录" }));
    expect(authMock.signInWithPassword).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "请稍候…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({ data: { user: null, session: null }, error: new Error("Invalid login credentials") }));
    expect(screen.getByText("邮箱或密码不正确。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["Invalid login credentials", "邮箱或密码不正确。"],
    ["Email not confirmed", "Email not confirmed"],
    ["Failed to fetch", "Failed to fetch"],
  ])("keeps login available after %s", async (serverMessage, displayedMessage) => {
    authMock.signInWithPassword.mockRejectedValue(new Error(serverMessage));
    const { user } = await openAuth("登录");
    await user.type(screen.getByLabelText("邮箱"), "preview@example.com");
    await user.type(screen.getByLabelText("密码", { exact: true }), "password123");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "登录" }));
    await screen.findByText(displayedMessage);
    expect(screen.queryByLabelText("确认密码")).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("changes to the cloud account view after successful login", async () => {
    authMock.signInWithPassword.mockImplementation(async () => {
      const session = createSession();
      emitAuthEvent("SIGNED_IN", session);
      return { data: { user: session.user, session }, error: null };
    });
    const { user, callbacks } = await openAuth("登录");
    await user.type(screen.getByLabelText("邮箱"), "preview+test1@example.com");
    await user.type(screen.getByLabelText("密码", { exact: true }), "password123");
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "退出登录" });
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    await user.click(screen.getByRole("button", { name: "立即同步" }));
    expect(callbacks.onSync).toHaveBeenCalledTimes(1);
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: "preview+test1@example.com", password: "password123",
    });
  });

  it("returns to the local-data account entry after successful signout", async () => {
    const { user } = await renderSignedInPanel();
    authMock.signOut.mockImplementation(async () => {
      emitAuthEvent("SIGNED_OUT", null);
      return { error: null };
    });
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "注册" });
    expect(screen.getByText("数据仅保存在本地")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  it("keeps the account view and permits retry if signout fails", async () => {
    const { user } = await renderSignedInPanel();
    authMock.signOut.mockResolvedValue({ error: new Error("Failed to fetch") });
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByText("Failed to fetch");
    expect((screen.getByRole("button", { name: "退出登录" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("preview+auth@example.com")).toBeTruthy();
  });

  it("prevents duplicate signout while the request is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.signOut>>>();
    authMock.signOut.mockReturnValue(pending.promise);
    const { user } = await renderSignedInPanel();
    await user.dblClick(screen.getByRole("button", { name: "退出登录" }));
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "正在退出…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({ error: new Error("Failed to fetch") }));
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  it.each([
    [{ phase: "idle", pendingChanges: 0 }, "尚未进行首次同步"],
    [{ phase: "idle", pendingChanges: 3 }, "3 项等待同步"],
    [{ phase: "idle", pendingChanges: 2, lastSyncedAt: new Date("2026-10-31T06:30:00Z") }, "2 项等待同步"],
    [{ phase: "offline", pendingChanges: 0 }, "当前离线，将在联网后同步"],
    [{ phase: "offline", pendingChanges: 3 }, "当前离线，3 项等待同步"],
    [{ phase: "error", errorMessage: "permission denied" }, "同步失败，点击下方按钮重试"],
    [{ phase: "syncing" }, "正在同步…"],
  ] as const)("renders the %j sync state", async (state, text) => {
    await renderSignedInPanel({ ...signedOutState, ...state });
    expect(screen.getByText(text)).toBeTruthy();
    if (state.phase === "error") expect(screen.getByText("permission denied")).toBeTruthy();
    if (state.phase === "syncing") {
      expect((screen.getByRole("button", { name: "同步中…" }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows the last successful synchronization time", async () => {
    await renderSignedInPanel({ ...signedOutState, phase: "idle", lastSyncedAt: new Date("2026-10-31T06:30:00Z") });
    expect(screen.getByText(/^已同步 · \d{2}:\d{2}$/)).toBeTruthy();
  });
});
