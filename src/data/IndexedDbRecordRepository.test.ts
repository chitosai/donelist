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
    expect(created.highlighted).toBe(false);
    expect(recent).toEqual([created]);
  });

  it("persists a record highlight", async () => {
    const repository = createRepository();
    const record = await repository.create({ content: "月度重点", happenedAt: new Date().toISOString() });

    await repository.update({ ...record, highlighted: true });

    expect((await repository.getRecent(10))[0].highlighted).toBe(true);
  });

  it("queries records by their happened month", async () => {
    const repository = createRepository();
    await repository.create({ content: "七月", happenedAt: new Date(2026, 6, 31, 23).toISOString() });
    await repository.create({ content: "八月", happenedAt: new Date(2026, 7, 1, 9).toISOString() });

    const august = await repository.getByMonth(2026, 7);

    expect(august.map((record) => record.content)).toEqual(["八月"]);
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
  });
});
