import type { DoneRecord, NewDoneRecord, RecordBackup } from "../domain/DoneRecord";
import type { BackupImportOptions } from "../domain/recordBackup";
import type { IndexedDbRecordRepository } from "./IndexedDbRecordRepository";
import type { RecordRepository } from "./RecordRepository";

type LocalChangeListener = () => void;

export class LocalRecordRepository implements RecordRepository {
  private readonly listeners = new Set<LocalChangeListener>();

  constructor(readonly store: IndexedDbRecordRepository) {}

  subscribe(listener: LocalChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChanged(): void {
    this.listeners.forEach((listener) => listener());
  }

  async create(input: NewDoneRecord): Promise<DoneRecord> {
    const record = await this.store.create(input);
    this.notifyChanged();
    return record;
  }

  async update(record: DoneRecord): Promise<void> {
    await this.store.update(record);
    this.notifyChanged();
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    this.notifyChanged();
  }

  getRecent(limit: number): Promise<DoneRecord[]> {
    return this.store.getRecent(limit);
  }

  getByRange(start: Date, end: Date): Promise<DoneRecord[]> {
    return this.store.getByRange(start, end);
  }

  getByMonth(year: number, month: number): Promise<DoneRecord[]> {
    return this.store.getByMonth(year, month);
  }

  exportBackup(): Promise<RecordBackup> {
    return this.store.exportBackup();
  }

  async importBackup(backup: RecordBackup, options?: BackupImportOptions): Promise<number> {
    const count = await this.store.importBackup(backup, options);
    this.notifyChanged();
    return count;
  }
}
