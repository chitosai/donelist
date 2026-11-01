import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IndexedDbRecordRepository,
  SyncableDoneRecord,
} from "../data/IndexedDbRecordRepository";
import { parseSyncVersion } from "./syncVersion";

type DoneRecordRow = {
  id: string;
  user_id: string;
  content: string;
  happened_at: string;
  created_at: string;
  updated_at: string;
  is_highlighted: boolean;
  deleted_at: string | null;
  sync_version: string;
};

export type RecordSyncOptions = {
  onDownloadedPage?: () => void | Promise<void>;
  isActive?: () => boolean;
};

const DOWNLOAD_PAGE_SIZE = 500;
const UPLOAD_BATCH_SIZE = 100;

export class RecordSyncService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly localStore: IndexedDbRecordRepository,
  ) {}

  async sync(userId: string, options: RecordSyncOptions = {}): Promise<void> {
    const isActive = options.isActive ?? (() => true);
    if (!isActive()) return;
    await this.localStore.prepareUploadQueue(userId);
    if (!isActive()) return;
    let cursor = await this.localStore.getDownloadCursor(userId);
    const pendingAtReadStart = await this.localStore.getPendingUploads(userId);
    // The RPC checks that the requested account still matches the auth session.
    // A transactionally maintained counter is a committed upper bound, unlike
    // a sequence value or a timestamp supplied by a client device.
    const { data: latest, error: versionError } = await this.client.rpc("get_record_sync_version", { p_user_id: userId });
    if (versionError) {
      if (["PGRST202", "42883"].includes(versionError.code)) {
        throw new Error("数据库尚未启用增量同步，请先执行数据库升级脚本。本地记录已保留。");
      }
      throw versionError;
    }
    if (!isActive()) return;
    const latestVersion = parseSyncVersion(latest);
    if (BigInt(cursor) > BigInt(latestVersion)) {
      throw new Error("云端版本低于本地下载进度，已停止同步以保留数据，请检查数据库是否被恢复或更换。");
    }

    while (true) {
      if (!isActive()) return;
      if (BigInt(cursor) >= BigInt(latestVersion)) break;
      const { data, error } = await this.client
        .rpc("get_record_changes", {
          p_user_id: userId,
          p_after_version: cursor,
          p_until_version: latestVersion,
          p_page_size: DOWNLOAD_PAGE_SIZE,
        })
        .select("id,user_id,content,happened_at,created_at,updated_at,is_highlighted,deleted_at,sync_version::text")
        .order("sync_version");
      if (error) throw error;
      if (!isActive()) return;
      if (!Array.isArray(data) || data.length > DOWNLOAD_PAGE_SIZE) throw new Error("云端返回的同步数据无效，下载进度未更新。");
      const page = (data ?? []) as DoneRecordRow[];
      let lastVersion = cursor;
      for (const row of page) {
        const version = parseSyncVersion(row.sync_version);
        if (row.user_id !== userId || BigInt(version) <= BigInt(lastVersion) || BigInt(version) > BigInt(latestVersion)) {
          throw new Error("云端返回的同步顺序或账号无效，下载进度未更新。");
        }
        lastVersion = version;
      }
      // Even a short page isn't assumed to be the end: the API's configured row
      // cap can be lower than 500. An empty page safely completes this window.
      const nextVersion = page.length ? lastVersion : latestVersion;
      const isApplied = await this.localStore.applyDownloadedPage(userId, page.map(fromRow), cursor, nextVersion, pendingAtReadStart);
      if (isApplied && page.length && isActive()) await options.onDownloadedPage?.();
      cursor = await this.localStore.getDownloadCursor(userId);
    }

    const pendingUploads = await this.localStore.getPendingUploads(userId);
    for (let offset = 0; offset < pendingUploads.length; offset += UPLOAD_BATCH_SIZE) {
      if (!isActive()) return;
      const batch = pendingUploads.slice(offset, offset + UPLOAD_BATCH_SIZE);
      const { error } = await this.client
        .from("records")
        .upsert(batch.map((upload) => toRow(upload.record, userId)), { onConflict: "id" });
      if (error) throw error;
      await this.localStore.acknowledgeUploads(userId, batch);
    }
  }
}

function fromRow(row: DoneRecordRow): SyncableDoneRecord {
  return {
    id: row.id,
    content: row.content,
    happenedAt: row.happened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isHighlighted: row.is_highlighted,
    deletedAt: row.deleted_at,
  };
}

function toRow(record: SyncableDoneRecord, userId: string): Omit<DoneRecordRow, "sync_version"> {
  return {
    id: record.id,
    user_id: userId,
    content: record.content,
    happened_at: record.happenedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    is_highlighted: record.isHighlighted,
    deleted_at: record.deletedAt,
  };
}
