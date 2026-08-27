import { describe, expect, it } from "vitest";
import { calculateCalendarPreviewCapacity } from "./calendarCapacity";

describe("calculateCalendarPreviewCapacity", () => {
  it("uses the final row without reserving a trailing gap", () => {
    expect(calculateCalendarPreviewCapacity(117)).toBe(4);
    expect(calculateCalendarPreviewCapacity(118)).toBe(5);
  });

  it("returns zero when there is no available height", () => {
    expect(calculateCalendarPreviewCapacity(0)).toBe(0);
    expect(calculateCalendarPreviewCapacity(-1)).toBe(0);
  });
});
