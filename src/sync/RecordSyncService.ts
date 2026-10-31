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

export class RecordSyncService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly localStore: IndexedDbRecordRepository,
  ) {}

  async sync(userId: string): Promise<void> {
    const { data: remoteRows, error: readError } = await this.client
      .from("done_records")
      .select("id,user_id,content,happened_at,created_at,updated_at,is_highlighted,deleted_at")
      .eq("user_id", userId);

    if (readError) throw readError;

    await this.localStore.mergeFromSync(
      ((remoteRows ?? []) as DoneRecordRow[]).map(fromRow),
    );

    const localRecords = await this.localStore.getAllForSync();
    if (!localRecords.length) return;

    const { error: writeError } = await this.client
      .from("done_records")
      .upsert(localRecords.map((record) => toRow(record, userId)), { onConflict: "id" });

    if (writeError) throw writeError;
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
