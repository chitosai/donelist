import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IndexedDbRecordRepository,
  SyncableDoneRecord,
} from "../data/IndexedDbRecordRepository";

type DoneRecordRow = {
  id: string;
  user_id: string;
  content: string;
  happened_at: string;
  created_at: string;
  updated_at: string;
  is_highlighted: boolean;
  deleted_at: string | null;
};

const DOWNLOAD_PAGE_SIZE = 500;
const UPLOAD_BATCH_SIZE = 100;

export class RecordSyncService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly localStore: IndexedDbRecordRepository,
  ) {}

  async sync(userId: string): Promise<void> {
    await this.localStore.prepareUploadQueue(userId);
    const pendingAtReadStart = await this.localStore.getPendingUploads(userId);
    const remoteRows: DoneRecordRow[] = [];
    let lastId: string | null = null;
    // Downloads are still full reads in this phase, but page by a stable key.
    // This also makes the legacy-data reconciliation safe beyond one API page.
    while (true) {
      let query = this.client
        .from("records")
        .select("id,user_id,content,happened_at,created_at,updated_at,is_highlighted,deleted_at")
        .eq("user_id", userId)
        .order("id")
        .limit(DOWNLOAD_PAGE_SIZE);
      if (lastId) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data ?? []) as DoneRecordRow[];
      remoteRows.push(...page);
      if (page.length < DOWNLOAD_PAGE_SIZE) break;
      lastId = page[page.length - 1].id;
    }

    await this.localStore.mergeFromSync(
      remoteRows.map(fromRow),
      userId,
      pendingAtReadStart,
    );

    const pendingUploads = await this.localStore.getPendingUploads(userId);
    for (let offset = 0; offset < pendingUploads.length; offset += UPLOAD_BATCH_SIZE) {
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

function toRow(record: SyncableDoneRecord, userId: string): DoneRecordRow {
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
