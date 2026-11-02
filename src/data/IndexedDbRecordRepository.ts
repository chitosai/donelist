import Dexie, { type Table } from "dexie";
import type { DoneRecord, NewDoneRecord, RecordBackup } from "../domain/DoneRecord";
import type { RecordRepository } from "./RecordRepository";
import { parseSyncVersion } from "../sync/syncVersion";

const GUEST_SCOPE_ID = "guest";

export type SyncableDoneRecord = DoneRecord & {
  deletedAt: string | null;
};

type StoredDoneRecord = SyncableDoneRecord & {
  scopeId: string;
};

type StoredRecordKey = [string, string];

function recordKey(scopeId: string, id: string): StoredRecordKey {
  return [scopeId, id];
}

export type PendingRecordUpload = {
  syncTarget: string;
  scopeId: string;
  recordId: string;
  mutationId: string;
  record: SyncableDoneRecord;
};

type UploadScope = { syncTarget: string; scopeId: string; initializedAt: string };
type DownloadScope = { syncTarget: string; scopeId: string; cursor: string };

class DoneListDatabase extends Dexie {
  scopedRecords!: Table<StoredDoneRecord, StoredRecordKey>;
  pendingUploads!: Table<PendingRecordUpload, [string, string, string]>;
  uploadScopes!: Table<UploadScope, [string, string]>;
  downloadScopes!: Table<DownloadScope, [string, string]>;

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
    // Existing records stay untouched. Account queues are initialized lazily.
    this.version(3).stores({
      records: "&id, scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]",
      pendingUploads: "[syncTarget+scopeId+recordId], [syncTarget+scopeId]",
      uploadScopes: "[syncTarget+scopeId]",
    });
    this.version(4).stores({
      downloadScopes: "[syncTarget+scopeId]",
    });
    // IndexedDB cannot change an existing store's primary key in place. Copy
    // into a new store, then remove the legacy store in the same upgrade
    // transaction. Any failure rolls back the entire upgrade, including data.
    this.version(5).stores({
      scopedRecords: "[scopeId+id], scopeId, happenedAt, createdAt, updatedAt, [scopeId+happenedAt]",
    }).upgrade(async (transaction) => {
      const records = await transaction.table<StoredDoneRecord>("records").toArray();
      await transaction.table<StoredDoneRecord, StoredRecordKey>("scopedRecords").bulkPut(records);
    });
    this.version(6).stores({ records: null });
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class IndexedDbRecordRepository implements RecordRepository {
  readonly db: DoneListDatabase;
  private scopeId = GUEST_SCOPE_ID;

  constructor(databaseName = "done-list", private readonly syncTarget = "local") {
    this.db = new DoneListDatabase(databaseName);
  }

  setGuestScope(): void {
    this.scopeId = GUEST_SCOPE_ID;
  }

  setUserScope(userId: string): void {
    this.scopeId = `user:${userId}`;
  }

  private async enqueueUpload(record: StoredDoneRecord): Promise<void> {
    if (record.scopeId === GUEST_SCOPE_ID) return;
    await this.db.pendingUploads.put({
      syncTarget: this.syncTarget,
      scopeId: record.scopeId,
      recordId: record.id,
      mutationId: createId(),
      record: toSyncableDoneRecord(record),
    });
  }

  async prepareUploadQueue(userId: string): Promise<void> {
    const scopeId = `user:${userId}`;
    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, this.db.uploadScopes, async () => {
      const key: [string, string] = [this.syncTarget, scopeId];
      if (await this.db.uploadScopes.get(key)) return;
      const records = await this.db.scopedRecords.where("scopeId").equals(scopeId).toArray();
      for (const record of records) {
        if (!await this.db.pendingUploads.get([this.syncTarget, scopeId, record.id])) {
          await this.enqueueUpload(record);
        }
      }
      await this.db.uploadScopes.put({ syncTarget: this.syncTarget, scopeId, initializedAt: new Date().toISOString() });
    });
  }

  getPendingUploads(userId: string): Promise<PendingRecordUpload[]> {
    return this.db.pendingUploads.where("[syncTarget+scopeId]").equals([this.syncTarget, `user:${userId}`]).toArray();
  }

