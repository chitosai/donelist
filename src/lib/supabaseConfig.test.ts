import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadEnv } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseConfig } from "./supabaseConfig";

const temporaryRoot = resolve(tmpdir());
let environmentDirectory: string;
const developmentEnv = "VITE_SUPABASE_URL=https://dev-test.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_dev_test\n";
const productionEnv = "VITE_SUPABASE_URL=https://prod-test.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_prod_test\n";

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", undefined);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", undefined);
  environmentDirectory = mkdtempSync(join(temporaryRoot, "donelist-env-test-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  const target = resolve(environmentDirectory);
  if (!target.startsWith(`${temporaryRoot}${sep}donelist-env-test-`)) {
    throw new Error("Refusing to remove a path outside the test's temporary directory.");
  }
  rmSync(target, { recursive: true, force: true });
});

describe("Supabase environment separation", () => {
  it("loads only the development project for the development mode", () => {
    writeFileSync(join(environmentDirectory, ".env.development.local"), developmentEnv);
    writeFileSync(join(environmentDirectory, ".env.production.local"), productionEnv);
    expect(getSupabaseConfig(loadEnv("development", environmentDirectory, "VITE_")))
      .toEqual({ url: "https://dev-test.supabase.co", publishableKey: "sb_publishable_dev_test" });
  });

  it("loads only the production project for the production mode", () => {
    writeFileSync(join(environmentDirectory, ".env.development.local"), developmentEnv);
    writeFileSync(join(environmentDirectory, ".env.production.local"), productionEnv);
    expect(getSupabaseConfig(loadEnv("production", environmentDirectory, "VITE_")))
      .toEqual({ url: "https://prod-test.supabase.co", publishableKey: "sb_publishable_prod_test" });
  });

  it("fails instead of falling back to development when production is unconfigured", () => {
    writeFileSync(join(environmentDirectory, ".env.development.local"), developmentEnv);
    expect(() => getSupabaseConfig(loadEnv("production", environmentDirectory, "VITE_")))
      .toThrow("缺少 Supabase 环境变量");
  });

  it("fails instead of falling back to production when development is unconfigured", () => {
    writeFileSync(join(environmentDirectory, ".env.production.local"), productionEnv);
    expect(() => getSupabaseConfig(loadEnv("development", environmentDirectory, "VITE_")))
      .toThrow("缺少 Supabase 环境变量");
  });

  it("lets Vercel Preview's explicit variables override production-mode local files", () => {
    writeFileSync(join(environmentDirectory, ".env.production.local"), productionEnv);
    vi.stubEnv("VITE_SUPABASE_URL", "https://preview-test.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_preview_test");
    expect(getSupabaseConfig(loadEnv("production", environmentDirectory, "VITE_")))
      .toEqual({ url: "https://preview-test.supabase.co", publishableKey: "sb_publishable_preview_test" });
  });

  it("takes mode-specific settings over shared local values", () => {
    writeFileSync(join(environmentDirectory, ".env.local"), productionEnv);
    writeFileSync(join(environmentDirectory, ".env.development.local"), developmentEnv);
    expect(getSupabaseConfig(loadEnv("development", environmentDirectory, "VITE_"))).toEqual({
      url: "https://dev-test.supabase.co", publishableKey: "sb_publishable_dev_test",
    });
  });

  it.each([
    { VITE_SUPABASE_URL: "   ", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" },
    { VITE_SUPABASE_URL: "https://test.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "   " },
  ])("rejects a whitespace-only required value", (environment) => {
    expect(() => getSupabaseConfig(environment)).toThrow("缺少 Supabase 环境变量");
  });

  it("trims accidental surrounding whitespace from deployment settings", () => {
    expect(getSupabaseConfig({
      VITE_SUPABASE_URL: " https://test.supabase.co ",
      VITE_SUPABASE_PUBLISHABLE_KEY: " sb_publishable_test ",
    })).toEqual({ url: "https://test.supabase.co", publishableKey: "sb_publishable_test" });
  });
});
