import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { vi } from "vitest";

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
type Credentials = { email: string; password: string };
type AuthResponse = {
  data: { user: User | null; session: Session | null };
  error: Error | null;
};
type SessionResponse = { data: { session: Session | null }; error: Error | null };

const listeners = new Set<AuthListener>();

// Deliberately replaces the entire SDK module in tests: no real requests or email.
export const authMock = {
  getSession: vi.fn<() => Promise<SessionResponse>>(),
  onAuthStateChange: vi.fn<(listener: AuthListener) => {
    data: { subscription: { unsubscribe: () => void } };
  }>(),
  signUp: vi.fn<(credentials: Credentials & {
    options: { emailRedirectTo: string };
  }) => Promise<AuthResponse>>(),
  signInWithPassword: vi.fn<(credentials: Credentials) => Promise<AuthResponse>>(),
  signOut: vi.fn<() => Promise<{ error: Error | null }>>(),
  unsubscribe: vi.fn(),
};

export function createUser(id = "test-user", email = "preview+auth@example.com"): User {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-10-31T00:00:00.000Z",
  };
}

export function createSession(user = createUser()): Session {
  return {
    user,
    access_token: "fake-access-token-for-tests-only",
    refresh_token: "fake-refresh-token-for-tests-only",
    expires_in: 3600,
    token_type: "bearer",
  };
}

export function resetAuthMock() {
  vi.resetAllMocks();
  listeners.clear();
  authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  authMock.signUp.mockResolvedValue({ data: { user: createUser(), session: null }, error: null });
  authMock.signInWithPassword.mockResolvedValue({
    data: { user: createUser(), session: createSession() }, error: null,
  });
  authMock.signOut.mockResolvedValue({ error: null });
  authMock.onAuthStateChange.mockImplementation((listener) => {
    listeners.add(listener);
    return {
      data: {
        subscription: {
          unsubscribe() {
            listeners.delete(listener);
            authMock.unsubscribe();
          },
        },
      },
    };
  });
}

export function emitAuthEvent(event: AuthChangeEvent, session: Session | null) {
  listeners.forEach((listener) => listener(event, session));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
