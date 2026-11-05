import { describe, expect, it, vi } from "vitest";
import { FinanceReaderApi, isFinanceReaderTool } from "../../../src/entrypoints/frontend-bridge/finance-reader-api.js";

const context = { project_id: "a".repeat(32), version_id: "b".repeat(32), run_id: "20310101T000000-aabbccdd" };
const sha = "c".repeat(64);
const state = { schema_version: "financebuddy-followups-1", ...context, binding_status: "current", binding_sha256: sha, base_report_sha256: sha, review_sha256: sha, source_sha256: { esg_en: sha }, revision: 0, issues: {}, records: {}, history: [] };
const write = { action: "consistency-followup-update", ...context, check_id: "issue", operation: "save", expected_revision: 0, expected_binding_sha256: sha, owner: "TEST ONLY owner", due_date: null, evidence_reference: "", note: "" };

describe("fixed follow-up bridge", () => {
  it("reads only through the existing draft tool's dedicated no-prepare operation", async () => {
    const call = vi.fn(async () => state), api = new FinanceReaderApi(call);
    expect(await api.request({ action: "consistency-followups", ...context })).toEqual(state);
    expect(call).toHaveBeenCalledWith("mcp_financebuddy_reports_edit_consistency_draft", { operation: "followups-read", ...context });
    expect(isFinanceReaderTool("mcp_financebuddy_reports_manage_followups")).toBe(false);
  });
  it("maps an explicit save to a fixed scoped operation without changing PDF decisions", async () => {
    const call = vi.fn(async () => state), api = new FinanceReaderApi(call);
    await api.request(write);
    expect(call).toHaveBeenCalledWith("mcp_financebuddy_reports_edit_consistency_draft", { operation: "followups-update", ...context, check_id: "issue", followup_operation: "save", expected_revision: 0, expected_binding_sha256: sha, owner: "TEST ONLY owner", due_date: null, evidence_reference: "", note: "" });
  });
  it("returns historical state only when explicitly requested and rejects it as current", async () => {
    const call = vi.fn(async () => ({ ...state, binding_status: "historical_unvalidated" })), api = new FinanceReaderApi(call);
    expect(await api.request({ action: "consistency-followups", ...context, history_only: true })).toHaveProperty("binding_status", "historical_unvalidated");
    await expect(api.request({ action: "consistency-followups", ...context })).rejects.toMatchObject({ status: 409 });
    call.mockClear(); await expect(api.request({ ...write, history_only: true })).rejects.toThrow("Invalid report reader request"); expect(call).not.toHaveBeenCalled();
  });
  it("refuses context substitution and typed stale-binding responses", async () => {
    const call = vi.fn().mockResolvedValueOnce({ ...state, version_id: "d".repeat(32) }).mockResolvedValueOnce({ status: "followup_conflict", message: "Source changed; saved history retained" }), api = new FinanceReaderApi(call);
    await expect(api.request({ action: "consistency-followups", ...context })).rejects.toMatchObject({ status: 409 });
    await expect(api.request(write)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a write response with another binding or unrelated revision", async () => {
    for (const extra of [{ binding_sha256: "d".repeat(64) }, { revision: 7 }]) {
      const api = new FinanceReaderApi(vi.fn(async () => ({ ...state, ...extra })));
      await expect(api.request(write)).rejects.toMatchObject({ status: 409 });
    }
  });
  it("returns the premature-verification reason as controlled 400 from the fixed tool", async () => {
    const message = "請先儲存並標示已收到證據，再另行核實；核實時不能同時修改資料。";
    const call = vi.fn(async () => JSON.stringify({ status: "followup_invalid", message }));
    const api = new FinanceReaderApi(call);
    await expect(api.request({ ...write, operation: "verify", evidence_reference: "TEST ONLY unreceived evidence", reviewer: "TEST ONLY reviewer" })).rejects.toMatchObject({ status: 400, message });
    expect(call).toHaveBeenCalledWith("mcp_financebuddy_reports_edit_consistency_draft", expect.objectContaining({ operation: "followups-update", followup_operation: "verify", expected_revision: 0 }));
  });
  it("returns a bounded error for malformed service state rather than exposing schema internals", async () => {
    const api = new FinanceReaderApi(vi.fn(async () => ({ ...state, revision: 7 })));
    await expect(api.request({ action: "consistency-followups", ...context })).rejects.toMatchObject({ status: 502, message: "跟進服務回應無效，請重新載入。" });
    await expect(new FinanceReaderApi(vi.fn(async () => null)).request(write)).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ verified_at: "forged" }, { apiKey: "untrusted" }, { owner: "" }, { reviewer: "forged" }])("rejects invalid/unsolicited fields before calling any business tool %#", async extra => {
    const call = vi.fn(), api = new FinanceReaderApi(call);
    await expect(api.request({ ...write, ...extra })).rejects.toThrow("Invalid report reader request"); expect(call).not.toHaveBeenCalled();
  });
  it("returns revision-bound CSV text without granting arbitrary file downloads", async () => {
    const receipt = { file_name: "FinanceBuddy-followups-2031-32.csv", mime: "text/csv;charset=utf-8", text: "\ufeff項目,負責人\r\nTEST ONLY,TEST ONLY\r\n", revision: 0, binding_sha256: sha };
    const call = vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, revision: 1 }), api = new FinanceReaderApi(call);
    const input = { action: "consistency-followups-export", ...context, expected_revision: 0, expected_binding_sha256: sha, check_ids: ["issue"] };
    expect(await api.request(input)).toEqual(receipt); expect(call).toHaveBeenLastCalledWith("mcp_financebuddy_reports_edit_consistency_draft", { operation: "followups-export", ...context, expected_revision: 0, expected_binding_sha256: sha, check_ids: ["issue"] });
    await expect(api.request(input)).rejects.toMatchObject({ status: 409 });
  });
});
