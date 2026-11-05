// @vitest-environment happy-dom
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProjectTreeSection } from "../app-frame.js";
import { FinanceProjectSetup } from "../finance-project-setup.js";
import { FinanceWorkspace } from "../finance-workspace.js";
import { savedFinanceProjectsByNativeId, useSavedFinanceProjects } from "../use-saved-finance-projects.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const pid = "a".repeat(32), vid = "saved-v2";
const document = { slot: "esg_en" as const, file_name: "CURRENT-ESG.pdf", sha256: "a".repeat(64), bytes: 100 };
const saved: FinanceProject = { id: pid, title: "Saved report", external_id: "native-report", revision: 2, latest_run: null, created_at: "2026-11-04", updated_at: "2026-11-04", active_version: vid,
  versions: [{ id: "old-v1", fiscal_year: "2025/26", created_at: "2026-11-03", runs: [], documents: [{ ...document, file_name: "OLD.pdf" }] },
    { id: vid, fiscal_year: "2026/27", created_at: "2026-11-04", runs: [], documents: [document, { ...document, slot: "annual_en", file_name: "CURRENT-ANNUAL.pdf" }] }] };
const knowledge = { entity_id: "yeebo", entity_name: "億都", observed_at: "2026-11-04", catalog_revision: "mock", documents: [] };
let root: Root, container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); container = globalThis.document.createElement("div"); globalThis.document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const clientOf = (request: ReturnType<typeof vi.fn>) => ({ financeReaderRequest: request } as unknown as MemmyAgentClient);

