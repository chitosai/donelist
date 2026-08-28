import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { IndexedDbRecordRepository } from "./data/IndexedDbRecordRepository";
import type { DoneRecord, RecordBackup } from "./domain/DoneRecord";
import { formatRecordTime, fromDateTimeLocalValue, toDateTimeLocalValue } from "./utils/time";
import { ReviewSheet } from "./components/ReviewSheet";

const repository = new IndexedDbRecordRepository();
const RECENT_LIMIT = 10;

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 20 4.4-1 10.4-10.4a2.1 2.1 0 0 0-3-3L5.4 16 4 20Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.75 6.25 4.25 4 4.25-4" />
    </svg>
  );
}

export function App() {
  const [content, setContent] = useState("");
  const [isBackfillOpen, setIsBackfillOpen] = useState(false);
  const [customTime, setCustomTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [records, setRecords] = useState<DoneRecord[]>([]);
  const [editing, setEditing] = useState<DoneRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DoneRecord | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTime, setEditTime] = useState("");
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const refreshRecords = useCallback(async () => {
    setRecords(await repository.getRecent(RECENT_LIMIT));
  }, []);

  useEffect(() => {
    refreshRecords().catch(() => setNotice("读取记录失败，请刷新页面重试。"));
  }, [refreshRecords]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function submitRecord(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    try {
      await repository.create({
        content: trimmed,
        happenedAt: isBackfillOpen
          ? fromDateTimeLocalValue(customTime)
          : new Date().toISOString(),
      });
      setContent("");
      setIsBackfillOpen(false);
      setCustomTime(toDateTimeLocalValue(new Date()));
      await refreshRecords();
      setNotice("已记录");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setIsSaving(false);
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitRecord();
    }
  }

  function openEditor(record: DoneRecord) {
    setEditing(record);
    setEditContent(record.content);
    setEditTime(toDateTimeLocalValue(new Date(record.happenedAt)));
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !editContent.trim()) return;

    try {
      await repository.update({
        ...editing,
        content: editContent.trim(),
        happenedAt: fromDateTimeLocalValue(editTime),
      });
      setEditing(null);
      await refreshRecords();
      setNotice("修改已保存");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "修改失败，请重试。");
    }
  }

  async function removeRecord(record: DoneRecord) {
    try {
      await repository.delete(record.id);
      setPendingDelete(null);
      await refreshRecords();
      setNotice("记录已删除");
    } catch {
      setNotice("删除失败，请重试。");
    }
  }

  async function exportBackup() {
    try {
      const backup = await repository.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `done-list-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("备份已导出");
    } catch {
      setNotice("导出失败，请重试。");
    }
  }

  async function importBackup(file: File) {
    try {
      const backup = JSON.parse(await file.text()) as RecordBackup;
      const count = await repository.importBackup(backup);
      await refreshRecords();
      setNotice(`已导入 ${count} 条记录`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败，请检查备份文件。");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">YOUR MONTH, REMEMBERED</p>
          <h1>Done List</h1>
        </div>
        <button className="review-button" type="button" onClick={() => setIsReviewOpen(true)}>
          回顾
          <span aria-hidden="true">↗</span>
        </button>
      </header>

      <section className={`composer ${isBackfillOpen ? "is-backfill" : ""}`} aria-label="添加记录">
        <div className="composer-topline">
          <button
            className="backfill-toggle"
            type="button"
            aria-expanded={isBackfillOpen}
            onClick={() => {
              const next = !isBackfillOpen;
              setIsBackfillOpen(next);
              if (next) setCustomTime(toDateTimeLocalValue(new Date()));
            }}
          >
            <ChevronIcon />
            {isBackfillOpen ? "正在补记" : "补记时间"}
          </button>
          {isBackfillOpen && <span className="backfill-hint">保存后将自动恢复当前时间</span>}
        </div>

        <div className="date-panel-shell" aria-hidden={!isBackfillOpen}>
          <div className="date-panel-clip">
            <div className="date-panel">
              <label htmlFor="record-time">这件事发生在</label>
              <input
                id="record-time"
                type="datetime-local"
                value={customTime}
                onInput={(event) => setCustomTime(event.currentTarget.value)}
                disabled={!isBackfillOpen}
                tabIndex={isBackfillOpen ? 0 : -1}
                required
              />
            </div>
          </div>
        </div>

        <form className="input-row" onSubmit={submitRecord}>
          <input
            ref={inputRef}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="今天完成了什么？"
            aria-label="记录内容"
            autoComplete="off"
            maxLength={500}
            autoFocus
          />
          <button type="submit" disabled={!content.trim() || isSaving} aria-label="保存记录">
            {isSaving ? "…" : "↵"}
          </button>
        </form>
        <p className="keyboard-hint">输入后按 Enter 保存</p>
      </section>

      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">最近记录</h2>
          <span>{records.length ? `最近 ${records.length} 条` : "0 条"}</span>
        </div>

        {records.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true">✓</span>
            <p>这里会出现你刚刚完成的事情。</p>
          </div>
        ) : (
          <ol className="record-list">
            {records.map((record) => (
              <li key={record.id} className="record-item">
                <time dateTime={record.happenedAt}>{formatRecordTime(record.happenedAt)}</time>
                <p>{record.content}</p>
                <div className="record-actions">
                  <button type="button" onClick={() => openEditor(record)} aria-label={`编辑：${record.content}`}>
                    <EditIcon />
                  </button>
                  <button type="button" onClick={() => setPendingDelete(record)} aria-label={`删除：${record.content}`}>
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <details className="data-tools">
        <summary>数据工具</summary>
        <div>
          <button type="button" onClick={() => void exportBackup()}>
            <DownloadIcon /> 导出备份
          </button>
          <button type="button" onClick={() => importRef.current?.click()}>导入备份</button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importBackup(file);
            }}
          />
        </div>
      </details>

      {notice && <div className="toast" role="status">{notice}</div>}

      {editing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditing(null)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="edit-title">编辑记录</h2>
            <form onSubmit={saveEdit}>
              <label htmlFor="edit-content">内容</label>
              <input
                id="edit-content"
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
                maxLength={500}
                autoFocus
              />
              <label htmlFor="edit-time">发生时间</label>
              <input
                id="edit-time"
                type="datetime-local"
                value={editTime}
                onInput={(event) => setEditTime(event.currentTarget.value)}
                required
              />
              <div className="modal-actions">
                <button className="button-secondary" type="button" onClick={() => setEditing(null)}>取消</button>
                <button className="button-primary" type="submit" disabled={!editContent.trim()}>保存修改</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setPendingDelete(null)}>
          <section
            className="modal-card delete-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-title">删除这条记录？</h2>
            <p id="delete-description">“{pendingDelete.content}”删除后无法恢复。</p>
            <div className="modal-actions">
              <button className="button-secondary" type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button-danger" type="button" onClick={() => void removeRecord(pendingDelete)}>确认删除</button>
            </div>
          </section>
        </div>
      )}

      <ReviewSheet
        open={isReviewOpen}
        repository={repository}
        onClose={() => setIsReviewOpen(false)}
        onRecordsChanged={refreshRecords}
      />
    </main>
  );
}
