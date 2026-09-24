import { describe, expect, it } from "vitest";
import type { AggregationField, AggregationValue } from "@/domain/aggregation";
import { fieldDate, formatExcelDate, targetCell } from "@/lib/aggregation/values";

function field(value: Partial<AggregationValue> & Pick<AggregationValue, "displayValue">): AggregationField {
  return { key: "k", label: "값", value: { value: value.displayValue, type: "Text", sources: [], ...value } };
}

const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute, second));

describe("aggregation preview date rendering", () => {
  it("renders Excel date tokens, literals and escapes the way the workbook shows them", () => {
    const date = at(2026, 8, 5, 13, 7, 9);
    expect(formatExcelDate(date, 'yyyy"년" m"월" d"일"')).toBe("2026년 8월 5일");
    expect(formatExcelDate(date, "yy\\-mm\\-dd")).toBe("26-08-05");
    expect(formatExcelDate(date, "dddd, mmmm d")).toBe("Wednesday, August 5");
    expect(formatExcelDate(date, "mmm-yy")).toBe("Aug-26");
    expect(formatExcelDate(date, "mmmmm")).toBe("A");
    expect(formatExcelDate(date, "[$-409]ddd dd mmm yyyy")).toBe("Wed 05 Aug 2026");
  });

  it("reads m after an hour or before seconds as minutes, and honours AM/PM", () => {
    expect(formatExcelDate(at(2026, 8, 5, 13, 7, 9), "yyyy-mm-dd hh:mm:ss")).toBe("2026-08-05 13:07:09");
    expect(formatExcelDate(at(2026, 8, 5, 13, 7, 9), "h:m:s AM/PM")).toBe("1:7:9 PM");
    expect(formatExcelDate(at(2026, 8, 5, 0, 5), "h:mm am/pm")).toBe("12:05 AM");
    expect(formatExcelDate(at(2026, 8, 5, 0, 5), "m/d")).toBe("8/5");
  });

  it("falls back to ISO-style text, with time only when present, for missing or non-date formats", () => {
    expect(formatExcelDate(at(2026, 8, 5), undefined)).toBe("2026-08-05");
    expect(formatExcelDate(at(2026, 8, 5, 9, 30), "#,##0")).toBe("2026-08-05 09:30");
  });
});

describe("aggregation field date reading", () => {
  it("reads ISO values only from date-typed cells and rejects impossible calendar days", () => {
    expect(fieldDate(field({ displayValue: "2026-08-05", normalizedValue: "2026-08-05T10:20:00", cellType: "date" }))).toEqual(at(2026, 8, 5, 10, 20));
    expect(fieldDate(field({ displayValue: "2026-02-30", normalizedValue: "2026-02-30", type: "Date" }))).toBeUndefined();
  });

  it("reads Excel serials and loosely written dates, but not other text", () => {
    expect(fieldDate(field({ displayValue: "46239", value: 46239, type: "Number" }))).toEqual(at(2026, 8, 5));
    expect(fieldDate(field({ displayValue: "2026. 8. 5." }))).toEqual(at(2026, 8, 5));
    expect(fieldDate(field({ displayValue: "2026/08/05 14:30" }))).toEqual(at(2026, 8, 5, 14, 30));
    expect(fieldDate(field({ displayValue: "8월 5일" }))).toBeUndefined();
  });
});

describe("aggregation target cell values", () => {
  it("drops unreadable and error cells instead of exporting them as data", () => {
    expect(targetCell([field({ displayValue: "[object Object]" }), field({ displayValue: "#REF!" })], { targetType: "text" })).toEqual({ value: null, display: "" });
  });

  it("joins several readable source fields into one text cell", () => {
    expect(targetCell([field({ displayValue: "A" }), field({ displayValue: "B" })], { targetType: "text" })).toEqual({ value: "A | B", display: "A | B" });
  });

  it("turns a serial mapped into a date column into that day with the target's format", () => {
    const cell = targetCell([field({ displayValue: "46239", value: 46239, type: "Number" })], { targetType: "date", targetFormat: "yyyy.mm.dd" });
    expect(cell).toEqual({ value: at(2026, 8, 5), numberFormat: "yyyy.mm.dd", display: "2026.08.05" });
  });

  it("keeps a number's own non-date format and a boolean as-is", () => {
    expect(targetCell([field({ displayValue: "1,200원", value: 1200, type: "Number", numberFormat: '#,##0"원"' })], { targetType: "number" }))
      .toEqual({ value: 1200, numberFormat: '#,##0"원"', display: "1,200원" });
    expect(targetCell([field({ displayValue: "TRUE", value: true, type: "Boolean" })], { targetType: "text" })).toEqual({ value: true, display: "TRUE" });
  });
});
