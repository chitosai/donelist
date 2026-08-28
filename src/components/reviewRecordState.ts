import type { DoneRecord } from "../domain/DoneRecord";

function sortRecordsChronologically(records: DoneRecord[]): DoneRecord[] {
  return [...records].sort((left, right) => left.happenedAt.localeCompare(right.happenedAt));
}

export function updateRecordCollection(
  records: DoneRecord[],
  record: DoneRecord,
  isIncluded: boolean,
): DoneRecord[] {
  const remaining = records.filter((item) => item.id !== record.id);
  return isIncluded ? sortRecordsChronologically([...remaining, record]) : remaining;
}

export function deleteRecordFromCollection(records: DoneRecord[], recordId: string): DoneRecord[] {
  return records.filter((record) => record.id !== recordId);
}
