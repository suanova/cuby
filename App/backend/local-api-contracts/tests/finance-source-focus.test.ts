import { describe, expect, it } from "vitest";
import { ConsistencyReportSchema } from "../src/finance-consistency.js";

const focus = { salary: [{ slot: "esg_en", page: 4, quote: "At present, climate-related considerations have not been included.", phrases: ["climate-related considerations"] }] };

describe("Optional source-focus presentation metadata", () => {
  it("preserves typed top-level annotations while remaining optional for older reports", () => {
    const schema = ConsistencyReportSchema.pick({ source_focus: true });
    expect(schema.parse({ source_focus: focus })).toEqual({ source_focus: focus });
    expect(schema.parse({})).toEqual({});
  });

  it.each([
    { ...focus.salary[0], slot: "unknown" },
    { ...focus.salary[0], page: 0 },
    { ...focus.salary[0], page: 1.5 },
    { ...focus.salary[0], quote: "" },
    { ...focus.salary[0], phrases: [] },
    { ...focus.salary[0], phrases: [""] },
    { ...focus.salary[0], phrases: ["x".repeat(121)] },
    { ...focus.salary[0], phrases: Array(5).fill("keyword") },
    { ...focus.salary[0], replacement: "An unrequested edit" },
  ])("drops malformed optional annotation shape without rejecting the review %#", ref => {
    expect(ConsistencyReportSchema.pick({ source_focus: true }).parse({ source_focus: { salary: [ref] } }).source_focus).toBeUndefined();
  });

  it.each([
    { ["x".repeat(201)]: focus.salary },
    { salary: [{ ...focus.salary[0], phrases: ["😀".repeat(70)] }] },
    { salary: [{ ...focus.salary[0], phrases: null }] },
  ])("falls back for metadata whose key or Unicode length exceeds native bounds %#", source_focus => {
    expect(ConsistencyReportSchema.pick({ source_focus: true }).parse({ source_focus }).source_focus).toBeUndefined();
  });
});
