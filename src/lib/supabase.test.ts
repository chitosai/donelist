import { afterEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ marker: "test-client" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Supabase client configuration", () => {
  it.each([
    ["", "sb_publishable_test_only"],
    ["https://test-only.supabase.co", ""],
    ["", ""],
  ])("fails clearly before creating a client if configuration is incomplete", async (url, key) => {
    vi.stubEnv("VITE_SUPABASE_URL", url);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", key);
    await expect(import("./supabase")).rejects.toThrow("缺少 Supabase 环境变量，请检查 .env.local。");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("creates the browser client using the configured project URL and publishable key", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://test-only.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_only");
    const { supabase } = await import("./supabase");
    expect(createClient).toHaveBeenCalledWith("https://test-only.supabase.co", "sb_publishable_test_only");
    expect(supabase).toEqual({ marker: "test-client" });
  });
});