describe("saved report project discovery", () => {
  it("uses explicit native binding and retains version/FY/count without inventing tasks", () => {
    expect(savedFinanceProjectsByNativeId([saved])).toEqual({ "native-report": { selection: { project_id: pid, version_id: vid }, detail: "FY2026/27 · 版本2 · 2份文件" } });
    expect(saved.latest_run).toBeNull(); expect(saved.versions.every(v => v.runs.length === 0)).toBe(true);
  });
  it("omits unbound, empty and ambiguous project libraries instead of title/path guessing", () => {
    expect(savedFinanceProjectsByNativeId([{ ...saved, external_id: null }, { ...saved, external_id: "empty", versions: [] }])).toEqual({});
    expect(savedFinanceProjectsByNativeId([saved, { ...saved, id: "b".repeat(32) }])).toEqual({});
  });
  it("omits a started chosen version but keeps a new unstarted version when older tasks exist", () => {
    expect(savedFinanceProjectsByNativeId([{ ...saved, versions: saved.versions.map(v => ({ ...v, runs: ["old-run"] })) }])).toEqual({});
    const olderStarted = { ...saved, versions: [{ ...saved.versions[0]!, runs: ["old-run"] }, saved.versions[1]!] };
    expect(savedFinanceProjectsByNativeId([olderStarted])["native-report"]?.selection.version_id).toBe(vid);
  });
  it("chooses the last saved document version if active version is absent, keeping its actual index", () => {
    expect(savedFinanceProjectsByNativeId([{ ...saved, active_version: "removed", versions: [...saved.versions, { ...saved.versions[1]!, id: "empty", documents: [] }] }])["native-report"]?.detail).toBe("FY2026/27 · 版本2 · 2份文件");
  });
  it("reuses one startup project-list request and never starts or saves work", async () => {
    const request = vi.fn(async () => ({ projects: [saved] })), client = clientOf(request), loaded = vi.fn();
    function Harness() { const state = useSavedFinanceProjects(client, true, "connected", loaded); return <span>{Object.keys(state.entries).join(",")}</span>; }
    await act(async () => root.render(<Harness />));
    expect(container.textContent).toBe("native-report"); expect(request.mock.calls).toEqual([[{ action: "project-list" }]]); expect(loaded).toHaveBeenCalledOnce();
  });
  it("refuses a late former-client reply and clears known actions after a failed refresh", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = clientOf(vi.fn(() => new Promise(resolve => { resolveOld = resolve; })));
    const request = vi.fn().mockResolvedValueOnce({ projects: [{ ...saved, external_id: "new-native" }] }).mockRejectedValueOnce(Error("offline"));
    const fresh = clientOf(request), loaded = vi.fn();
    function Harness({ client }: { client: MemmyAgentClient }) { const state = useSavedFinanceProjects(client, true, "connected", loaded); return <><span>{Object.keys(state.entries).join(",")}{state.error ? "unavailable" : ""}</span><button onClick={() => void state.refresh()}>refresh</button></>; }
    await act(async () => root.render(<Harness client={old} />));
    await act(async () => root.render(<Harness client={fresh} />));
    await act(async () => resolveOld({ projects: [saved] }));
    expect(container.querySelector("span")?.textContent).toBe("new-native"); expect(loaded).toHaveBeenCalledOnce();
    await act(async () => button("refresh").click()); expect(container.querySelector("span")?.textContent).toBe("unavailable");
  });
  it("refreshes explicitly after saved work changes and publishes the new version without polling", async () => {
    const latest = { ...saved.versions[1]!, id: "new-v3", fiscal_year: "2027/28" };
    const request = vi.fn().mockResolvedValueOnce({ projects: [saved] }).mockResolvedValueOnce({ projects: [{ ...saved, active_version: latest.id, versions: [...saved.versions, latest] }] });
    const client = clientOf(request);
    function Harness() { const state = useSavedFinanceProjects(client, true, "connected", vi.fn()); return <><span>{state.entries["native-report"]?.detail}</span><button onClick={() => void state.refresh()}>workspace closed</button></>; }
    await act(async () => root.render(<Harness />)); expect(container.querySelector("span")?.textContent).toContain("版本2");
    await act(async () => button("workspace closed").click()); expect(container.querySelector("span")?.textContent).toBe("FY2027/28 · 版本3 · 2份文件"); expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("project-local sidebar action", () => {
  function renderSection(archived = false, collapsed = false) {
    const open = vi.fn(), newTask = vi.fn();
    const projects = ["native-report", "general-cuby"].map(id => ({ project: { id, name: id, rootPath: "/unrelated", pinned: false, createdAt: "2026-11-04" }, tasks: [] }));
    const props = { title: "Projects", groupKey: "projects", collapsedGroups: collapsed ? { "project:native-report": true } : {}, projects, tasks: [], currentSessionKey: "existing-chat", selectedProjectId: "general-cuby", showPreviews: false, projectRegistryState: "ready", showingArchived: archived,
      onToggleGroup: vi.fn(), onToggleProject: vi.fn(), onOpenTask: vi.fn(), onNewProjectTask: newTask,
      projectContentAction: (project: { id: string }, hidden: boolean) => project.id === "native-report" ? <button tabIndex={hidden ? -1 : undefined} onClick={open}>查看已保存文件／繼續設定</button> : null } as any;
    return { open, newTask, element: <I18nProvider language="zh-CN"><ProjectTreeSection {...props} /></I18nProvider> };
  }
  it("places one action under the bound no-task project while general projects keep normal empty-task wording", async () => {
    const ui = renderSection(); await act(async () => root.render(ui.element));
    const nodes = container.querySelectorAll(".app-frame-project-node");
    expect(nodes[0]?.textContent).toContain("查看已保存文件／繼續設定"); expect(nodes[0]?.textContent).not.toContain("暂无任务");
    expect(nodes[1]?.textContent).toContain("暂无任务"); expect(nodes[1]?.textContent).not.toContain("已保存文件");
    await act(async () => button("查看已保存文件／繼續設定").click()); expect(ui.open).toHaveBeenCalledOnce(); expect(ui.newTask).not.toHaveBeenCalled();
  });
  it("does not show active saved setup in archived task view and excludes a collapsed action from Tab order", async () => {
    await act(async () => root.render(renderSection(true).element)); expect(container.textContent).not.toContain("查看已保存文件／繼續設定");
    await act(async () => root.render(renderSection(false, true).element)); expect(button("查看已保存文件／繼續設定").tabIndex).toBe(-1);
  });
});

describe("exact saved setup reopening", () => {
  it("opens the requested saved version and its plan without upload/persistence, retaining the existing version selector", async () => {
    const request = vi.fn(async (input: any) => input.action === "project-list" ? { projects: [saved] } : knowledge), upload = vi.fn(), complete = vi.fn();
    await act(async () => root.render(<FinanceProjectSetup initialSelection={{ project_id: pid, version_id: vid }} client={{ uploadAgentMedia: upload } as unknown as MemmyAgentClient} request={request} onComplete={complete} />));
    expect(container.textContent).toContain("CURRENT-ESG.pdf"); expect(container.textContent).toContain("CURRENT-ANNUAL.pdf"); expect(container.textContent).toContain("今次使用 · FY2026/27");
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="項目報告版本"]')!; expect(selector.value).toBe(vid); expect(selector.options.length).toBe(2);
    await act(async () => { selector.value = "old-v1"; selector.dispatchEvent(new Event("change", { bubbles: true })); }); expect(container.textContent).toContain("OLD.pdf"); expect(container.textContent).toContain("今次使用 · FY2025/26");
    expect(request.mock.calls.every(([input]) => ["project-list", "input-knowledge"].includes(input.action))).toBe(true); expect(upload).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it.each(["project", "version", "offline"])("blocks missing %s instead of silently opening new or different work; retry restores the exact saved version", async failure => {
    let fail = true;
    const request = vi.fn(async (input: any) => {
      if (input.action !== "project-list") return knowledge;
      if (!fail) return { projects: [saved] };
      if (failure === "offline") throw Error("Connection unavailable");
      return { projects: failure === "project" ? [] : [{ ...saved, versions: [saved.versions[0]] }] };
    });
    const upload = vi.fn();
    await act(async () => root.render(<FinanceProjectSetup initialSelection={{ project_id: pid, version_id: vid }} client={{ uploadAgentMedia: upload } as unknown as MemmyAgentClient} request={request} onComplete={vi.fn()} />));
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.textContent).not.toContain("OLD.pdf"); expect(container.querySelector('input[type="file"]')).toBeNull(); expect(container.textContent).not.toContain("只儲存文件");
    fail = false; await act(async () => button("重試載入已保存文件").click()); expect(container.textContent).toContain("CURRENT-ESG.pdf"); expect(container.textContent).toContain("CURRENT-ANNUAL.pdf"); expect(upload).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([input]) => ["project-list", "input-knowledge"].includes(input.action))).toBe(true);
  });
  it("passes a project action's exact selection through the workspace and closes without launching", async () => {
    const request = vi.fn(async (input: any) => input.action === "project-list" ? { projects: [saved] } : knowledge), launch = vi.fn(), close = vi.fn();
    const client = { financeReaderRequest: request, getFinanceCatalog: vi.fn(async () => ({ reviews: [], unavailable: [], scope: "C2" })) } as unknown as MemmyAgentClient;
    await act(async () => root.render(<FinanceWorkspace visible client={client} workflow="consistency" initialPath={null} initialSetupSelection={{ project_id: pid, version_id: vid }} busy={false} onChoose={vi.fn()} onClose={close} onLaunch={launch} />));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="項目報告版本"]')?.value).toBe(vid);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="關閉工作台"]')!.click()); expect(close).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled();
  });
  it("keeps the actual reader's unsent question and chosen source/page mounted but inert behind saved setup, then restores them without duplicate reader requests", async () => {
    const run = "20261104T000000-aabbccdd";
    const report = { schema_version: "financebuddy-consistency-1", run_id: run, fiscal_year: "2025/26", created_at: "2026-11-04", comparisons: ["bilingual"], history: { status: "not_requested", fiscal_year: "2024/25", source: "KB" },
      documents: ["esg_zh", "esg_en"].map(slot => ({ slot, label: slot, file_name: slot + ".pdf", sha256: "a".repeat(64), page_count: 8, cover_year_found: true, identity_confirmed: true, textless_pages: [] })),
      checks: [{ id: "issue", category: "basis", status: "difference", title: "Retained source question", reason: "Definitions differ", refs: [{ slot: "esg_zh", page: 2, quote: "中文內容" }, { slot: "esg_en", page: 2, quote: "English source" }] }],
      coverage: { scanned_pages: 16, page_pairs: 8, same_numeric_inventory_pages: 7, metric_checks: 0, numeric_facts: 0, matched: 0, differences: 1, pending: 0, historical_pages: 0, internal_checks: 0, restatement_checks: 0 }, all_numbers_confirmed: false, all_basis_confirmed: false, limits: [] };
    const project = { ...saved, versions: [{ ...saved.versions[0]!, runs: [run] }, saved.versions[1]!] };
    const request = vi.fn(async (input: any) => {
      if (input.action === "project-list") return { projects: [project] };
      if (input.action === "consistency-read") return report;
      if (input.action === "consistency-editor") return { run_id: run, base_sha256: "a".repeat(64), revision: 0, proposals: {}, decisions: {}, history: [] };
      if (input.action === "consistency-page") return { data_url: "data:image/png;base64,AA==" };
      return knowledge;
    });
    const launch = vi.fn(), client = { financeReaderRequest: request, getFinanceCatalog: vi.fn(async () => ({ reviews: [], unavailable: [], scope: "C2" })) } as unknown as MemmyAgentClient;
    const binding = { project_id: pid, native_project_id: "native-report", run_id: run, session_key: `websocket:fin_${pid}`, chat_id: `fin_${pid}` };
    const props = { client, initialReview: binding, initialPath: null, busy: false, onChoose: vi.fn(), onClose: vi.fn(), onLaunch: launch };
    await act(async () => root.render(<FinanceWorkspace {...props} visible workflow={null} />));
    const navigation = container.querySelector(".finance-review-navigation")!, reader = container.querySelector(".consistency-reader")!;
    const style = readFileSync(resolve("App/frontend/desktop/src/pages/finance-workspace.css"), "utf8");
    const navigationRules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(rule => rule[1]!.includes(">.finance-review-navigation"));
    expect(navigationRules.some(rule => rule[2]!.includes("padding:5px 12px") && navigation.matches(rule[1]!))).toBe(true);
    reader.classList.add("consistency-reader--reading");
    expect(navigationRules.some(rule => rule[2]!.includes("display:none") && navigation.matches(rule[1]!))).toBe(true);
    reader.classList.remove("consistency-reader--reading");
    await act(async () => container.querySelector<HTMLButtonElement>(".consistency-open-issue")!.click());
    const question = container.querySelector<HTMLInputElement>('[aria-label="追問此項"]')!;
    const source = container.querySelector<HTMLSelectElement>('[aria-label="引用文件"]')!, page = container.querySelector<HTMLInputElement>('[aria-label="引用 PDF 頁碼"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(question, "Unsent evidence question"); question.dispatchEvent(new Event("input", { bubbles: true }));
      source.value = "esg_en"; source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(page, "5"); page.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(question.value).toBe("Unsent evidence question"); expect(source.value).toBe("esg_en"); expect(page.value).toBe("5");
    const readerCalls = request.mock.calls.filter(([input]) => /^consistency-/.test(input.action)).length;
    await act(async () => root.render(<FinanceWorkspace {...props} visible workflow="consistency" initialSetupSelection={{ project_id: pid, version_id: vid }} />));
    expect(question.isConnected).toBe(true); expect(question.closest("[hidden][inert]")).not.toBeNull(); expect(source.isConnected).toBe(true);
    const dialog = container.querySelector<HTMLElement>('aside[role="dialog"]')!;
    const visibleControls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]")).filter(control => !control.closest("[hidden], [inert]"));
    visibleControls[0]!.focus(); await act(async () => visibleControls[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(globalThis.document.activeElement).toBe(visibleControls.at(-1)); expect(globalThis.document.activeElement?.closest("[inert]")).toBeNull();
    await act(async () => root.render(<FinanceWorkspace {...props} visible={false} workflow={null} initialSetupSelection={null} />));
    await act(async () => root.render(<FinanceWorkspace {...props} visible workflow={null} />));
    expect(container.querySelector('[aria-label="追問此項"]')).toBe(question); expect(question.value).toBe("Unsent evidence question"); expect(source.value).toBe("esg_en"); expect(page.value).toBe("5"); expect(question.closest("[hidden], [inert]")).toBeNull();
    expect(request.mock.calls.filter(([input]) => /^consistency-/.test(input.action))).toHaveLength(readerCalls); expect(launch).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([input]) => /save|create|start|accept|dismiss/.test(input.action))).toBe(false);
  });
});
