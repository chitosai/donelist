import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const accountA = "00000000-0000-4000-8000-000000000001";
const accountB = "00000000-0000-4000-8000-000000000002";
const recordId = "10000000-0000-4000-8000-000000000001";
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to anon, authenticated;
    insert into auth.users (id) values ('${accountA}'), ('${accountB}');
  `);
}, 20_000);
afterEach(async () => { await db.close(); });

async function asAccount(userId = accountA, role = "authenticated") {
  await db.exec(`set role ${role}; set request.jwt.claim.sub = '${userId}';`);
}
async function insertRecord(userId = accountA, id = recordId, version?: string) {
  await db.query(`insert into public.records
    (id, user_id, content, happened_at, created_at, updated_at${version ? ", sync_version" : ""})
    values ($1, $2, '测试事项', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'${version ? ", $3" : ""})`,
  version ? [id, userId, version] : [id, userId]);
}
async function latestVersion(userId = accountA) {
  return (await db.query<{ version: string }>("select public.get_latest_sync_version($1) as version", [userId])).rows[0].version;
}

describe("incremental-download database schema", () => {
  it("starts an empty account at zero and versions inserts, highlights, edits and deletion markers", async () => {
    await db.exec(schema);
    await asAccount();
    expect(await latestVersion()).toBe("0");
    await insertRecord();
    expect(await latestVersion()).toBe("1");
    await db.query("update public.records set is_highlighted = true where id = $1", [recordId]);
    expect(await latestVersion()).toBe("2");
    await db.query("update public.records set content = '修改内容' where id = $1", [recordId]);
    await db.query("update public.records set deleted_at = now() where id = $1", [recordId]);
    expect(await latestVersion()).toBe("4");
    const result = await db.query<{ version: string; content: string; is_deleted: boolean }>("select sync_version::text as version, content, deleted_at is not null as is_deleted from public.records");
    expect(result.rows).toEqual([{ version: "4", content: "修改内容", is_deleted: true }]);
  });

  it("keeps counters independent and enforces row-level access for both records and sync state", async () => {
    await db.exec(schema);
    await insertRecord();
    await insertRecord(accountB, "10000000-0000-4000-8000-000000000002");
    await asAccount(accountB);
    expect(await latestVersion(accountB)).toBe("1");
    expect((await db.query("select id from public.records")).rows).toHaveLength(1);
    expect((await db.query("select user_id from public.record_sync_state")).rows).toEqual([{ user_id: accountB }]);
    await expect(latestVersion(accountA)).rejects.toThrow("does not match");
  });

  it("does not let callers forge row versions, change the counter, move ownership or physically delete records", async () => {
    await db.exec(schema);
    await asAccount();
    await insertRecord(accountA, recordId, "9999999");
    expect(await latestVersion()).toBe("1");
    await db.query("update public.records set sync_version = 9999999 where id = $1", [recordId]);
    expect(await latestVersion()).toBe("2");
    await expect(db.query("update public.record_sync_state set latest_version = 9999999")).rejects.toThrow("permission denied");
    await expect(db.query("update public.records set user_id = $1 where id = $2", [accountB, recordId])).rejects.toThrow("cannot be moved");
    await expect(db.query("delete from public.records where id = $1", [recordId])).rejects.toThrow("permission denied");
    expect((await db.query("select id from public.records")).rows).toHaveLength(1);
  });

  it("does not grant guests access to the RPC or the tables", async () => {
    await db.exec(schema);
    await asAccount(accountA, "anon");
    await expect(latestVersion()).rejects.toThrow("permission denied");
    await expect(db.query("select * from public.record_sync_state")).rejects.toThrow("permission denied");
    await expect(db.query("select * from public.records")).rejects.toThrow("permission denied");
    await expect(db.query("select * from public.get_record_diffs($1, 0, 1, 500)", [accountA])).rejects.toThrow("permission denied");
  });

  it("checks the authenticated account even on empty pages and rejects invalid page sizes", async () => {
    await db.exec(schema);
    await asAccount(accountB);
    await expect(db.query("select * from public.get_record_diffs($1, 0, 1, 500)", [accountA])).rejects.toThrow("does not match");
    expect((await db.query("select * from public.get_record_diffs($1, 0, 1, 500)", [accountB])).rows).toHaveLength(0);
    await expect(db.query("select * from public.get_record_diffs($1, 0, 1, 501)", [accountB])).rejects.toThrow("Invalid sync page");
  });

  it("returns up to 500 version-ordered rows per request within the requested window", async () => {
    await db.exec(schema);
    await db.query(`insert into public.records (id,user_id,content,happened_at,created_at,updated_at)
      select gen_random_uuid(), $1, '事项 ' || number, now(), now(), now() from generate_series(1, 1001) as number`, [accountA]);
    await asAccount();
    const page = (await db.query<{ version: string }>("select sync_version::text as version from public.get_record_diffs($1, 0, 1000, 500)", [accountA])).rows;
    expect(page).toHaveLength(500);
    expect(page[0].version).toBe("1");
    expect(page[499].version).toBe("500");
    const next = (await db.query<{ version: string }>("select sync_version::text as version from public.get_record_diffs($1, 500, 1000, 500)", [accountA])).rows;
    expect(next).toHaveLength(500);
    expect(next[499].version).toBe("1000");
    expect((await db.query("select * from public.get_record_diffs($1, 1000, 1000, 500)", [accountA])).rows).toHaveLength(0);
  });

  it("rolls back the version counter when a record transaction fails or is rolled back", async () => {
    await db.exec(schema);
    await asAccount();
    await db.exec("begin;");
    await insertRecord();
    expect(await latestVersion()).toBe("1");
    await db.exec("rollback;");
    expect(await latestVersion()).toBe("0");
    await expect(db.query(`insert into public.records (id,user_id,content,happened_at,created_at,updated_at)
      values ($1,$2,'',now(),now(),now())`, [recordId, accountA])).rejects.toThrow();
    expect(await latestVersion()).toBe("0");
    await insertRecord();
    expect(await latestVersion()).toBe("1");
  });

  it("supports the existing upsert upload API without uploading sync_version", async () => {
    await db.exec(schema);
    await asAccount();
    await insertRecord();
    await db.query(`insert into public.records (id,user_id,content,happened_at,created_at,updated_at)
      values ($1,$2,'直接上传更新',now(),now(),now())
      on conflict (id) do update set content = excluded.content, updated_at = excluded.updated_at`, [recordId, accountA]);
    const rows = (await db.query<{ content: string; version: string }>("select content, sync_version::text as version from public.records")).rows;
    expect(rows[0].content).toBe("直接上传更新");
    expect(BigInt(rows[0].version)).toBeGreaterThan(1n);
    expect(rows[0].version).toBe(await latestVersion());
  });

  it("keeps versions exact beyond JavaScript's safe integer range", async () => {
    await db.exec(schema);
    await db.query("insert into public.record_sync_state (user_id, latest_version) values ($1, 9007199254740992)", [accountA]);
    await asAccount();
    await insertRecord();
    expect(await latestVersion()).toBe("9007199254740993");
    expect((await db.query<{ version: string }>("select sync_version::text as version from public.records")).rows[0].version).toBe("9007199254740993");
  });
});
