import type { RecordBackup } from "./DoneRecord";

export const GUEST_BACKUP_USER_ID = "guest";
export const IMPORT_ACCOUNT_CHANGED_MESSAGE = "当前账号已改变，请重新选择备份文件。";

export type BackupImportOptions = {
  expectedUserId?: string;
  isOwnerConfirmed?: boolean;
};

export type BackupImportCheck =
  | { status: "allowed" }
  | { status: "confirmation" | "blocked"; message: string; detail: string };

const ACCOUNT_MISMATCH: BackupImportCheck = {
  status: "blocked",
  message: "这个备份不属于当前账号",
  detail: "备份中的用户标识与当前账号不一致，未导入任何记录。请切换到导出这个备份时使用的账号后再试。",
};

// Validate the envelope here; individual incomplete records are still skipped
// during import and reported to the user, as in the original backup format.
export function parseRecordBackup(value: unknown): RecordBackup {
  if (value && typeof value === "object" && "format" in value && value.format === "done-list-backup"
    && "records" in value && Array.isArray(value.records) && "version" in value) {
    if (value.version === 1) return value as RecordBackup;
    if (value.version === 2 && "owner" in value && value.owner && typeof value.owner === "object"
      && "userId" in value.owner && typeof value.owner.userId === "string"
      && value.owner.userId.length > 0 && value.owner.userId.trim() === value.owner.userId) {
      return value as RecordBackup;
    }
  }
  throw new Error("这个文件似乎并不是 Donelist 数据备份");
}

// This prevents accidental imports, not tampering: backup JSON is editable.
// The destination always comes from the current session, never from the file.
export function checkBackupImport(backup: RecordBackup, targetUserId: string): BackupImportCheck {
  if (backup.version === 1) return ACCOUNT_MISMATCH;
  if (backup.owner.userId === targetUserId) return { status: "allowed" };
  if (backup.owner.userId === GUEST_BACKUP_USER_ID) {
    return {
      status: "confirmation",
      message: "把登录前的备份导入当前账号？",
      detail: "这个备份来自未登录时的本地记录。继续后，记录会导入当前账号，并同步到云端。",
    };
  }
  if (targetUserId === GUEST_BACKUP_USER_ID) {
    return {
      status: "confirmation",
      message: "将账号备份导入本地？",
      detail: "您目前没有登录，但这个备份属于一个已注册账号。继续后，记录只会导入当前浏览器的本地游客区，不会自动同步到原账号。也可以取消，登录原账号后再导入。",
    };
  }
  return ACCOUNT_MISMATCH;
}
