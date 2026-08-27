import type { DoneRecord } from "./DoneRecord";

export function compareHighlightPriority(left: DoneRecord, right: DoneRecord): number {
  const leftPriority = left.isHighlighted === true ? 1 : 0;
  const rightPriority = right.isHighlighted === true ? 1 : 0;
  return rightPriority - leftPriority;
}
