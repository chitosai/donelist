import { describe, expect, it } from "vitest";
import type { DoneRecord } from "./DoneRecord";
import { compareHighlightPriority } from "./recordOrdering";

function createRecord(id: string, isHighlighted?: boolean): DoneRecord {
  const record = {
    id,
    content: id,
    happenedAt: "2026-08-24T08:00:00.000Z",
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    ...(isHighlighted === undefined ? {} : { isHighlighted }),
  };

  return record as DoneRecord;
}

describe("compareHighlightPriority", () => {
  it("places highlighted records before records whose runtime flag is false or absent", () => {
    const records = [
      createRecord("missing-flag"),
      createRecord("highlighted", true),
      createRecord("not-highlighted", false),
    ];

    expect([...records].sort(compareHighlightPriority).map((record) => record.id)).toEqual([
      "highlighted",
      "missing-flag",
      "not-highlighted",
    ]);
  });
});
