import Dexie, { type EntityTable } from "dexie";
import type { DoneRecord, NewDoneRecord, RecordBackup } from "../domain/DoneRecord";
import type { RecordRepository } from "./RecordRepository";

const GUEST_SCOPE_ID = "guest";

export type SyncableDoneRecord = DoneRecord & {
  deletedAt: string | null;
};

type StoredDoneRecord = SyncableDoneRecord & {
  scopeId: string;
};

class DoneListDatabase extends Dexie {
  records!: EntityTable<StoredDoneRecord, "id">;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({
      records: "&id, happenedAt, createdAt, updatedAt",
    });
    this.version(2).stores({
      records: "&id, scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]",
    }).upgrade((transaction) => transaction.table("records").toCollection().modify((record) => {
      record.scopeId = record.scopeId ?? GUEST_SCOPE_ID;
      record.deletedAt = record.deletedAt ?? null;
    }));
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class IndexedDbRecordRepository implements RecordRepository {
  readonly db: DoneListDatabase;
  private scopeId = GUEST_SCOPE_ID;

  constructor(databaseName = "done-list") {
    this.db = new DoneListDatabase(databaseName);
  }

  setGuestScope(): void {
    this.scopeId = GUEST_SCOPE_ID;
  }

  setUserScope(userId: string): void {
    this.scopeId = `user:${userId}`;
  }

  async claimGuestRecords(userId: string): Promise<number> {
    const userScopeId = `user:${userId}`;
    const guestRecords = await this.db.records.where("scopeId").equals(GUEST_SCOPE_ID).toArray();
    if (!guestRecords.length) return 0;

    await this.db.transaction("rw", this.db.records, async () => {
      await this.db.records.bulkPut(
        guestRecords.map((record) => ({ ...record, scopeId: userScopeId })),
      );
    });
    return guestRecords.length;
  }

  async create(input: NewDoneRecord): Promise<DoneRecord> {
    const now = new Date().toISOString();
    const record: StoredDoneRecord = {
      id: createId(),
      content: input.content.trim(),
      happenedAt: input.happenedAt,
      createdAt: now,
      updatedAt: now,
      isHighlighted: false,
      deletedAt: null,
      scopeId: this.scopeId,
    };

    await this.db.records.add(record);
    return toDoneRecord(record);
  }

  async update(record: DoneRecord): Promise<void> {
    const existing = await this.db.records.get(record.id);
    if (!existing || existing.scopeId !== this.scopeId) {
      throw new Error("找不到要修改的记录。");
    }

    await this.db.records.put({
      ...record,
      scopeId: this.scopeId,
      deletedAt: existing.deletedAt,
      content: record.content.trim(),
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(id: string): Promise<void> {
    const record = await this.db.records.get(id);
    if (!record || record.scopeId !== this.scopeId) return;
    const now = new Date().toISOString();
    await this.db.records.put({ ...record, deletedAt: now, updatedAt: now });
  }

  async getRecent(limit: number): Promise<DoneRecord[]> {
    const records = await this.db.records.where("scopeId").equals(this.scopeId).toArray();
    return records
      .filter((record) => !record.deletedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(toDoneRecord);
  }

  async getByRange(start: Date, end: Date): Promise<DoneRecord[]> {
    const records = await this.db.records
      .where("[scopeId+happenedAt]")
      .between(
        [this.scopeId, start.toISOString()],
        [this.scopeId, end.toISOString()],
        true,
        false,
      )
      .toArray();
    return records.filter((record) => !record.deletedAt).map(toDoneRecord);
  }

  async getByMonth(year: number, month: number): Promise<DoneRecord[]> {
    return this.getByRange(new Date(year, month, 1), new Date(year, month + 1, 1));
  }

  async exportBackup(): Promise<RecordBackup> {
    const records = await this.db.records.where("scopeId").equals(this.scopeId).toArray();
    return {
      format: "done-list-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      records: records.filter((record) => !record.deletedAt).map(toDoneRecord),
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
        typeof record.isHighlighted === "boolean",
    );

    await this.db.records.bulkPut(records.map((record) => ({
      ...record,
      scopeId: this.scopeId,
      deletedAt: null,
    })));
    return records.length;
  }

  async getAllForSync(): Promise<SyncableDoneRecord[]> {
    const records = await this.db.records.where("scopeId").equals(this.scopeId).toArray();
    return records.map(toSyncableDoneRecord);
  }

  async mergeFromSync(records: SyncableDoneRecord[]): Promise<void> {
    if (!records.length) return;

    await this.db.transaction("rw", this.db.records, async () => {
      const existingRecords = await this.db.records.bulkGet(records.map((record) => record.id));
      const recordsToWrite = records.flatMap((record, index) => {
        const existing = existingRecords[index];
        if (
          existing &&
          existing.scopeId === this.scopeId &&
          existing.updatedAt.localeCompare(record.updatedAt) > 0
        ) {
          return [];
        }
        return [{ ...record, scopeId: this.scopeId }];
      });
      if (recordsToWrite.length) await this.db.records.bulkPut(recordsToWrite);
    });
  }
}

function toDoneRecord(record: StoredDoneRecord): DoneRecord {
  return {
    id: record.id,
    content: record.content,
    happenedAt: record.happenedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isHighlighted: record.isHighlighted,
  };
}

function toSyncableDoneRecord(record: StoredDoneRecord): SyncableDoneRecord {
  return { ...toDoneRecord(record), deletedAt: record.deletedAt };
}
