import { describe, expect, it } from "vitest";
import type { DoneRecord } from "../domain/DoneRecord";
import { deleteRecordFromCollection, updateRecordCollection } from "./reviewRecordState";

function createRecord(id: string, happenedAt: string): DoneRecord {
  return {
    id,
    content: id,
    happenedAt,
    createdAt: happenedAt,
    updatedAt: happenedAt,
    isHighlighted: false,
  };
}

describe("review record state", () => {
  it("updates a record and keeps the collection chronological", () => {
    const first = createRecord("first", "2026-08-20T08:00:00.000Z");
    const second = createRecord("second", "2026-08-20T10:00:00.000Z");
    const movedSecond = { ...second, happenedAt: "2026-08-20T07:00:00.000Z" };

    expect(updateRecordCollection([first, second], movedSecond, true).map((record) => record.id))
      .toEqual(["second", "first"]);
  });

  it("removes records that move outside the active date collection", () => {
    const record = createRecord("moved", "2026-08-20T08:00:00.000Z");
    expect(updateRecordCollection([record], record, false)).toEqual([]);
  });

  it("deletes a record from the active collection", () => {
    const first = createRecord("first", "2026-08-20T08:00:00.000Z");
    const second = createRecord("second", "2026-08-20T10:00:00.000Z");
    expect(deleteRecordFromCollection([first, second], first.id)).toEqual([second]);
  });
});
