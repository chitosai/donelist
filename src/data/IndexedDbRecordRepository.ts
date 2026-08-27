import Dexie, { type EntityTable } from "dexie";
import type { DoneRecord, NewDoneRecord, RecordBackup } from "../domain/DoneRecord";
import type { RecordRepository } from "./RecordRepository";

class DoneListDatabase extends Dexie {
  records!: EntityTable<DoneRecord, "id">;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({
      records: "&id, happenedAt, createdAt, updatedAt",
    });
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function monthRange(year: number, month: number): [string, string] {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  return [start.toISOString(), end.toISOString()];
}

export class IndexedDbRecordRepository implements RecordRepository {
  readonly db: DoneListDatabase;

  constructor(databaseName = "done-list") {
    this.db = new DoneListDatabase(databaseName);
  }

  async create(input: NewDoneRecord): Promise<DoneRecord> {
    const now = new Date().toISOString();
    const record: DoneRecord = {
      id: createId(),
      content: input.content.trim(),
      happenedAt: input.happenedAt,
      createdAt: now,
      updatedAt: now,
      highlighted: false,
    };

    await this.db.records.add(record);
    return record;
  }

  async update(record: DoneRecord): Promise<void> {
    await this.db.records.put({
      ...record,
      content: record.content.trim(),
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.records.delete(id);
  }

  async getRecent(limit: number): Promise<DoneRecord[]> {
    return this.db.records.orderBy("createdAt").reverse().limit(limit).toArray();
  }

  async getByMonth(year: number, month: number): Promise<DoneRecord[]> {
    const [start, end] = monthRange(year, month);
    return this.db.records
      .where("happenedAt")
      .between(start, end, true, false)
      .sortBy("happenedAt");
  }

  async exportBackup(): Promise<RecordBackup> {
    return {
      format: "done-list-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      records: await this.db.records.toArray(),
    };
  }

  async importBackup(backup: RecordBackup): Promise<number> {
    if (backup.format !== "done-list-backup" || backup.version !== 1 || !Array.isArray(backup.records)) {
      throw new Error("这不是有效的 Done List v1 备份文件。");
    }

    const records = backup.records.filter(
      (record) =>
        record &&
        typeof record.id === "string" &&
        typeof record.content === "string" &&
        typeof record.happenedAt === "string" &&
        typeof record.createdAt === "string" &&
        typeof record.updatedAt === "string" &&
        (record.highlighted === undefined || typeof record.highlighted === "boolean"),
    );

    await this.db.records.bulkPut(records);
    return records.length;
  }
}
