import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbRecordRepository } from "./IndexedDbRecordRepository";

const databases: IndexedDbRecordRepository[] = [];

function createRepository() {
  const repository = new IndexedDbRecordRepository(`done-list-test-${crypto.randomUUID()}`);
  databases.push(repository);
  return repository;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((repository) => repository.db.delete()));
});

describe("IndexedDbRecordRepository", () => {
  it("creates a record and returns it in the recent list", async () => {
    const repository = createRepository();
    const happenedAt = new Date("2026-08-11T10:00:00+08:00").toISOString();

    const created = await repository.create({ content: "  完成 v1 设计  ", happenedAt });
    const recent = await repository.getRecent(10);

    expect(created.content).toBe("完成 v1 设计");
    expect(created.isHighlighted).toBe(false);
    expect(recent).toEqual([created]);
  });

  it("persists a record highlight", async () => {
    const repository = createRepository();
    const record = await repository.create({ content: "月度重点", happenedAt: new Date().toISOString() });

    await repository.update({ ...record, isHighlighted: true });

    expect((await repository.getRecent(10))[0].isHighlighted).toBe(true);
  });

  it("queries records by their happened month", async () => {
    const repository = createRepository();
    await repository.create({ content: "七月", happenedAt: new Date(2026, 6, 31, 23).toISOString() });
    await repository.create({ content: "八月", happenedAt: new Date(2026, 7, 1, 9).toISOString() });

    const august = await repository.getByMonth(2026, 7);

    expect(august.map((record) => record.content)).toEqual(["八月"]);
  });

  it("queries records across month boundaries within a date range", async () => {
    const repository = createRepository();
    await repository.create({ content: "范围之前", happenedAt: new Date(2026, 7, 30, 23).toISOString() });
    await repository.create({ content: "八月末", happenedAt: new Date(2026, 7, 31, 9).toISOString() });
    await repository.create({ content: "九月初", happenedAt: new Date(2026, 8, 1, 9).toISOString() });
    await repository.create({ content: "范围之后", happenedAt: new Date(2026, 8, 7, 0).toISOString() });

    const visible = await repository.getByRange(
      new Date(2026, 7, 31),
      new Date(2026, 8, 7),
    );

    expect(visible.map((record) => record.content)).toEqual(["八月末", "九月初"]);
  });

  it("round-trips records through a versioned backup", async () => {
    const source = createRepository();
    await source.create({ content: "备份我", happenedAt: new Date().toISOString() });
    const backup = await source.exportBackup();

    const target = createRepository();
    const count = await target.importBackup(backup);

    expect(count).toBe(1);
    expect((await target.getRecent(10))[0].content).toBe("备份我");
  });

  it("deletes a record", async () => {
    const repository = createRepository();
    const record = await repository.create({ content: "删除我", happenedAt: new Date().toISOString() });

    await repository.delete(record.id);

    expect(await repository.getRecent(10)).toEqual([]);
    expect((await repository.getAllForSync())[0].deletedAt).not.toBeNull();
  });

  it("claims guest records for a signed-in user and keeps scopes separate", async () => {
    const repository = createRepository();
    await repository.create({ content: "登录前记录", happenedAt: new Date().toISOString() });

    expect(await repository.claimGuestRecords("user-a")).toBe(1);
    repository.setUserScope("user-a");
    expect((await repository.getRecent(10)).map((record) => record.content)).toEqual(["登录前记录"]);

    repository.setGuestScope();
    expect(await repository.getRecent(10)).toEqual([]);
  });

  it("keeps the newest version while merging cloud records", async () => {
    const repository = createRepository();
    repository.setUserScope("user-a");
    const local = await repository.create({ content: "本地新版", happenedAt: new Date().toISOString() });

    await repository.mergeFromSync([{
      ...local,
      content: "云端旧版",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      deletedAt: null,
    }]);
    expect((await repository.getRecent(10))[0].content).toBe("本地新版");

    await repository.mergeFromSync([{
      ...local,
      content: "云端新版",
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      deletedAt: null,
    }]);
    expect((await repository.getRecent(10))[0].content).toBe("云端新版");
  });
});
