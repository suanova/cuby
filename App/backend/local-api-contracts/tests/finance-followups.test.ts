import { describe, expect, it } from "vitest";
import { FinanceRequestSchema } from "../src/finance-reader.js";
import { ConsistencyFollowupRecordSchema, ConsistencyFollowupsSchema } from "../src/finance-followups.js";

const context = { project_id: "a".repeat(32), version_id: "b".repeat(32), run_id: "20310101T000000-aabbccdd" };
const request = { action: "consistency-followup-update", ...context, expected_revision: 0, expected_binding_sha256: "c".repeat(64), check_id: "actual-issue", operation: "save", owner: "TEST ONLY owner", due_date: null, evidence_reference: "", note: "" };

describe("strict evidence follow-up protocol", () => {
  it("accepts explicit current and historical reads and a separate user-entered save", () => {
    expect(FinanceRequestSchema.parse({ action: "consistency-followups", ...context })).toMatchObject(context);
    expect(FinanceRequestSchema.parse({ action: "consistency-followups", ...context, history_only: true })).toHaveProperty("history_only", true);
    expect(FinanceRequestSchema.parse(request)).toMatchObject({ owner: "TEST ONLY owner", operation: "save" });
    expect(FinanceRequestSchema.parse({ ...request, operation: "verify", evidence_reference: "TEST ONLY reference", reviewer: "TEST ONLY reviewer" })).toHaveProperty("operation", "verify");
  });
  it.each([
    { owner: "" }, { due_date: "2031-02-30" }, { due_date: "2032-13-01" }, { version_id: "../outside" },
    { owner: "TEST\nONLY" }, { expected_revision: -1 }, { expected_binding_sha256: "unknown" },
    { operation: "receive", evidence_reference: "" }, { operation: "verify", evidence_reference: "TEST ONLY ref" },
    { reviewer: "unexpected" }, { verified_at: "forged" }, { history_only: true }, { apiKey: "untrusted" },
  ])("rejects missing identity, malformed values, unsolicited reviewer/time/credential fields %#", changes => {
    expect(FinanceRequestSchema.safeParse({ ...request, ...changes }).success).toBe(false);
  });
  it("does not parse an evidence receipt as verified without proof, reviewer and timestamp", () => {
    const record = { check_id: "actual-issue", issue_sha256: "d".repeat(64), owner: request.owner, due_date: null, evidence_reference: "TEST ONLY ref", note: "", status: "received_pending_review", reviewer: null, verified_at: null, updated_at: "2031-01-01T00:00:00Z" };
    expect(ConsistencyFollowupRecordSchema.parse(record).status).toBe("received_pending_review");
    expect(ConsistencyFollowupRecordSchema.safeParse({ ...record, evidence_reference: "" }).success).toBe(false);
    expect(ConsistencyFollowupRecordSchema.safeParse({ ...record, status: "verified" }).success).toBe(false);
  });
  it("rejects inconsistent issue keys/source identities and record/history revision maps", () => {
    const sha = "d".repeat(64);
    const state = { schema_version: "financebuddy-followups-1", ...context, binding_status: "current", binding_sha256: sha, base_report_sha256: sha, review_sha256: sha, source_sha256: { esg_en: sha }, revision: 0, issues: {}, records: {}, history: [] };
    expect(ConsistencyFollowupsSchema.parse(state).revision).toBe(0);
    expect(ConsistencyFollowupsSchema.safeParse({ ...state, issues: { other: { check_id: "actual-issue", issue_sha256: sha, title: "TEST ONLY", category: "basis", refs: [] } } }).success).toBe(false);
    expect(ConsistencyFollowupsSchema.safeParse({ ...state, revision: 1 }).success).toBe(false);
  });
});
