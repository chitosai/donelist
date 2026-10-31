import type { SyncState } from "../sync/useRecordSync";

function formatSyncStatus(syncState: SyncState): string {
  if (syncState.phase === "syncing") return "正在同步…";
  if (syncState.phase === "offline") {
    return syncState.pendingChanges
      ? `当前离线，${syncState.pendingChanges} 项等待同步`
      : "当前离线，将在联网后同步";
  }
  if (syncState.phase === "error") return "同步失败，点击下方按钮重试";
  if (syncState.pendingChanges) return `${syncState.pendingChanges} 项等待同步`;
  if (syncState.lastSyncedAt) {
    return `已同步 · ${new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(syncState.lastSyncedAt)}`;
  }
  return "尚未进行首次同步";
}

export function SyncStatus({ syncState }: { syncState: SyncState }) {
  return (
    <div className={`sync-status is-${syncState.phase}`} role="status">
      <span aria-hidden="true" />
      <div>
        <strong>{formatSyncStatus(syncState)}</strong>
        {syncState.phase === "error" && syncState.errorMessage && <p>{syncState.errorMessage}</p>}
      </div>
    </div>
  );
}
