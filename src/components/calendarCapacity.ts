const CALENDAR_ITEM_HEIGHT = 22;
const CALENDAR_ITEM_GAP = 2;

export function calculateCalendarPreviewCapacity(availableHeight: number): number {
  if (availableHeight <= 0) return 0;
  return Math.floor(
    (availableHeight + CALENDAR_ITEM_GAP) /
    (CALENDAR_ITEM_HEIGHT + CALENDAR_ITEM_GAP),
  );
}
