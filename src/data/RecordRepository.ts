import type { DoneRecord, NewDoneRecord, RecordBackup } from "../domain/DoneRecord";

export interface RecordRepository {
  create(input: NewDoneRecord): Promise<DoneRecord>;
  update(record: DoneRecord): Promise<void>;
  delete(id: string): Promise<void>;
  getRecent(limit: number): Promise<DoneRecord[]>;
  getByMonth(year: number, month: number): Promise<DoneRecord[]>;
  exportBackup(): Promise<RecordBackup>;
  importBackup(backup: RecordBackup): Promise<number>;
}
