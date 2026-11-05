// @vitest-environment happy-dom
// Contract-driven component mocks. These do not prove actual PDF parsing, KB access or live saving.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinanceProject, InputInspection, InputKnowledge, KnowledgeDocument } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { FinanceProjectSetup } from "../finance-project-setup.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const pid = "a".repeat(32), vid = "b".repeat(32);
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const identified = (value: string) => ({ status: "identified" as const, value, evidence: [{ page: 2, quote: `TEST ONLY original statement: ${value}` }] });
function inspection(overrides: Partial<InputInspection> = {}): InputInspection {
  return { file_name: "misleading-name.pdf", sha256: "a".repeat(64), bytes: 10, pages: 3, fields: { issuer: identified("yeebo"), fiscal_year: identified("2026/27"), kind: identified("esg"), language: identified("en") }, supported: true, test_only: true, scan_pages: [1, 2], limits: [], inspection_id: "00000000-0000-4000-8000-000000000001", ...overrides };
}
function doc(year: string, kind: "esg" | "annual" = "esg", language: "en" | "zh-Hant" = "en", overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return { source_id: `S-${year}-${kind}-${language}`, file_name: `${year}-${kind}-${language}.pdf`, sha256: "c".repeat(64), fiscal_year: year, kind, language, original_status: "verified", indexed_status: "verified", ...overrides };
}
function knowledge(documents = [doc("2025/26"), doc("2025/26", "annual"), doc("2024/25"), doc("2023/24", "annual", "zh-Hant")]): InputKnowledge { return { entity_id: "yeebo", entity_name: "億都（Yeebo）", observed_at: "2026-11-04", catalog_revision: "mock", documents }; }
function project(): FinanceProject { return { id: pid, title: "Saved project", external_id: null, revision: 1, active_version: vid, latest_run: null, created_at: "2026-11-04", updated_at: "2026-11-04", versions: [{ id: vid, fiscal_year: "2026/27", created_at: "2026-11-04", runs: [], documents: [{ slot: "esg_en", file_name: "old-esg.pdf", sha256: "d".repeat(64), bytes: 10 }, { slot: "annual_en", file_name: "retained-annual.pdf", sha256: "e".repeat(64), bytes: 20 }] }] }; }
async function select(names: string[]) { const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(picker, "files", { configurable: true, value: names.map(name => new File(["%PDF mock"], name, { type: "application/pdf" })) }); await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true }))); }
async function change(label: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { const prototype = input.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLSelectElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input.tagName === "INPUT" ? "input" : "change", { bubbles: true })); }); }
type Options = { inspect?: (input: any) => Promise<InputInspection>; knowledge?: (input: any) => Promise<InputKnowledge>; request?: (input: any) => Promise<unknown>; selected?: boolean; context?: { id: string; name: string } };
async function render(options: Options = {}) {
  const upload = vi.fn(async (inputs: any[]) => inputs.map((input: any) => ({ kind: "file", mime: "application/pdf", path: `/local/${input.name}`, url: `http://127.0.0.1/mock/${input.name}` })));
  const request = vi.fn(async (input: any): Promise<unknown> => {
    if (input.action === "input-knowledge") return options.knowledge ? options.knowledge(input) : knowledge();
    if (input.action === "input-inspect") return options.inspect ? options.inspect(input) : inspection();
    if (input.action === "project-list") return { projects: [project()] };
    if (options.request) return options.request(input);
    if (input.action === "project-create") return { ...project(), revision: 0, active_version: undefined, versions: [] };
    if (input.action === "project-save") return project();
    throw Error(`Unexpected mock action ${input.action}`);
  });
  const complete = vi.fn();
  const props = { client: { uploadAgentMedia: upload } as unknown as MemmyAgentClient, request, onComplete: complete, context: options.context, ...(options.selected ? { initialSelection: { project_id: pid, version_id: vid } } : {}) };
  await act(async () => root.render(<FinanceProjectSetup {...props} />));
  return { upload, request, complete, props };
}
function expectNoWrites(request: ReturnType<typeof vi.fn>) { expect(request.mock.calls.some(([input]) => /project-create|project-save|build|start/.test(input.action))).toBe(false); }
describe("Current report identity and exact previous-year preview (component mocks)", () => {
  it("shows company and known FY/type/language before files, without binding native history or using remembered project", async () => {
    localStorage.setItem("financebuddy.project", pid); const mocks = await render();
    const panel = container.querySelector('[aria-label="歷年原稿"]')!;
    expect(panel.textContent).toContain("億都（Yeebo）"); expect(panel.textContent).toContain("FY2025/26"); expect(panel.textContent).toContain("FY2024/25"); expect(panel.textContent).toContain("FY2023/24"); expect(panel.textContent).toContain("ESG"); expect(panel.textContent).toContain("年報"); expect(panel.textContent).toContain("中文"); expect(panel.textContent).toContain("English");
    expect(mocks.request.mock.calls.map(([input]) => input.action)).toEqual(["input-knowledge"]); expect(mocks.upload).not.toHaveBeenCalled(); expect(container.querySelector(".finance-project-files")).toBeNull(); expect(container.textContent).toContain("儲存到新項目");
  });
  it("uses content FY2026/27 and exact FY2025/26 originals despite misleading filenames and older known history", async () => {
    const mocks = await render({ inspect: async input => input.file_name.includes("annual") ? inspection({ sha256: "b".repeat(64), fields: { ...inspection().fields, kind: identified("annual") } }) : inspection() });
    await select(["2023-old-file.pdf", "annual-misleading-2024.pdf"]);
    expect(container.querySelector('[aria-label="文件1財年"]')).toBeNull(); expect(container.querySelector('[aria-label="文件1報告種類"]')).toBeNull();
    expect(mocks.request).toHaveBeenCalledWith({ action: "input-knowledge", fiscal_year: "2026/27", slots: ["esg_en", "annual_en"] });
    const plan = container.querySelector('[aria-label="儲存前文件及比較預覽"]')!;
    expect(plan.textContent).toContain("今次使用 · FY2026/27"); expect(plan.textContent).toContain("同財年對照：以上 FY2026/27 ESG 與年報"); expect(plan.textContent).toContain("2025/26-esg-en.pdf"); expect(plan.textContent).toContain("2025/26-annual-en.pdf"); expect(plan.textContent).not.toContain("2024/25-esg-en.pdf"); expect(plan.textContent).toContain("原稿已核對"); expect(plan.textContent).toContain("版本 S-2025/26-esg-en"); expect(plan.textContent).toContain("SHA256 cccccccccccc");
    expect(container.querySelectorAll('.finance-input-evidence blockquote')[0]?.textContent).toContain("PDF p.2"); expectNoWrites(mocks.request);
  });
  it("labels a bundled public prior and makes it available for comparison", async () => {
    const previous = doc("2025/26", "esg", "en", { indexed_status: "local_verified" });
    const mocks = await render({ knowledge: async () => ({ ...knowledge([previous]), source_mode: "public_snapshot" }) });
    expect(container.querySelector('[aria-label="歷年原稿"]')!.textContent).toContain("億都公開報告 · 隨附版本");
    await select(["current.pdf"]);
    const plan = container.querySelector('[aria-label="儲存前文件及比較預覽"]')!;
    expect(plan.textContent).toContain("去年原稿 · FY2025/26（隨附公開報告，只讀）");
    expect(plan.textContent).toContain("隨附公開原件已核對");
    expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3]!.disabled).toBe(false);
    expectNoWrites(mocks.request);
  });
  it("does not substitute an older FY when the exact prior original is missing, and lets other checks continue", async () => {
    const mocks = await render({ knowledge: async () => knowledge([doc("2024/25")]) }); await select(["current.pdf"]);
    const plan = container.querySelector('[aria-label="儲存前文件及比較預覽"]')!; expect(plan.textContent).toContain("缺少 FY2025/26 同類同語言原稿"); expect(plan.textContent).not.toContain("2024/25-esg-en.pdf");
    const checks = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')); expect(checks[3]!.disabled).toBe(true); expect(checks[0]!.disabled).toBe(false); expect(button("儲存並開始一致性審閱").disabled).toBe(false); expectNoWrites(mocks.request);
  });
  it.each(["missing", "hash_mismatch", "unreadable", "unavailable"] as const)("exposes prior %s status without claiming the source ready", async status => {
    await render({ knowledge: async () => knowledge([doc("2025/26", "esg", "en", { original_status: status, reason: "TEST ONLY reason", indexed_status: "not_checked" })]) }); await select(["current.pdf"]);
    expect(container.querySelector(".finance-input-plan")?.textContent).toContain("TEST ONLY reason"); expect(container.querySelector(".finance-input-plan")?.textContent).toContain("讀取未確認"); expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3]!.disabled).toBe(true);
  });
  it("requests only unresolved fields, requires explicit issuer confirmation and sends it with the inspected bytes", async () => {
    const unknown = { status: "unknown" as const, value: null, evidence: [] };
    const mocks = await render({ inspect: async () => inspection({ supported: false, fields: { ...inspection().fields, issuer: unknown, fiscal_year: unknown } }) }); await select(["unknown.pdf"]);
    expect(container.querySelector('[aria-label="文件1公司"]')).not.toBeNull(); expect(container.querySelector('[aria-label="文件1財年"]')).not.toBeNull(); expect(container.querySelector('[aria-label="文件1語言"]')).toBeNull(); expect(button("只儲存文件").disabled).toBe(true);
    await change("文件1公司", "yeebo"); await change("文件1財年", "2026/27"); expect(button("只儲存文件").disabled).toBe(false);
    await act(async () => button("只儲存文件").click()); expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ action: "project-save", fiscal_year: "2026/27", documents: [{ slot: "esg_en", path: "/local/unknown.pdf", file_name: "unknown.pdf", inspection_id: inspection().inspection_id, confirmed_issuer: "yeebo" }] }));
  });
  it("blocks unsupported issuer instead of allowing a Yeebo override", async () => {
    const mocks = await render({ inspect: async () => inspection({ supported: false, fields: { ...inspection().fields, issuer: { status: "unsupported", value: "other-company", evidence: [{ page: 1, quote: "Other Company" }] } } }) }); await select(["other.pdf"]);
    expect(container.textContent).toContain("公司不在目前支援範圍"); expect(container.querySelector('[aria-label="文件1公司"]')).toBeNull(); expect(button("只儲存文件").disabled).toBe(true); expect(container.querySelector(".finance-input-plan")).toBeNull(); expectNoWrites(mocks.request);
  });
  it.each(["year", "duplicate", "slot"] as const)("blocks %s conflicts with a removal action and recovers after removal", async conflict => {
    const mocks = await render({ inspect: async input => input.file_name === "one.pdf" ? inspection() : inspection({ sha256: conflict === "duplicate" ? "a".repeat(64) : "b".repeat(64), fields: { ...inspection().fields, fiscal_year: identified(conflict === "year" ? "2025/26" : "2026/27"), kind: identified(conflict === "slot" ? "esg" : "annual") } }) });
    await select(["one.pdf", "two.pdf"]); expect(button("只儲存文件").disabled).toBe(true); expect(container.textContent).toContain(conflict === "year" ? "包含不同財年" : conflict === "duplicate" ? "有相同內容的 PDF" : "同一種類及語言有多個版本");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件2"]')!.click()); expect(button("只儲存文件").disabled).toBe(false); expectNoWrites(mocks.request);
  });
  it("shows retained and replaced active-version files before explicit save, and never uploads again", async () => {
    const mocks = await render({ selected: true }); await select(["new-esg.pdf"]);
    const plan = container.querySelector(".finance-input-plan")!; expect(plan.textContent).toContain("new-esg.pdf"); expect(plan.textContent).toContain("替換現有：old-esg.pdf；原版本保留"); expect(plan.textContent).toContain("retained-annual.pdf"); expect(plan.textContent).toContain("沿用項目現有文件");
    expectNoWrites(mocks.request); await act(async () => button("只儲存文件").click()); expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.request).toHaveBeenCalledWith({ action: "project-save", project_id: pid, expected_revision: 1, fiscal_year: "2026/27", documents: [{ slot: "esg_en", path: "/local/new-esg.pdf", file_name: "new-esg.pdf", inspection_id: inspection().inspection_id }] }); expect(mocks.request.mock.calls.some(([input]) => /build|start/.test(input.action))).toBe(false);
  });
  it("keeps the current FY2026/27 and exact FY2025/26 plan after save-only, before the saved Start action", async () => {
    const saved = project(); saved.versions[0]!.documents = [{ slot: "esg_en", file_name: "saved-current.pdf", sha256: "a".repeat(64), bytes: 10 }];
    const mocks = await render({ request: async input => input.action === "project-create" ? { ...saved, revision: 0, active_version: undefined, versions: [] } : saved }); await select(["saved-current.pdf"]); await act(async () => button("只儲存文件").click());
    expect(container.querySelectorAll(".finance-input-file")).toHaveLength(0);
    const plan = container.querySelector(".finance-input-plan")!; expect(plan.textContent).toContain("今次使用 · FY2026/27"); expect(plan.textContent).toContain("saved-current.pdf"); expect(plan.textContent).toContain("所選項目已保存文件"); expect(plan.textContent).toContain("去年原稿 · FY2025/26"); expect(plan.textContent).toContain("2025/26-esg-en.pdf");
    const start = button("開始一致性審閱"); expect(start.disabled).toBe(false); expect(plan.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.request.mock.calls.some(([input]) => /build|start/.test(input.action))).toBe(false);
  });
  it("shows a saved version's source plan without uploads and disables only missing-history checks", async () => {
    const mocks = await render({ selected: true, knowledge: async () => knowledge([doc("2024/25")]) });
    expect(container.querySelector(".finance-input-plan")?.textContent).toContain("今次使用 · FY2026/27"); expect(container.querySelector(".finance-input-plan")?.textContent).toContain("缺少 FY2025/26"); expect(button("開始一致性審閱").disabled).toBe(false); expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3]!.disabled).toBe(true); expect(mocks.upload).not.toHaveBeenCalled(); expectNoWrites(mocks.request);
  });
  it("ignores an inspection that resolves after removal", async () => {
    let finish!: (value: InputInspection) => void; const waiting = new Promise<InputInspection>(resolve => { finish = resolve; });
    const mocks = await render({ inspect: async () => waiting }); await select(["removed.pdf"]); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件1"]')!.click()); await act(async () => finish(inspection()));
    expect(container.querySelectorAll(".finance-input-file")).toHaveLength(0); expect(container.querySelector(".finance-input-plan")).toBeNull(); expect(button("只儲存文件").disabled).toBe(true); expectNoWrites(mocks.request);
  });
  it("ignores stale knowledge replies after current identity changes", async () => {
    let finish!: (value: InputKnowledge) => void;
    const mocks = await render({ inspect: async input => inspection({ fields: { ...inspection().fields, fiscal_year: identified(input.file_name === "old.pdf" ? "2025/26" : "2026/27") } }), knowledge: async input => input.fiscal_year === "2025/26" ? new Promise(resolve => { finish = resolve; }) : knowledge() });
    await select(["old.pdf"]); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件1"]')!.click()); await select(["new.pdf"]); await act(async () => finish(knowledge([doc("2024/25")])));
    expect(container.querySelector(".finance-input-plan")?.textContent).toContain("去年原稿 · FY2025/26"); expect(container.querySelector(".finance-input-plan")?.textContent).not.toContain("2024/25-esg-en.pdf"); expectNoWrites(mocks.request);
  });
  it("clears pending inspection on context changes and rejects the old result", async () => {
    let finish!: (value: InputInspection) => void;
    const mocks = await render({ context: { id: "first", name: "First" }, inspect: async () => new Promise(resolve => { finish = resolve; }) }); await select(["old-context.pdf"]);
    await act(async () => root.render(<FinanceProjectSetup {...mocks.props} context={{ id: "second", name: "Second" }} />)); await act(async () => finish(inspection()));
    expect(container.querySelectorAll(".finance-input-file")).toHaveLength(0); expect(container.querySelector(".finance-input-plan")).toBeNull(); expectNoWrites(mocks.request);
  });
  it("shows unavailable knowledge honestly and permits a current-only check after bounded lookup fails", async () => {
    await render({ knowledge: async input => { if (input.fiscal_year) throw Error("TEST ONLY read unavailable"); return knowledge(); } }); await select(["current.pdf"]);
    expect(container.querySelector(".finance-input-plan")?.textContent).toContain("去年來源暫未能確認：TEST ONLY read unavailable"); expect(button("只儲存文件").disabled).toBe(false); expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3]!.disabled).toBe(true);
  });
  it("prevents selection and drops during an explicitly requested save", async () => {
    let rejectCreate!: (reason: Error) => void;
    const mocks = await render({ request: async input => { if (input.action === "project-create") return new Promise((_resolve, reject) => { rejectCreate = reject; }); throw Error("unexpected"); } }); await select(["kept.pdf"]); await act(async () => button("只儲存文件").click());
    expect(button("加入 PDF").disabled).toBe(true); expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    await select(["ignored.pdf"]); expect(container.querySelectorAll(".finance-input-file")).toHaveLength(1); expect(mocks.upload).toHaveBeenCalledOnce();
    await act(async () => rejectCreate(new Error("TEST ONLY save refusal"))); expect(button("加入 PDF").disabled).toBe(false); expect(container.textContent).toContain("TEST ONLY save refusal");
  });
});
