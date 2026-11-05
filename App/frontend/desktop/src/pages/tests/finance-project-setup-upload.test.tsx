// @vitest-environment happy-dom
// Mocked component checks only; OS picker/drop and PDF recognition need live acceptance.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputInspection } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { FinanceProjectSetup } from "../finance-project-setup.js";
import { FinanceWorkspace } from "../finance-workspace.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const knowledge = { entity_id: "yeebo", entity_name: "億都（Yeebo）", observed_at: "2026-11-04", catalog_revision: "mock", documents: [] };
const pdf = (name: string, bytes = 10, type = "application/pdf") => { const file = new File(["%PDF mock"], name, { type }); Object.defineProperty(file, "size", { value: bytes }); return file; };
const picker = () => container.querySelector<HTMLInputElement>('input[type="file"]')!;
const dropzone = () => container.querySelector<HTMLDivElement>(".finance-upload-dropzone")!;
const rows = () => Array.from(container.querySelectorAll(".finance-upload-row"));
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(element => element.textContent === text)!;
async function select(files: File[]) { Object.defineProperty(picker(), "files", { configurable: true, value: files }); await act(async () => picker().dispatchEvent(new Event("change", { bubbles: true }))); }
async function drop(files: File[]) { const event = new Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"], dropEffect: "none" } }); await act(async () => dropzone().dispatchEvent(event)); return event; }
function inspection(name: string, index: number): InputInspection {
  const identified = (value: string) => ({ status: "identified" as const, value, evidence: [{ page: 1, quote: "TEST ONLY mock source" }] });
  return { file_name: name, sha256: String(index).repeat(64), bytes: 10, pages: 2, fields: { issuer: identified("yeebo"), fiscal_year: identified("2026/27"), kind: identified(name.includes("annual") ? "annual" : "esg"), language: identified("en") }, supported: true, test_only: true, scan_pages: [1], limits: [], inspection_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` };
}
async function render(mode: "consistency" | "c2" = "consistency") {
  let index = 0;
  const request = vi.fn(async (input: any) => input.action === "input-inspect" ? inspection(input.file_name, ++index) : input.action === "project-list" ? { projects: [] } : knowledge);
  const upload = vi.fn(async (inputs: any[]) => inputs.map((input: any) => ({ kind: "file", mime: "application/pdf", path: `/local/${input.name}`, url: `http://127.0.0.1/mock/${input.name}` })));
  const complete = vi.fn();
  await act(async () => root.render(<FinanceProjectSetup initialMode={mode} client={{ uploadAgentMedia: upload } as unknown as MemmyAgentClient} request={request} onComplete={complete} />));
  return { request, upload, complete };
}
function expectNoPersistence(mocks: Awaited<ReturnType<typeof render>>) { expect(mocks.request.mock.calls.some(([input]) => /project-create|project-save|build|start/.test(input.action))).toBe(false); expect(mocks.complete).not.toHaveBeenCalled(); }
describe("PDF picker and local staging (mocked component)", () => {
  it("shows a keyboard add button, multiple-PDF picker and honest staging instruction before files", async () => {
    const mocks = await render(), add = button("加入 PDF"), nativeClick = vi.spyOn(picker(), "click");
    expect(add.type).toBe("button"); expect(add.disabled).toBe(false); expect(add.getAttribute("aria-controls")).toBe(picker().id);
    expect(picker().multiple).toBe(true); expect(picker().accept).toBe("application/pdf,.pdf"); expect(picker().hidden).toBe(true);
    expect(dropzone().getAttribute("role")).toBe("group"); expect(dropzone().textContent).toContain("暫存到此電腦並讀取內容");
    expect(container.querySelector('[aria-label="項目財年"]')).toBeNull(); expect(container.querySelector('[aria-label="項目報告來源"]')).toBeNull();
    add.focus(); await act(async () => add.click()); expect(nativeClick).toHaveBeenCalledOnce();
    expect(button("只儲存文件").disabled).toBe(true); expect(rows()).toHaveLength(0);
    expect(mocks.request.mock.calls.map(([input]) => input.action)).toEqual(["input-knowledge"]); expect(mocks.upload).not.toHaveBeenCalled(); expectNoPersistence(mocks);
  });
  it("keeps the native picker out of the dialog's Tab boundary", async () => {
    const client = { getFinanceCatalog: vi.fn(async () => ({ reviews: [], unavailable: [], scope: "C2" })), financeReaderRequest: vi.fn(async () => knowledge) } as unknown as MemmyAgentClient;
    await act(async () => root.render(<FinanceWorkspace visible client={client} initialPath={null} workflow="consistency" busy={false} onChoose={() => {}} onLaunch={vi.fn()} onClose={() => {}} />));
    const dialog = container.querySelector('[role="dialog"]')!, focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]"));
    const first = focusables[0]!, last = focusables.at(-1)!;
    expect(last).not.toBe(picker()); first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }))); expect(document.activeElement).toBe(last);
    await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))); expect(document.activeElement).toBe(first);
  });
  it("appends picker/drop files, stages once and shows content-backed metadata without persistence", async () => {
    const mocks = await render(); await select([pdf("misleading.pdf", 2 * 1024 * 1024)]);
    expect(rows()[0]?.textContent).toContain("2.0 MB"); expect(rows()[0]?.textContent).toContain("FY2026/27"); expect(container.querySelector('[aria-label="文件1種類及語言"]')).toBeNull();
    const ancestorDrop = vi.fn(); document.body.addEventListener("drop", ancestorDrop); const event = await drop([pdf("annual.PDF", 1200, "")]); document.body.removeEventListener("drop", ancestorDrop);
    expect(event.defaultPrevented).toBe(true); expect(ancestorDrop).not.toHaveBeenCalled(); expect(rows()).toHaveLength(2); expect(rows()[1]?.textContent).toContain("2 KB"); expect(button("只儲存文件").disabled).toBe(false);
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.request).toHaveBeenCalledWith({ action: "input-inspect", media_ref: "http://127.0.0.1/mock/misleading.pdf", file_name: "misleading.pdf" }); expectNoPersistence(mocks);
  });
  it.each(["picker", "drop"] as const)("validates PDF and 30MB for %s and keeps earlier files", async method => {
    const mocks = await render(); await select([pdf("kept.pdf")]);
    const files = [new File(["text"], "notes.txt", { type: "text/plain" }), pdf("too-large.pdf", 30 * 1024 * 1024 + 1), pdf("image.pdf", 200, "image/png"), pdf("annual.pdf", 30 * 1024 * 1024, "application/octet-stream")];
    if (method === "picker") await select(files); else await drop(files);
    expect(rows()).toHaveLength(2); expect(rows()[0]?.textContent).toContain("kept.pdf"); expect(rows()[1]?.textContent).toContain("30.0 MB");
    const errors = container.querySelector('.finance-upload-errors[role="alert"]')!;
    expect(errors.textContent).toContain("「notes.txt」不是 PDF"); expect(errors.textContent).toContain("「too-large.pdf」超過30 MB"); expect(errors.textContent).toContain("「image.pdf」不是 PDF"); expect(picker().value).toBe(""); expectNoPersistence(mocks);
  });
  it("limits selection to four files and explains how to add another", async () => {
    const mocks = await render(); await select(["1", "2", "3", "4", "5"].map(n => pdf(n + ".pdf")));
    expect(rows()).toHaveLength(4); expect(mocks.upload).toHaveBeenCalledTimes(4); expect(container.textContent).toContain("每個版本最多四份。請先移除不需要的文件");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件4"]')!.click()); await drop([pdf("annual.pdf")]); expect(rows()).toHaveLength(4); expectNoPersistence(mocks);
  });
  it("keeps C2 start disabled for annual-only input and explains the ESG next step", async () => {
    const mocks = await render("c2"); await select([pdf("annual.pdf")]); expect(button("只儲存文件").disabled).toBe(false); expect(button("儲存並開始C2 披露檢查").disabled).toBe(true); expect(container.querySelector(".finance-upload-next")?.textContent).toContain("開始 C2 檢查需加入 ESG 報告");
    await drop([pdf("esg.pdf")]); expect(button("儲存並開始C2 披露檢查").disabled).toBe(false); expectNoPersistence(mocks);
  });
});
