export type DoneRecord = {
  id: string;
  content: string;
  happenedAt: string;
  createdAt: string;
  updatedAt: string;
  isHighlighted: boolean;
};

export type NewDoneRecord = Pick<DoneRecord, "content" | "happenedAt">;

type RecordBackupBase = {
  format: "done-list-backup";
  exportedAt: string;
  records: DoneRecord[];
};

export type LegacyRecordBackup = RecordBackupBase & { version: 1 };

export type OwnedRecordBackup = RecordBackupBase & {
  version: 2;
  owner: { userId: string };
};

export type RecordBackup = LegacyRecordBackup | OwnedRecordBackup;
