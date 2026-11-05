// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { ConsistencyFollowups, ConsistencyReport, FinanceProject, FinanceRequest, FinanceReviewBinding } from "@memmy/local-api-contracts";
import { ConsistencyFollowupCard, useConsistencyFollowups, type ConsistencyFollowupContext } from "../consistency-followups.js";
import { FinanceWorkspace } from "../finance-workspace.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const context: ConsistencyFollowupContext = { project_id: "a".repeat(32), version_id: "b".repeat(32), run_id: "20310101T000000-aabbccdd" };
function reportOf(run = context.run_id, sha = "a".repeat(64)): ConsistencyReport {
  return { schema_version: "financebuddy-consistency-1", run_id: run, created_at: "2031-01-01", fiscal_year: "2031/32", comparisons: ["internal"], history: { status: "not_requested", fiscal_year: "2030/31", source: "TEST ONLY" },
    documents: [{ slot: "esg_en", label: "TEST ONLY English ESG", file_name: "same-name.pdf", sha256: sha, page_count: 2, cover_year_found: true, identity_confirmed: true, textless_pages: [] }],
    checks: ["fuel", "waste"].map(id => ({ id, category: "internal", status: "difference", title: `TEST ONLY ${id}`, reason: "請補充實際工作底稿。", reader_copy: { title: id, problem: "尚欠依據。", next_step: "請提供工作底稿。", action_kind: "supplement" }, refs: [{ slot: "esg_en", page: 2, quote: `TEST ONLY ${id} evidence question` }] })),
    coverage: { scanned_pages: 2, page_pairs: 0, same_numeric_inventory_pages: 0, metric_checks: 0, numeric_facts: 0, matched: 0, differences: 2, pending: 0, historical_pages: 0, internal_checks: 2, restatement_checks: 0 }, all_numbers_confirmed: false, all_basis_confirmed: false, limits: [] };
}
function storeOf(report = reportOf(), ids = context): ConsistencyFollowups {
  return { schema_version: "financebuddy-followups-1", ...ids, binding_status: "current", binding_sha256: "1".repeat(64), base_report_sha256: "2".repeat(64), review_sha256: "3".repeat(64), source_sha256: Object.fromEntries(report.documents.map(doc => [doc.slot, doc.sha256])), revision: 0,
    issues: Object.fromEntries(report.checks.map((check, index) => [check.id, { check_id: check.id, issue_sha256: String(index + 4).repeat(64), title: check.title, category: check.category, refs: check.refs.map(ref => ({ ...ref, source_sha256: report.documents[0]!.sha256 })) }])), records: {}, history: [] };
}
function service(initial = storeOf()) {
  let saved = structuredClone(initial);
  const request = vi.fn(async (input: FinanceRequest): Promise<unknown> => {
    if (input.action === "consistency-followups") return structuredClone({ ...saved, ...(input.history_only ? { binding_status: "historical_unvalidated" } : {}) });
    if (input.action === "consistency-followups-export") return { file_name: "FinanceBuddy-followups-2031-32.csv", mime: "text/csv;charset=utf-8", text: Object.values(saved.records).map(record => `${record.check_id},${record.owner},${record.note}`).join("\r\n"), revision: saved.revision, binding_sha256: saved.binding_sha256 };
    if (input.action !== "consistency-followup-update") throw new Error("Unexpected action");
    const previous = saved.records[input.check_id] ?? null;
    const changed = previous && ["owner", "due_date", "evidence_reference", "note"].some(key => (previous as any)[key] !== (input as any)[key]);
    const record = { check_id: input.check_id, issue_sha256: saved.issues[input.check_id]!.issue_sha256, owner: input.owner, due_date: input.due_date, evidence_reference: input.evidence_reference, note: input.note,
      status: input.operation === "verify" ? "verified" : input.operation === "receive" ? "received_pending_review" : input.operation === "reopen" || previous?.status === "verified" && changed || previous?.status === "received_pending_review" && previous.evidence_reference !== input.evidence_reference ? "reopened" : previous?.status ?? "awaiting",
      reviewer: input.operation === "verify" ? input.reviewer! : null, verified_at: input.operation === "verify" ? "2031-01-01T01:02:03Z" : null, updated_at: "2031-01-01T01:02:03Z" } as ConsistencyFollowups["records"][string];
    saved = { ...saved, revision: saved.revision + 1, records: { ...saved.records, [input.check_id]: record }, history: [...saved.history, { revision: saved.revision + 1, check_id: input.check_id, operation: input.operation, at: record.updated_at, previous, record }] };
    return structuredClone(saved);
  });
  return { request, get saved() { return saved; } };
}
function Harness({ report = reportOf(), ids = context, selected = "fuel", request }: { report?: ConsistencyReport; ids?: ConsistencyFollowupContext; selected?: string; request: (input: FinanceRequest) => Promise<unknown> }) {
  const followups = useConsistencyFollowups(report, ids, request);
  return <ConsistencyFollowupCard check={report.checks.find(check => check.id === selected)!} followups={followups} />;
}
async function mount(element: React.ReactNode) {
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(element));
  return { div, root, close() { act(() => root.unmount()); div.remove(); } };
}
const button = (div: HTMLElement, text: string) => Array.from(div.querySelectorAll("button")).find(candidate => candidate.textContent === text)!;
const field = (div: HTMLElement, label: string) => div.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
async function fill(div: HTMLElement, label: string, value: string) {
  await act(async () => { const input = field(div, label); Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function click(div: HTMLElement, text: string) { await act(async () => button(div, text).click()); }

describe("Source-bound evidence follow-up", () => {
  it("requires explicit project/version/run context and never guesses it from the filename", async () => {
    const report = reportOf(), request = vi.fn();
    function Unknown() { const followups = useConsistencyFollowups(report, undefined, request); return <ConsistencyFollowupCard check={report.checks[0]!} followups={followups} />; }
    const view = await mount(<Unknown />);
    try { expect(view.div.textContent).toContain("項目版本未確認"); expect(field(view.div, "補料負責人")).toBeNull(); expect(request).not.toHaveBeenCalled(); }
    finally { view.close(); }
    const mismatched = await mount(<Harness request={request} ids={{ ...context, run_id: "20310102T000000-aabbccdd" }} />);
    try { expect(mismatched.div.textContent).toContain("項目版本未確認"); expect(request).not.toHaveBeenCalled(); } finally { mismatched.close(); }
  });

  it("saves user assignment, receives separately, verifies explicitly and retains history on reopening", async () => {
    const api = service(), view = await mount(<Harness request={api.request} />);
    try {
      expect(field(view.div, "補料負責人").value).toBe(""); expect(button(view.div, "保存跟進").disabled).toBe(true);
      await fill(view.div, "補料負責人", "TEST ONLY preparer"); await fill(view.div, "補料預計日期", "2031-01-15"); await click(view.div, "保存跟進");
      expect(api.request).toHaveBeenLastCalledWith({ action: "consistency-followup-update", ...context, check_id: "fuel", expected_revision: 0, expected_binding_sha256: "1".repeat(64), operation: "save", owner: "TEST ONLY preparer", due_date: "2031-01-15", evidence_reference: "", note: "" });
      expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("待補料"); expect(button(view.div, "收到資料，待覆核").disabled).toBe(true);
      await fill(view.div, "補料證據", "TEST ONLY workpaper A, page 2"); await fill(view.div, "補料跟進備註", "TEST ONLY supplied evidence, not reviewed"); await click(view.div, "收到資料，待覆核");
      expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("已收到，待覆核"); expect(view.div.textContent).toContain("未視為已解決"); expect(api.saved.records.fuel?.verified_at).toBeNull();
      expect(button(view.div, "核實完成").disabled).toBe(true); await fill(view.div, "補料覆核人", "TEST ONLY reviewer");
      await fill(view.div, "補料跟進備註", "TEST ONLY changed after receipt"); expect(button(view.div, "核實完成").disabled).toBe(true);
      await click(view.div, "保存跟進"); await fill(view.div, "補料覆核人", "TEST ONLY reviewer"); await click(view.div, "核實完成");
      const verify = api.request.mock.calls.map(([input]) => input).find(input => input.action === "consistency-followup-update" && input.operation === "verify")!;
      expect(verify).toMatchObject({ ...context, operation: "verify", reviewer: "TEST ONLY reviewer", evidence_reference: "TEST ONLY workpaper A, page 2", expected_revision: 3 }); expect(verify).not.toHaveProperty("verified_at");
      expect(view.div.querySelector(".consistency-followup-status--verified")?.textContent).toBe("已核實"); expect(view.div.textContent).toContain("2031-01-01T01:02:03Z");
      await fill(view.div, "補料跟進備註", "TEST ONLY new doubt"); expect(view.div.textContent).toContain("保存變更後會重新開啟"); await click(view.div, "保存跟進");
      expect(api.saved.records.fuel).toMatchObject({ status: "reopened", reviewer: null, verified_at: null }); expect(api.saved.history.find(entry => entry.operation === "verify")?.record.reviewer).toBe("TEST ONLY reviewer");
      expect(view.div.querySelector(".consistency-followup-history")?.textContent).toContain("TEST ONLY reviewer");
      expect(api.request.mock.calls.every(([input]) => input.action.startsWith("consistency-followup"))).toBe(true);
    } finally { view.close(); }
    const reopened = await mount(<Harness request={api.request} />);
    try { expect(field(reopened.div, "補料負責人").value).toBe("TEST ONLY preparer"); expect(field(reopened.div, "補料跟進備註").value).toBe("TEST ONLY new doubt"); expect(reopened.div.querySelector(".consistency-followup-status--reopened")).not.toBeNull(); } finally { reopened.close(); }
  });

  it("retains separate unsaved issue drafts and does not inherit assignment or verification into a new version", async () => {
    const api = service(), report = reportOf(), view = await mount(<Harness report={report} request={api.request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY fuel draft");
      await act(async () => view.root.render(<Harness report={report} request={api.request} selected="waste" />));
      expect(field(view.div, "補料負責人").value).toBe(""); await fill(view.div, "補料負責人", "TEST ONLY waste draft");
      await act(async () => view.root.render(<Harness report={report} request={api.request} />)); expect(field(view.div, "補料負責人").value).toBe("TEST ONLY fuel draft");
      const nextReport = reportOf("20310102T000000-aabbccdd", "f".repeat(64)), nextIds = { ...context, version_id: "c".repeat(32), run_id: nextReport.run_id }, nextApi = service({ ...storeOf(nextReport, nextIds), binding_sha256: "9".repeat(64) });
      await act(async () => view.root.render(<Harness report={nextReport} ids={nextIds} request={nextApi.request} />));
      expect(field(view.div, "補料負責人").value).toBe(""); expect(view.div.querySelector(".consistency-followup-status--verified")).toBeNull(); expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("尚未指派");
      expect(nextApi.request).toHaveBeenCalledWith({ action: "consistency-followups", ...nextIds });
    } finally { view.close(); }
  });

  it("shows a save acknowledgment only on its finding and clears it when a new draft is edited", async () => {
    const api = service(), report = reportOf(), view = await mount(<Harness report={report} request={api.request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY saved fuel owner"); await click(view.div, "保存跟進");
      expect(view.div.querySelector('p[role="status"]')?.textContent).toBe("跟進已保存。");
      await act(async () => view.root.render(<Harness report={report} request={api.request} selected="waste" />));
      expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("尚未指派"); expect(view.div.textContent).not.toContain("跟進已保存。");
      await act(async () => view.root.render(<Harness report={report} request={api.request} />));
      await fill(view.div, "補料跟進備註", "TEST ONLY unsaved new draft");
      expect(view.div.textContent).not.toContain("跟進已保存。"); expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("待補料"); expect(api.saved.records.fuel?.note).toBe("");
    } finally { view.close(); }
  });

  it("clears the previous acknowledgment while the next explicit operation is saving", async () => {
    const api = service(); let holdReceipt = false, releaseReceipt!: () => void;
    const request = vi.fn(async (input: FinanceRequest) => { if (holdReceipt && input.action === "consistency-followup-update" && input.operation === "receive") await new Promise<void>(resolve => { releaseReceipt = resolve; }); return api.request(input); });
    const view = await mount(<Harness request={request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY receipt owner"); await fill(view.div, "補料證據", "TEST ONLY received file"); await click(view.div, "保存跟進");
      expect(view.div.querySelector('p[role="status"]')?.textContent).toBe("跟進已保存。"); holdReceipt = true;
      await click(view.div, "收到資料，待覆核"); expect(view.div.textContent).not.toContain("跟進已保存。"); expect(button(view.div, "收到資料，待覆核").disabled).toBe(true); expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("待補料");
      await act(async () => releaseReceipt()); expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("已收到，待覆核");
    } finally { view.close(); }
  });

  it("clears current verification on binding failure, retains the draft and offers strictly read-only history", async () => {
    const initial = storeOf(), verified = { check_id: "fuel", issue_sha256: initial.issues.fuel!.issue_sha256, owner: "TEST ONLY original", due_date: null, evidence_reference: "TEST ONLY old evidence", note: "", status: "verified", reviewer: "TEST ONLY prior reviewer", verified_at: "2031-01-01T00:00:00Z", updated_at: "2031-01-01T00:00:00Z" } as const;
    initial.records.fuel = verified; initial.revision = 1; initial.history = [{ revision: 1, check_id: "fuel", operation: "verify", at: verified.verified_at, previous: null, record: verified }];
    let stale = false;
    const request = vi.fn(async (input: FinanceRequest) => {
      if (input.action === "consistency-followup-update") { stale = true; throw new Error("409 source binding changed"); }
      if (input.action === "consistency-followups" && input.history_only) return { ...initial, binding_status: "historical_unvalidated" };
      if (stale) throw new Error("409 source binding changed"); return initial;
    });
    const view = await mount(<Harness request={request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY retained draft"); await click(view.div, "保存跟進");
      expect(field(view.div, "補料負責人").value).toBe("TEST ONLY retained draft"); expect(view.div.querySelector(".consistency-followup-status--verified")).toBeNull(); expect(view.div.textContent).toContain("你的草稿已保留"); expect(field(view.div, "補料負責人").disabled).toBe(true);
      await click(view.div, "只讀舊紀錄"); expect(view.div.textContent).toContain("只讀舊紀錄：尚未核實目前來源"); expect(field(view.div, "補料負責人").disabled).toBe(true); expect(view.div.querySelector(".consistency-followup-status--verified")).toBeNull();
      expect(button(view.div, "保存跟進")).toBeUndefined(); expect(button(view.div, "核實完成")).toBeUndefined(); expect(view.div.textContent).not.toContain("匯出本輪已保存補料 CSV"); expect(view.div.textContent).toContain("TEST ONLY prior reviewer");
      expect(request).toHaveBeenLastCalledWith({ action: "consistency-followups", ...context, history_only: true });
    } finally { view.close(); }
  });

  it("ignores late responses from another run and refuses a server response with mismatched context", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldRequest = vi.fn(() => new Promise<unknown>(resolve => { resolveOld = resolve; })), view = await mount(<Harness request={oldRequest} />);
    try {
      const nextReport = reportOf("20310102T000000-aabbccdd"), nextIds = { ...context, project_id: "d".repeat(32), version_id: "c".repeat(32), run_id: nextReport.run_id }, api = service(storeOf(nextReport, nextIds));
      await act(async () => view.root.render(<Harness report={nextReport} ids={nextIds} request={api.request} />));
      await act(async () => resolveOld(storeOf())); await fill(view.div, "補料負責人", "TEST ONLY new project"); await click(view.div, "保存跟進");
      expect(api.request).toHaveBeenLastCalledWith(expect.objectContaining({ ...nextIds, operation: "save" })); expect(view.div.querySelector(".consistency-followup-binding > code")?.textContent).not.toContain(`項目 ${context.project_id}`);
      const wrong = vi.fn(async () => storeOf());
      await act(async () => view.root.render(<Harness report={nextReport} ids={nextIds} request={wrong} />));
      expect(view.div.textContent).toContain("項目或版本不符"); expect(view.div.querySelector(".consistency-followup-status--verified")).toBeNull(); expect(field(view.div, "補料負責人").disabled).toBe(true);
    } finally { view.close(); }
  });

  it.each(["binding", "issue"] as const)("does not reuse a draft after the exact %s identity changes", async identity => {
    let saved = storeOf();
    const request = vi.fn(async () => structuredClone(saved)), view = await mount(<Harness request={request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY prior source draft");
      saved = identity === "binding" ? { ...saved, binding_sha256: "8".repeat(64) } : { ...saved, issues: { ...saved.issues, fuel: { ...saved.issues.fuel!, issue_sha256: "8".repeat(64) } } };
      await click(view.div, "重新載入跟進");
      expect(field(view.div, "補料負責人").value).toBe(""); expect(view.div.querySelector("summary .consistency-followup-status")?.textContent).toBe("尚未指派");
      expect(request.mock.calls.every(([input]: any) => input.action === "consistency-followups")).toBe(true);
    } finally { view.close(); }
  });

  it("refuses a current response whose source hashes differ from the opened report", async () => {
    const saved = storeOf(); saved.source_sha256.esg_en = "f".repeat(64);
    Object.values(saved.issues).forEach(issue => { issue.refs = issue.refs.map(ref => ({ ...ref, source_sha256: "f".repeat(64) })); });
    const request = vi.fn(async () => saved), view = await mount(<Harness request={request} />);
    try {
      expect(view.div.textContent).toContain("報告來源已變更"); expect(view.div.querySelector(".consistency-followup-status--verified")).toBeNull(); expect(field(view.div, "補料負責人")).toBeNull();
      expect(request).toHaveBeenCalledOnce();
    } finally { view.close(); }
  });

  it("reloads the binding when the issue changes under the same run and source hashes", async () => {
    const report = reportOf(); let saved = storeOf(report);
    const request = vi.fn(async () => structuredClone(saved)), view = await mount(<Harness report={report} request={request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY old issue draft");
      const changed = { ...report, checks: report.checks.map(check => check.id === "fuel" ? { ...check, reason: "TEST ONLY corrected evidence requirement", refs: [{ ...check.refs[0]!, quote: "TEST ONLY changed source quotation" }] } : check) };
      saved = { ...storeOf(changed), binding_sha256: "9".repeat(64) };
      await act(async () => view.root.render(<Harness report={changed} request={request} />));
      expect(request).toHaveBeenCalledTimes(2); expect(field(view.div, "補料負責人").value).toBe(""); expect(view.div.textContent).toContain("TEST ONLY changed source quotation");
    } finally { view.close(); }
  });

  it("requires explicit receipt again after saved evidence changes and supports manual reopening", async () => {
    const api = service(), view = await mount(<Harness request={api.request} />);
    try {
      await fill(view.div, "補料負責人", "TEST ONLY preparer"); await fill(view.div, "補料證據", "TEST ONLY received file"); await click(view.div, "收到資料，待覆核");
      await fill(view.div, "補料證據", ""); await click(view.div, "保存跟進");
      expect(view.div.querySelector(".consistency-followup-status--reopened")).not.toBeNull(); expect(button(view.div, "核實完成")).toBeUndefined(); expect(button(view.div, "收到資料，待覆核").disabled).toBe(true);
      await fill(view.div, "補料證據", "TEST ONLY replacement file"); await click(view.div, "保存跟進"); expect(button(view.div, "核實完成")).toBeUndefined();
      await click(view.div, "收到資料，待覆核"); expect(button(view.div, "核實完成").disabled).toBe(true); await click(view.div, "重新開啟");
      expect(api.saved.records.fuel?.status).toBe("reopened"); expect(api.saved.history.map(entry => entry.operation)).toEqual(["receive", "save", "save", "receive", "reopen"]);
    } finally { view.close(); }
  });

  it("exports all saved issues in one CSV using the exact run revision and binding, excluding unsaved drafts", async () => {
    const api = service(), report = reportOf(), view = await mount(<Harness report={report} request={api.request} />);
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-only"), anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      expect(button(view.div, "匯出本輪已保存補料 CSV（0項）").disabled).toBe(true);
      await fill(view.div, "補料負責人", "TEST ONLY fuel CSV owner"); await click(view.div, "保存跟進");
      await act(async () => view.root.render(<Harness report={report} request={api.request} selected="waste" />)); await fill(view.div, "補料負責人", "TEST ONLY waste CSV owner"); await click(view.div, "保存跟進");
      await fill(view.div, "補料跟進備註", "TEST ONLY unsaved, not in export"); await click(view.div, "匯出本輪已保存補料 CSV（2項）");
      expect(api.request).toHaveBeenLastCalledWith({ action: "consistency-followups-export", ...context, expected_revision: 2, expected_binding_sha256: "1".repeat(64) });
      expect(objectUrl).toHaveBeenCalledOnce(); expect(anchor).toHaveBeenCalledOnce(); expect(field(view.div, "補料跟進備註").value).toBe("TEST ONLY unsaved, not in export");
      const csv = await (objectUrl.mock.calls[0]![0] as Blob).text(); expect(csv).toContain("fuel,TEST ONLY fuel CSV owner"); expect(csv).toContain("waste,TEST ONLY waste CSV owner"); expect(csv).not.toContain("unsaved");
    } finally { objectUrl.mockRestore(); anchor.mockRestore(); view.close(); }
  });
});

describe("Workspace follow-up project identity", () => {
  const project = (id: string, versions = ["c".repeat(32)]): FinanceProject => ({ id, title: `TEST ONLY ${id}`, external_id: null, revision: 1, latest_run: context.run_id, active_version: versions.at(-1), created_at: "2031-01-01", updated_at: "2031-01-01", versions: versions.map(id => ({ id, fiscal_year: "2031/32", created_at: "2031-01-01", runs: [context.run_id], documents: [] })) });
  const binding = (project_id: string): FinanceReviewBinding => ({ project_id, native_project_id: `TEST ONLY ${project_id}`, run_id: context.run_id, session_key: `websocket:fin_${project_id}`, chat_id: `fin_${project_id}` });
  const viewOf = (client: MemmyAgentClient, initialReview: FinanceReviewBinding) => <FinanceWorkspace visible client={client} initialPath={null} initialReview={initialReview} workflow={null} busy={false} onChoose={() => {}} onLaunch={async () => {}} onClose={() => {}} />;
  const clientOf = (request: (input: FinanceRequest) => Promise<unknown>) => ({ financeReaderRequest: request, getFinanceCatalog: async () => ({ reviews: [], unavailable: [], scope: "TEST ONLY" }) }) as unknown as MemmyAgentClient;
  function normalResponse(input: FinanceRequest, report: ConsistencyReport) {
    if (input.action === "consistency-read") return report;
    if (input.action === "consistency-editor") return { run_id: report.run_id, base_sha256: "a".repeat(64), revision: 0, proposals: {}, decisions: {}, history: [] };
    if (input.action === "consistency-followups") return storeOf(report, { project_id: input.project_id, version_id: input.version_id, run_id: input.run_id });
    return { data_url: "data:image/png;base64,AA==" };
  }

  it("reads and saves only the explicitly opened project when another project contains the same run", async () => {
    const report = reportOf(), selected = project("b".repeat(32)), other = project("a".repeat(32)), api = service(storeOf(report, { project_id: selected.id, version_id: selected.versions[0]!.id, run_id: report.run_id }));
    const request = vi.fn(async (input: FinanceRequest) => input.action === "project-list" ? { projects: [other, selected] } : input.action.startsWith("consistency-followup") ? api.request(input) : normalResponse(input, report));
    const view = await mount(viewOf(clientOf(request), binding(selected.id)));
    try {
      expect(request.mock.calls.filter(([input]) => input.action === "consistency-followups").map(([input]) => input)).toEqual([{ action: "consistency-followups", project_id: selected.id, version_id: selected.versions[0]!.id, run_id: report.run_id }]);
      await fill(view.div, "補料負責人", "TEST ONLY correct project preparer"); await click(view.div, "保存跟進");
      expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: "consistency-followup-update", project_id: selected.id, version_id: selected.versions[0]!.id, run_id: report.run_id }));
    } finally { view.close(); }
  });

  it.each(["missing-project", "duplicate-versions"] as const)("keeps follow-up disabled for %s instead of guessing another membership or active version", async mode => {
    const report = reportOf(), id = "b".repeat(32), selected = project(id, ["c".repeat(32), "d".repeat(32)]), other = project("a".repeat(32));
    const request = vi.fn(async (input: FinanceRequest) => input.action === "project-list" ? { projects: mode === "missing-project" ? [other] : [other, selected] } : normalResponse(input, report));
    const view = await mount(viewOf(clientOf(request), binding(id)));
    try {
      expect(request.mock.calls.some(([input]) => input.action.startsWith("consistency-followup"))).toBe(false); expect(view.div.textContent).toContain("項目版本未確認"); expect(field(view.div, "補料負責人")).toBeNull();
      expect(view.div.querySelector(".consistency-reader")).not.toBeNull();
    } finally { view.close(); }
  });

  it("drops the previous project's context while a same-run project switch waits for metadata", async () => {
    const report = reportOf(), a = project("a".repeat(32)), b = project("b".repeat(32)); let delayed = false, resolveProjects!: (value: unknown) => void;
    const request = vi.fn(async (input: FinanceRequest) => input.action === "project-list" ? delayed ? new Promise(resolve => { resolveProjects = resolve; }) : { projects: [a, b] } : normalResponse(input, report));
    const client = clientOf(request), view = await mount(viewOf(client, binding(a.id)));
    try {
      await fill(view.div, "補料負責人", "TEST ONLY project A draft"); request.mockClear(); delayed = true;
      await act(async () => view.root.render(viewOf(client, binding(b.id))));
      expect(field(view.div, "補料負責人")).toBeNull(); expect(view.div.textContent).toContain("項目版本未確認"); expect(request.mock.calls.some(([input]) => input.action.startsWith("consistency-followup"))).toBe(false);
      await act(async () => resolveProjects({ projects: [a, b] }));
      expect(field(view.div, "補料負責人").value).toBe(""); expect(request.mock.calls.filter(([input]) => input.action === "consistency-followups").map(([input]) => input)).toEqual([{ action: "consistency-followups", project_id: b.id, version_id: b.versions[0]!.id, run_id: report.run_id }]);
    } finally { view.close(); }
  });

  it.each(["Escape", "close-button"] as const)("returns from the same-version files detour with %s, restoring visible files-button focus and all drafts without duplicate reads", async closeWith => {
    const report = reportOf(); report.documents = ["esg_zh", "esg_en"].map(slot => ({ ...report.documents[0]!, slot: slot as "esg_zh" | "esg_en", label: `TEST ONLY ${slot}`, page_count: 8 }));
    report.checks = report.checks.map(check => ({ ...check, refs: [{ slot: "esg_zh", page: 3, quote: `TEST ONLY ${check.id} source` }, { slot: "esg_en", page: 3, quote: `TEST ONLY ${check.id} English source` }] }));
    const selected = project(context.project_id), version = selected.versions[0]!; version.documents = report.documents.map(doc => ({ slot: doc.slot as "esg_zh" | "esg_en", file_name: doc.file_name, sha256: doc.sha256, bytes: 100 })); version.reviews = [{ run_id: report.run_id, kind: "consistency", status: "partial" }];
    const api = service(storeOf(report, { ...context, version_id: version.id })), launch = vi.fn(), close = vi.fn();
    const request = vi.fn(async (input: FinanceRequest) => input.action === "project-list" ? { projects: [selected] } : input.action === "input-knowledge" ? { entity_id: "yeebo", entity_name: "TEST ONLY", observed_at: "2031-01-01", catalog_revision: "TEST ONLY", documents: [] } : input.action.startsWith("consistency-followup") ? api.request(input) : normalResponse(input, report));
    const client = clientOf(request), initialReview = binding(selected.id);
    function Parent() {
      const [visible, setVisible] = useState(true), [workflow, setWorkflow] = useState<"consistency" | "review" | null>(null);
      return <><button onClick={() => setVisible(true)}>TEST ONLY reopen workspace</button><FinanceWorkspace visible={visible} client={client} initialPath={null} initialReview={initialReview} workflow={workflow} busy={false} onChoose={value => setWorkflow(value as typeof workflow)} onLaunch={launch} onClose={() => { close(); setVisible(false); setWorkflow(null); }} /></>;
    }
    const view = await mount(<Parent />), objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-only-route"), anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await act(async () => Array.from(view.div.querySelectorAll<HTMLButtonElement>(".consistency-check")).find(item => item.title === "waste")!.click());
      await fill(view.div, "補料負責人", "TEST ONLY saved route owner"); await fill(view.div, "補料跟進備註", "TEST ONLY saved route note"); await click(view.div, "保存跟進"); await fill(view.div, "補料跟進備註", "TEST ONLY unsaved route draft");
      await click(view.div, "詳細／建議"); await fill(view.div, "追問此項", "TEST ONLY unsent route question"); const question = field(view.div, "追問此項");
      await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="關閉問題詳情"]')!.click());
      const source = view.div.querySelector<HTMLSelectElement>('[aria-label="引用文件"]')!;
      await act(async () => { source.value = "esg_en"; source.dispatchEvent(new Event("change", { bubbles: true })); }); await fill(view.div, "引用 PDF 頁碼", "6");
      const reader = view.div.querySelector(".consistency-reader")!, draft = field(view.div, "補料跟進備註"), page = field(view.div, "引用 PDF 頁碼"), trigger = button(view.div, "文件與檢查記錄");
      const callsBeforeDetour = request.mock.calls.filter(([input]) => input.action.startsWith("consistency-")).length;
      trigger.focus(); await click(view.div, "文件與檢查記錄");
      expect(reader.isConnected).toBe(true); expect(reader.closest("[hidden][inert]")).not.toBeNull(); expect(source.isConnected).toBe(true); expect(draft.value).toBe("TEST ONLY unsaved route draft"); expect(trigger.isConnected).toBe(true); expect(trigger.hidden).toBe(true); expect(trigger.style.display).toBe("none");
      const versions = view.div.querySelector<HTMLSelectElement>('[aria-label="項目報告版本"]')!; expect(versions.value).toBe(version.id); versions.focus();
      if (closeWith === "Escape") await act(async () => versions.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      else await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="關閉工作台"]')!.click());
      expect(view.div.querySelector(".consistency-reader")).toBe(reader); expect(view.div.querySelector(".consistency-check.selected")?.getAttribute("title")).toBe("waste"); expect(source.value).toBe("esg_en"); expect(page.value).toBe("6"); expect(field(view.div, "補料跟進備註")).toBe(draft); expect(draft.value).toBe("TEST ONLY unsaved route draft");
      expect(request.mock.calls.filter(([input]) => input.action.startsWith("consistency-"))).toHaveLength(callsBeforeDetour); expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger); expect(trigger.hidden).toBe(false); expect(reader.closest("[hidden], [inert]")).toBeNull();
      await click(view.div, "詳細／建議"); expect(field(view.div, "追問此項").value).toBe(question.value); expect(question.value).toBe("TEST ONLY unsent route question"); await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="關閉問題詳情"]')!.click());
      await click(view.div, "匯出本輪已保存補料 CSV（1項）"); const csv = await (objectUrl.mock.calls[0]![0] as Blob).text(); expect(csv).toContain("TEST ONLY saved route note"); expect(csv).not.toContain("TEST ONLY unsaved route draft"); expect(launch).not.toHaveBeenCalled();
    } finally { objectUrl.mockRestore(); anchor.mockRestore(); view.close(); }
  });
});