  getPendingUploadCount(userId: string): Promise<number> {
    return this.db.pendingUploads.where("[syncTarget+scopeId]").equals([this.syncTarget, `user:${userId}`]).count();
  }

  async getDownloadCursor(userId: string): Promise<string> {
    const progress = await this.db.downloadScopes.get([this.syncTarget, `user:${userId}`]);
    return parseSyncVersion(progress?.cursor ?? "0");
  }

  async applyDownloadedPage(
    userId: string,
    records: SyncableDoneRecord[],
    afterVersion: string,
    nextVersion: string,
    pendingAtReadStart: PendingRecordUpload[],
  ): Promise<boolean> {
    const after = parseSyncVersion(afterVersion);
    const next = parseSyncVersion(nextVersion);
    if (BigInt(next) < BigInt(after)) throw new Error("下载进度不能倒退。");
    const scopeId = `user:${userId}`;
    return this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, this.db.downloadScopes, async () => {
      // Another tab may have committed a page while this request was in flight.
      // Its progress must not be overwritten by this older response.
      if (await this.getDownloadCursor(userId) !== after) return false;
      await this.mergeFromSync(records, userId, pendingAtReadStart);
      await this.db.downloadScopes.put({ syncTarget: this.syncTarget, scopeId, cursor: next });
      return true;
    });
  }

  async acknowledgeUploads(userId: string, uploads: PendingRecordUpload[]): Promise<void> {
    const scopeId = `user:${userId}`;
    await this.db.transaction("rw", this.db.pendingUploads, async () => {
      for (const upload of uploads) {
        if (upload.syncTarget !== this.syncTarget || upload.scopeId !== scopeId) continue;
        const key: [string, string, string] = [this.syncTarget, scopeId, upload.recordId];
        const current = await this.db.pendingUploads.get(key);
        if (current?.mutationId === upload.mutationId) await this.db.pendingUploads.delete(key);
      }
    });
  }

  async getGuestRecords(): Promise<DoneRecord[]> {
    const records = await this.db.scopedRecords.where("scopeId").equals(GUEST_SCOPE_ID).toArray();
    return records.filter((record) => !record.deletedAt).map(toDoneRecord);
  }

  async claimGuestRecords(userId: string, recordIds: string[]): Promise<number> {
    const userScopeId = `user:${userId}`;
    return this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      const records = await this.db.scopedRecords.bulkGet([...new Set(recordIds)].map((id) => recordKey(GUEST_SCOPE_ID, id)));
      const guestRecords = records.filter((record): record is StoredDoneRecord =>
        !!record && record.scopeId === GUEST_SCOPE_ID && !record.deletedAt,
      );
      if (guestRecords.length) {
        const accountRecords = await this.db.scopedRecords.bulkGet(guestRecords.map((record) => recordKey(userScopeId, record.id)));
        for (const [index, record] of guestRecords.entries()) {
          const existing = accountRecords[index];
          // Deduplicate an explicitly confirmed merge by the existing timestamp
          // policy. Preserve the account version on ties, including its outbox.
          if (existing && !(Date.parse(record.updatedAt) > Date.parse(existing.updatedAt))) continue;
          const claimed = { ...record, scopeId: userScopeId };
          await this.db.scopedRecords.put(claimed);
          await this.enqueueUpload(claimed);
        }
        await this.db.scopedRecords.bulkDelete(guestRecords.map((record) => recordKey(GUEST_SCOPE_ID, record.id)));
      }
      return guestRecords.length;
    });
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

    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      await this.db.scopedRecords.add(record);
      await this.enqueueUpload(record);
    });
    return toDoneRecord(record);
  }

  async update(record: DoneRecord): Promise<void> {
    const scopeId = this.scopeId;
    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      const existing = await this.db.scopedRecords.get(recordKey(scopeId, record.id));
      if (!existing || existing.scopeId !== scopeId) throw new Error("找不到要修改的记录。");
      const nextRecord: StoredDoneRecord = {
        ...record,
        scopeId,
        deletedAt: existing.deletedAt,
        content: record.content.trim(),
        updatedAt: new Date().toISOString(),
      };
      await this.db.scopedRecords.put(nextRecord);
      await this.enqueueUpload(nextRecord);
    });
  }

  async delete(id: string): Promise<void> {
    const scopeId = this.scopeId;
    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      const record = await this.db.scopedRecords.get(recordKey(scopeId, id));
      if (!record || record.scopeId !== scopeId) return;
      const now = new Date().toISOString();
      const nextRecord = { ...record, deletedAt: now, updatedAt: now };
      await this.db.scopedRecords.put(nextRecord);
      await this.enqueueUpload(nextRecord);
    });
  }

  async getRecent(limit: number): Promise<DoneRecord[]> {
    const records = await this.db.scopedRecords.where("scopeId").equals(this.scopeId).toArray();
    return records
      .filter((record) => !record.deletedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(toDoneRecord);
  }

  async getByRange(start: Date, end: Date): Promise<DoneRecord[]> {
    const records = await this.db.scopedRecords
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
    const records = await this.db.scopedRecords.where("scopeId").equals(this.scopeId).toArray();
    return {
      format: "done-list-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      records: records.filter((record) => !record.deletedAt).map(toDoneRecord),
    };
  }

  async importBackup(backup: RecordBackup): Promise<number> {
    if (!backup || typeof backup !== "object" || backup.format !== "done-list-backup" || backup.version !== 1 || !Array.isArray(backup.records)) {
      throw new Error("这个文件似乎并不是 Donelist 数据备份");
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

    const scopeId = this.scopeId;
    const storedRecords = records.map((record) => ({
      ...record,
      scopeId,
      deletedAt: null,
    }));
    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      await this.db.scopedRecords.bulkPut(storedRecords);
      for (const record of storedRecords) await this.enqueueUpload(record);
    });
    return records.length;
  }

  async getAllForSync(userId?: string): Promise<SyncableDoneRecord[]> {
    const scopeId = userId ? `user:${userId}` : this.scopeId;
    const records = await this.db.scopedRecords.where("scopeId").equals(scopeId).toArray();
    return records.map(toSyncableDoneRecord);
  }

  async mergeFromSync(records: SyncableDoneRecord[], userId?: string, pendingAtReadStart?: PendingRecordUpload[]): Promise<void> {
    if (!records.length) return;
    const scopeId = userId ? `user:${userId}` : this.scopeId;

    const observedMutations = pendingAtReadStart && new Map(pendingAtReadStart.map((upload) => [upload.recordId, upload.mutationId]));
    await this.db.transaction("rw", this.db.scopedRecords, this.db.pendingUploads, async () => {
      const existingRecords = await this.db.scopedRecords.bulkGet(records.map((record) => recordKey(scopeId, record.id)));
      for (const [index, record] of records.entries()) {
        const existing = existingRecords[index];
        const key: [string, string, string] = [this.syncTarget, scopeId, record.id];
        const pending = await this.db.pendingUploads.get(key);
        // An edit made while the remote read was in flight must survive that read.
        if (pending && observedMutations && observedMutations.get(record.id) !== pending.mutationId) continue;
        if (existing) {
          const timestampDifference = Date.parse(existing.updatedAt) - Date.parse(record.updatedAt);
          if (timestampDifference > 0) continue;
          // Distinct edits can share a millisecond; an old payload is not an ACK.
          if (pending && timestampDifference === 0 && !isSameSyncRecord(existing, record)) continue;
        }
        await this.db.scopedRecords.put({ ...record, scopeId });
        // The existing timestamp policy chose the cloud version (or it already
        // contains this mutation). Do not upload that unchanged cloud row again.
        if (pending) await this.db.pendingUploads.delete(key);
      }
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

function isSameSyncRecord(left: SyncableDoneRecord, right: SyncableDoneRecord): boolean {
  return left.id === right.id && left.content === right.content && left.isHighlighted === right.isHighlighted &&
    Date.parse(left.happenedAt) === Date.parse(right.happenedAt) &&
    Date.parse(left.createdAt) === Date.parse(right.createdAt) &&
    Date.parse(left.updatedAt) === Date.parse(right.updatedAt) &&
    (left.deletedAt === right.deletedAt || (!!left.deletedAt && !!right.deletedAt && Date.parse(left.deletedAt) === Date.parse(right.deletedAt)));
}
