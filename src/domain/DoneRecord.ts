export type DoneRecord = {
  id: string;
  content: string;
  happenedAt: string;
  createdAt: string;
  updatedAt: string;
  isHighlighted: boolean;
};

export type NewDoneRecord = Pick<DoneRecord, "content" | "happenedAt">;

export type RecordBackup = {
  format: "done-list-backup";
  version: 1;
  exportedAt: string;
  records: DoneRecord[];
};
