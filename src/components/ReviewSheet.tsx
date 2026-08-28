import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { RecordRepository } from "../data/RecordRepository";
import type { DoneRecord } from "../domain/DoneRecord";
import { compareHighlightPriority } from "../domain/recordOrdering";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "../utils/time";
import { calculateCalendarPreviewCapacity } from "./calendarCapacity";
import { deleteRecordFromCollection, updateRecordCollection } from "./reviewRecordState";

type ReviewSheetProps = {
  open: boolean;
  repository: RecordRepository;
  onClose: () => void;
  onRecordsChanged?: () => void | Promise<void>;
};

type AnchorRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type SelectedDay = {
  key: string;
  date: Date;
  records: DoneRecord[];
  anchor: AnchorRect;
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameDay(left: Date, right: Date): boolean {
  return localDateKey(left) === localDateKey(right);
}

function buildCalendarDays(month: Date): Date[] {
  const firstDay = startOfMonth(month);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  return Array.from(
    { length: 42 },
    (_, index) => new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - mondayOffset + index),
  );
}

function formatMonthTitle(month: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(month);
}

function formatDayTitle(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function formatItemTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function Icon({ name }: { name: "left" | "right" | "close" }) {
  if (name === "close") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5.5 5.5 9 9m0-9-9 9" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={name === "left" ? "m12.5 5-5 5 5 5" : "m7.5 5 5 5-5 5"} />
    </svg>
  );
}

type CalendarDayProps = {
  date: Date;
  records: DoneRecord[];
  currentMonth: number;
  previewCapacity: number;
  selected: boolean;
  onSelect: (date: Date, records: DoneRecord[], element: HTMLElement) => void;
};

