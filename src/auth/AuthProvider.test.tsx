// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMock, createSession, createUser, deferred, emitAuthEvent, resetAuthMock,
} from "../test/authTestUtils";
import { AuthProvider, useAuth } from "./AuthProvider";

vi.mock("../lib/supabase", async () => {
  const { authMock: auth } = await import("../test/authTestUtils");
  return { supabase: { auth } };
});

beforeEach(resetAuthMock);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderReadyAuth() {
  const hook = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(hook.result.current.isAuthReady).toBe(true));
  return hook;
}

describe("AuthProvider: initial session and auth events", () => {
  it("stays loading until the initial session has been read", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.getSession>>>();
    authMock.getSession.mockReturnValue(pending.promise);
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    expect(result.current.isAuthReady).toBe(false);
    await act(async () => pending.resolve({ data: { session: null }, error: null }));
    expect(result.current.isAuthReady).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it("opens in guest mode when there is no stored session", async () => {
    const { result } = await renderReadyAuth();
    expect(result.current.user).toBeNull();
  });

  it("restores the SDK-provided stored session after a refresh", async () => {
    const session = createSession();
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });
    const { result } = await renderReadyAuth();
    expect(result.current.user).toEqual(session.user);
  });

  it("falls back to usable guest mode if session restoration returns an error", async () => {
    const error = new Error("Invalid Refresh Token: Refresh Token Not Found");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    authMock.getSession.mockResolvedValue({ data: { session: null }, error });
    const { result } = await renderReadyAuth();
    expect(result.current.user).toBeNull();
    expect(log).toHaveBeenCalledWith("读取登录状态失败", error);
  });

  it.each(["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"] as const)(
    "reflects the user from the %s event", async (event) => {
      const { result } = await renderReadyAuth();
      const session = createSession(createUser("next-user", "next@example.com"));
      act(() => emitAuthEvent(event, session));
      expect(result.current.user).toEqual(session.user);
    },
  );

  it("returns to guest mode on SIGNED_OUT (including another tab)", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: createSession() }, error: null });
    const { result } = await renderReadyAuth();
    act(() => emitAuthEvent("SIGNED_OUT", null));
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthReady).toBe(true);
  });

  it("unsubscribes when unmounted", async () => {
    const { unmount } = await renderReadyAuth();
    unmount();
    expect(authMock.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores an initial session result after unmounting", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.getSession>>>();
    authMock.getSession.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(useAuth, { wrapper: AuthProvider });
    unmount();
    await act(async () => pending.resolve({ data: { session: createSession() }, error: null }));
    expect(result.current.isAuthReady).toBe(false);
    expect(authMock.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("survives React StrictMode effect cleanup and remount", async () => {
    const { result, unmount } = renderHook(useAuth, { wrapper: AuthProvider, reactStrictMode: true });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    act(() => emitAuthEvent("SIGNED_IN", createSession()));
    expect(result.current.user?.id).toBe("test-user");
    expect(authMock.unsubscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(authMock.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("rejects useAuth outside its provider", () => {
    expect(() => renderHook(useAuth)).toThrow("useAuth 必须在 AuthProvider 内使用。");
  });

  it("does not overwrite a newer sign-in with a stale initial guest session", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.getSession>>>();
    authMock.getSession.mockReturnValue(pending.promise);
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    const session = createSession();
    act(() => emitAuthEvent("SIGNED_IN", session));
    await act(async () => pending.resolve({ data: { session: null }, error: null }));
    expect(result.current.user).toEqual(session.user);
  });

  it("does not restore a stale user after a newer sign-out event", async () => {
    const pending = deferred<Awaited<ReturnType<typeof authMock.getSession>>>();
    authMock.getSession.mockReturnValue(pending.promise);
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    act(() => emitAuthEvent("SIGNED_OUT", null));
    await act(async () => pending.resolve({ data: { session: createSession() }, error: null }));
    expect(result.current.user).toBeNull();
  });
});

describe("AuthProvider: SDK contracts", () => {
  it("requests signup confirmation at the current origin and keeps plus aliases intact", async () => {
    const { result } = await renderReadyAuth();
    const response = await result.current.signUp("preview+test1@example.com", " pass word ");
    expect(authMock.signUp).toHaveBeenCalledWith({
      email: "preview+test1@example.com",
      password: " pass word ",
      options: { emailRedirectTo: "http://127.0.0.1:5173" },
    });
    expect(response).toEqual({ isEmailConfirmationRequired: true });
    expect(result.current.user).toBeNull();
  });

  it("does not request email confirmation if signup immediately returns a session", async () => {
    const session = createSession();
    authMock.signUp.mockResolvedValue({ data: { user: session.user, session }, error: null });
    const { result } = await renderReadyAuth();
    await expect(result.current.signUp("preview@example.com", "password123"))
      .resolves.toEqual({ isEmailConfirmationRequired: false });
  });

  it("does not infer a logged-in user from an obfuscated duplicate-signup response", async () => {
    authMock.signUp.mockResolvedValue({
      data: { user: { ...createUser(), identities: [] }, session: null }, error: null,
    });
    const { result } = await renderReadyAuth();
    await expect(result.current.signUp("preview@example.com", "password123"))
      .resolves.toEqual({ isEmailConfirmationRequired: true });
    expect(result.current.user).toBeNull();
  });

  it("passes through signup errors without creating an authenticated state", async () => {
    const error = new Error("User already registered");
    authMock.signUp.mockResolvedValue({ data: { user: null, session: null }, error });
    const { result } = await renderReadyAuth();
    await expect(result.current.signUp("preview@example.com", "password123")).rejects.toBe(error);
    expect(result.current.user).toBeNull();
  });

  it("forwards login credentials and waits for the authenticated session event", async () => {
    const { result } = await renderReadyAuth();
    await result.current.signIn("preview@example.com", "password123");
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: "preview@example.com", password: "password123",
    });
    expect(result.current.user).toBeNull();
    act(() => emitAuthEvent("SIGNED_IN", createSession()));
    expect(result.current.user?.id).toBe("test-user");
  });

  it("passes through incorrect-password and unconfirmed-email login errors", async () => {
    const error = new Error("Email not confirmed");
    authMock.signInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error });
    const { result } = await renderReadyAuth();
    await expect(result.current.signIn("preview@example.com", "password123")).rejects.toBe(error);
    expect(result.current.user).toBeNull();
  });

  it("forwards signout and clears the user on the SDK event", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: createSession() }, error: null });
    const { result } = await renderReadyAuth();
    await result.current.signOut();
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    act(() => emitAuthEvent("SIGNED_OUT", null));
    expect(result.current.user).toBeNull();
  });

  it("keeps the current user when signout fails", async () => {
    const session = createSession();
    const error = new Error("Failed to fetch");
    authMock.getSession.mockResolvedValue({ data: { session }, error: null });
    authMock.signOut.mockResolvedValue({ error });
    const { result } = await renderReadyAuth();
    await expect(result.current.signOut()).rejects.toBe(error);
    expect(result.current.user).toEqual(session.user);
  });
});