function CalendarDay({
  date,
  records,
  currentMonth,
  previewCapacity,
  selected,
  onSelect,
}: CalendarDayProps) {
  const isOutside = date.getMonth() !== currentMonth;
  const isToday = sameDay(date, new Date());
  const isInactive = isOutside || records.length === 0;
  const chronologicalRecords = useMemo(
    () => [...records].sort((left, right) => left.happenedAt.localeCompare(right.happenedAt)),
    [records],
  );
  const prioritizedRecords = useMemo(
    () => [...chronologicalRecords].sort(compareHighlightPriority),
    [chronologicalRecords],
  );

  let visibleRecords: DoneRecord[] = [];
  let hiddenCount = 0;
  let summaryOnly = false;

  if (!isOutside && prioritizedRecords.length > 0 && previewCapacity > 0) {
    if (prioritizedRecords.length <= previewCapacity) {
      visibleRecords = prioritizedRecords;
    } else if (previewCapacity === 1) {
      summaryOnly = true;
    } else {
      visibleRecords = prioritizedRecords.slice(0, previewCapacity - 1);
      hiddenCount = prioritizedRecords.length - visibleRecords.length;
    }
  }

  const label = `${formatDayTitle(date)}，${records.length ? `${records.length} 条记录` : "没有记录"}`;

  return (
    <div
      className={`calendar-day${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}${records.length ? " has-records" : ""}${selected ? " is-selected" : ""}`}
      role="gridcell"
      aria-label={label}
      aria-selected={selected}
      aria-disabled={isInactive}
      tabIndex={isInactive ? -1 : 0}
      onClick={(event) => {
        if (!isInactive) onSelect(date, chronologicalRecords, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (!isInactive && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(date, chronologicalRecords, event.currentTarget);
        }
      }}
    >
      <span className="calendar-day-header">
        <span className="calendar-day-number">{date.getDate()}</span>
        {!isOutside && records.length > 0 && previewCapacity === 0 && (
          <span className="calendar-day-count">{records.length}条</span>
        )}
      </span>

      {!isOutside && previewCapacity > 0 && (
        <span className="calendar-day-items">
          {summaryOnly ? (
            <span className="calendar-item calendar-item-summary">{records.length} 条记录</span>
          ) : (
            <>
              {visibleRecords.map((record) => (
                <span
                  className={`calendar-item${record.isHighlighted ? " is-highlighted" : ""}`}
                  key={record.id}
                  title={record.content}
                >
                  {record.content}
                </span>
              ))}
              {hiddenCount > 0 && (
                <span className="calendar-item calendar-item-summary">+{hiddenCount} 条</span>
              )}
            </>
          )}
        </span>
      )}
    </div>
  );
}

function DayDetailPopover({
  selected,
  onClose,
  onToggleHighlight,
  onEditRecord,
  onDeleteRecord,
}: {
  selected: SelectedDay;
  onClose: () => void;
  onToggleHighlight: (record: DoneRecord) => void;
  onEditRecord: (record: DoneRecord) => void;
  onDeleteRecord: (record: DoneRecord) => void;
}) {
  const popoverRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ top: selected.anchor.top, left: selected.anchor.right + 12 });
  const [actionMenuRecordId, setActionMenuRecordId] = useState<string | null>(null);

  useEffect(() => setActionMenuRecordId(null), [selected.key]);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover || window.matchMedia("(max-width: 700px)").matches) return;

    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const padding = 14;
    const gap = 12;
    const roomOnRight = window.innerWidth - selected.anchor.right;
    const preferredLeft =
      roomOnRight >= width + gap
        ? selected.anchor.right + gap
        : selected.anchor.left - width - gap;
    const left = Math.min(Math.max(padding, preferredLeft), window.innerWidth - width - padding);
    const top = Math.min(
      Math.max(padding, selected.anchor.top),
      Math.max(padding, window.innerHeight - height - padding),
    );

    setPosition({ top, left });
  }, [selected, actionMenuRecordId]);

  return (
    <aside
      ref={popoverRef}
      className="day-detail-popover"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="day-detail-title"
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".day-detail-row")) {
          setActionMenuRecordId(null);
        }
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && actionMenuRecordId) {
          event.stopPropagation();
          setActionMenuRecordId(null);
        }
      }}
    >
      <header className="day-detail-header">
        <div>
          <p>{selected.records.length} 条记录</p>
          <h3 id="day-detail-title">{formatDayTitle(selected.date)}</h3>
        </div>
        <button type="button" aria-label="关闭日期详情" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <ol className="day-detail-list">
        {selected.records.map((record) => (
          <li
            className={`day-detail-row${actionMenuRecordId === record.id ? " has-open-menu" : ""}`}
            key={record.id}
          >
            <button
              className={`day-detail-item${record.isHighlighted ? " is-highlighted" : ""}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={actionMenuRecordId === record.id}
              onClick={() => {
                setActionMenuRecordId((current) => current === record.id ? null : record.id);
              }}
            >
              <time dateTime={record.happenedAt}>{formatItemTime(record.happenedAt)}</time>
              <p>{record.content}</p>
            </button>
            {actionMenuRecordId === record.id && (
              <div className="day-detail-action-menu" role="menu" aria-label={`操作：${record.content}`}>
                <button
                  className="is-highlight-action"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionMenuRecordId(null);
                    onToggleHighlight(record);
                  }}
                >
                  {record.isHighlighted ? "取消高亮" : "高亮"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionMenuRecordId(null);
                    onEditRecord(record);
                  }}
                >
                  编辑
                </button>
                <button
                  className="is-danger"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionMenuRecordId(null);
                    onDeleteRecord(record);
                  }}
                >
                  删除
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function ReviewSheet({ open, repository, onClose, onRecordsChanged }: ReviewSheetProps) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [records, setRecords] = useState<DoneRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState<SelectedDay | null>(null);
  const [previewCapacity, setPreviewCapacity] = useState(0);
  const [editingRecord, setEditingRecord] = useState<DoneRecord | null>(null);
  const [pendingDeleteRecord, setPendingDeleteRecord] = useState<DoneRecord | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTime, setEditTime] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeletingRecord, setIsDeletingRecord] = useState(false);
  const [reviewNotice, setReviewNotice] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);

  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const recordsByDay = useMemo(() => {
    const grouped = new Map<string, DoneRecord[]>();
    records.forEach((record) => {
      const key = localDateKey(new Date(record.happenedAt));
      const existing = grouped.get(key) ?? [];
      existing.push(record);
      grouped.set(key, existing);
    });
    return grouped;
  }, [records]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      setVisibleMonth(startOfMonth(new Date()));
      setSelectedDay(null);
      setEditingRecord(null);
      setPendingDeleteRecord(null);
      return;
    }

    if (rendered) {
      setSelectedDay(null);
      setEditingRecord(null);
      setPendingDeleteRecord(null);
      setClosing(true);
    }
  }, [open, rendered]);

  useEffect(() => {
    if (!reviewNotice) return;
    const timeout = window.setTimeout(() => setReviewNotice(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [reviewNotice]);

  useEffect(() => {
    if (!rendered) return;
    let cancelled = false;
    setLoading(true);
    repository
      .getByMonth(visibleMonth.getFullYear(), visibleMonth.getMonth())
      .then((nextRecords) => {
        if (!cancelled) setRecords(nextRecords);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repository, visibleMonth]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editingRecord) setEditingRecord(null);
        else if (pendingDeleteRecord) setPendingDeleteRecord(null);
        else if (selectedDay) setSelectedDay(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [rendered, onClose, selectedDay, editingRecord, pendingDeleteRecord]);

  useLayoutEffect(() => {
    if (!rendered || !gridRef.current) return;
    const grid = gridRef.current;

    const calculateCapacity = () => {
      const sampleCell = grid.querySelector<HTMLElement>(".calendar-day:not(.is-outside)");
      const header = sampleCell?.querySelector<HTMLElement>(".calendar-day-header");
      if (!sampleCell || !header) return;
      const style = getComputedStyle(sampleCell);
      const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availableHeight = sampleCell.clientHeight - verticalPadding - header.offsetHeight - 4;
      setPreviewCapacity(calculateCalendarPreviewCapacity(availableHeight));
    };

    calculateCapacity();
    const observer = new ResizeObserver(calculateCapacity);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [rendered, visibleMonth]);

  if (!rendered) return null;

  function changeMonth(offset: number) {
    setSelectedDay(null);
    setVisibleMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + offset, 1),
    );
  }

  function selectDay(date: Date, dayRecords: DoneRecord[], element: HTMLElement) {
    if (!dayRecords.length) return;
    const rect = element.getBoundingClientRect();
    const key = localDateKey(date);
    setSelectedDay((current) => current?.key === key ? null : {
      key,
      date,
      records: dayRecords,
      anchor: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
    });
  }

  function handleReviewSurfaceMouseDown(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (!target.closest(".calendar-day.has-records")) {
      setSelectedDay(null);
    }
  }

  function openRecordEditor(record: DoneRecord) {
    setEditingRecord(record);
    setEditContent(record.content);
    setEditTime(toDateTimeLocalValue(new Date(record.happenedAt)));
  }

  function isRecordInVisibleMonth(record: DoneRecord): boolean {
    const date = new Date(record.happenedAt);
    return date.getFullYear() === visibleMonth.getFullYear() &&
      date.getMonth() === visibleMonth.getMonth();
  }

  function applyEditedRecord(record: DoneRecord) {
    setRecords((current) => updateRecordCollection(current, record, isRecordInVisibleMonth(record)));
    setSelectedDay((current) => {
      if (!current) return null;
      const nextRecords = updateRecordCollection(
        current.records,
        record,
        localDateKey(new Date(record.happenedAt)) === current.key,
      );
      return nextRecords.length ? { ...current, records: nextRecords } : null;
    });
  }

  function applyDeletedRecord(recordId: string) {
    setRecords((current) => deleteRecordFromCollection(current, recordId));
    setSelectedDay((current) => {
      if (!current) return null;
      const nextRecords = deleteRecordFromCollection(current.records, recordId);
      return nextRecords.length ? { ...current, records: nextRecords } : null;
    });
  }

  async function syncRecentRecords() {
    try {
      await onRecordsChanged?.();
    } catch (error) {
      console.error("刷新最近记录失败", error);
    }
  }

  async function saveRecordEdit(event: FormEvent) {
    event.preventDefault();
    if (!editingRecord || !editContent.trim() || isSavingEdit) return;

    setIsSavingEdit(true);
    try {
      const nextRecord = {
        ...editingRecord,
        content: editContent.trim(),
        happenedAt: fromDateTimeLocalValue(editTime),
      };
      await repository.update(nextRecord);
      applyEditedRecord(nextRecord);
      setEditingRecord(null);
      setReviewNotice("修改已保存");
      void syncRecentRecords();
    } catch (error) {
      setReviewNotice(error instanceof Error ? error.message : "修改失败，请重试。");
    } finally {
      setIsSavingEdit(false);
    }
  }

  async function deleteRecord(record: DoneRecord) {
    if (isDeletingRecord) return;
    setIsDeletingRecord(true);
    try {
      await repository.delete(record.id);
      applyDeletedRecord(record.id);
      setPendingDeleteRecord(null);
      setReviewNotice("记录已删除");
      void syncRecentRecords();
    } catch {
      setReviewNotice("删除失败，请重试。");
    } finally {
      setIsDeletingRecord(false);
    }
  }

  async function toggleHighlight(record: DoneRecord) {
    const nextRecord = { ...record, isHighlighted: !record.isHighlighted };
    const applyRecord = (candidate: DoneRecord) => {
      setRecords((current) => current.map((item) => item.id === candidate.id ? candidate : item));
      setSelectedDay((current) => current ? {
        ...current,
        records: current.records.map((item) => item.id === candidate.id ? candidate : item),
      } : current);
    };

    applyRecord(nextRecord);
    try {
      await repository.update(nextRecord);
    } catch (error) {
      applyRecord(record);
      console.error("保存高亮状态失败", error);
    }
  }

  return (
    <div
      className={`review-backdrop${closing ? " is-closing" : ""}`}
      role="presentation"
      aria-hidden={closing}
      onMouseDown={(event) => {
        if (!closing && event.target === event.currentTarget) onClose();
      }}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) {
          setRendered(false);
          setClosing(false);
        }
      }}
    >
      <section
        className="review-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
        onMouseDownCapture={handleReviewSurfaceMouseDown}
      >
        <header className="review-sheet-header">
          <div className="review-title-group">
            <p>MONTHLY REVIEW</p>
            <h2 id="review-sheet-title">回顾</h2>
          </div>

          <div className="month-navigation" aria-label="月份导航">
            <button type="button" aria-label="上一个月" onClick={() => changeMonth(-1)}>
              <Icon name="left" />
            </button>
            <strong aria-live="polite">{formatMonthTitle(visibleMonth)}</strong>
            <button type="button" aria-label="下一个月" onClick={() => changeMonth(1)}>
              <Icon name="right" />
            </button>
          </div>

          <div className="review-header-actions">
            <button
              className="today-button"
              type="button"
              onClick={() => {
                setVisibleMonth(startOfMonth(new Date()));
                setSelectedDay(null);
              }}
            >
              回到本月
            </button>
            <button className="review-close-button" type="button" aria-label="关闭回顾" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="review-sheet-body">
          <div className="calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((weekday, index) => (
              <span key={weekday} className={index >= 5 ? "is-weekend" : ""}>{weekday}</span>
            ))}
          </div>

          <div
            ref={gridRef}
            className={`calendar-grid${loading ? " is-loading" : ""}`}
            role="grid"
            aria-label={`${formatMonthTitle(visibleMonth)}的完成记录`}
          >
            {calendarDays.map((date) => {
              const key = localDateKey(date);
              return (
                <CalendarDay
                  key={key}
                  date={date}
                  records={recordsByDay.get(key) ?? []}
                  currentMonth={visibleMonth.getMonth()}
                  previewCapacity={previewCapacity}
                  selected={selectedDay?.key === key}
                  onSelect={selectDay}
                />
              );
            })}
          </div>
        </div>
      </section>

      {selectedDay && (
        <DayDetailPopover
          selected={selectedDay}
          onClose={() => setSelectedDay(null)}
          onToggleHighlight={toggleHighlight}
          onEditRecord={openRecordEditor}
          onDeleteRecord={setPendingDeleteRecord}
        />
      )}

      {editingRecord && (
        <div
          className="modal-backdrop review-modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            if (!isSavingEdit) setEditingRecord(null);
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-edit-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="review-edit-title">编辑记录</h2>
            <form onSubmit={saveRecordEdit}>
              <label htmlFor="review-edit-content">内容</label>
              <input
                id="review-edit-content"
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
                maxLength={500}
                autoFocus
              />
              <label htmlFor="review-edit-time">发生时间</label>
              <input
                id="review-edit-time"
                type="datetime-local"
                value={editTime}
                onInput={(event) => setEditTime(event.currentTarget.value)}
                required
              />
              <div className="modal-actions">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={isSavingEdit}
                  onClick={() => setEditingRecord(null)}
                >
                  取消
                </button>
                <button
                  className="button-primary"
                  type="submit"
                  disabled={!editContent.trim() || isSavingEdit}
                >
                  {isSavingEdit ? "保存中…" : "保存修改"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {pendingDeleteRecord && (
        <div
          className="modal-backdrop review-modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            if (!isDeletingRecord) setPendingDeleteRecord(null);
          }}
        >
          <section
            className="modal-card delete-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="review-delete-title"
            aria-describedby="review-delete-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="review-delete-title">删除这条记录？</h2>
            <p id="review-delete-description">“{pendingDeleteRecord.content}”删除后无法恢复。</p>
            <div className="modal-actions">
              <button
                className="button-secondary"
                type="button"
                disabled={isDeletingRecord}
                onClick={() => setPendingDeleteRecord(null)}
              >
                取消
              </button>
              <button
                className="button-danger"
                type="button"
                disabled={isDeletingRecord}
                onClick={() => void deleteRecord(pendingDeleteRecord)}
              >
                {isDeletingRecord ? "删除中…" : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      )}

      {reviewNotice && <div className="toast review-toast" role="status">{reviewNotice}</div>}
    </div>
  );
}
