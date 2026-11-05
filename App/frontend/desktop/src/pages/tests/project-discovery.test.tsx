// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentClient, MemmyAgentProject } from "../../api/memmy-agent-client.js";
import { AppProviders } from "../../app/providers.js";
import { SearchPalette, filterTasks } from "../../components/search-palette.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { createInitialAppState } from "../../state/app-reducer.js";
import { useAppState } from "../../state/app-state.js";
import type { AgentTaskView } from "../../state/agent-chat-slice.js";
import { AppFrame, deriveSidebarPlacement } from "../app-frame.js";
import { ProjectTargetPicker, filterProjectTargetPickerProjects } from "../home-page.js";
import { financeProjectDiscoveryByNativeId } from "../project-discovery.js";
import { savedFinanceProjectsByNativeId, useSavedFinanceProjects } from "../use-saved-finance-projects.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const project = (id: string, name = id, pinned = false, day = "04"): MemmyAgentProject => ({ id, name, pinned, rootPath: `C:\\private\\technical-${id}`, createdAt: `2026-11-${day}` });
const finance: FinanceProject = {
  id: "a".repeat(32), title: "Do not substitute this service title", external_id: "formal", revision: 1,
  active_version: "v2", latest_run: "historical-run", created_at: "2026-11-03", updated_at: "2026-11-04",
  versions: [{ id: "v1", fiscal_year: "2024/25", created_at: "2026-11-03", runs: ["old-run"], documents: [] },
    { id: "v2", fiscal_year: "2025/26", created_at: "2026-11-04", runs: ["current-run"], documents: [{ slot: "esg_en", file_name: "TEST ONLY FY2099-00.pdf", sha256: "a".repeat(64), bytes: 20 }],
      reviews: [{ run_id: "current-run", kind: "consistency", status: "completed" }, { run_id: "pending", kind: "c2", status: "not_started" }] }],
};
const metadata = financeProjectDiscoveryByNativeId([finance]);
const task = (id: string, projectId: string | null = null, pinned = false): AgentTaskView => ({ sessionKey: `websocket:${id}`, chatId: id, title: id, preview: "", updatedAt: null, runStartedAt: null, completedUnseen: false, pinned, archived: false, tags: [], projectId, groupProjectId: projectId, cwd: "C:\\private\\technical-formal", missingProject: false });
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const setInput = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("source-bound project discovery", () => {
  it("uses actual version FY and separate actual review states, with no company/title/filename inference", () => {
    expect(metadata.formal?.summary).toBe("FY2025/26 · 一致性：已完成 · C2：未開始");
    expect(JSON.stringify(metadata)).not.toMatch(/2099|substitute|TEST ONLY/);
    expect(finance.versions[0]!.fiscal_year).toBe("2024/25");
  });
  it("keeps runs without review metadata and missing FY/status unknown", () => {
    const unknown = { ...finance, versions: [{ ...finance.versions[1]!, fiscal_year: "", reviews: undefined }] };
    expect(financeProjectDiscoveryByNativeId([unknown]).formal?.summary).toBe("財年未確認 · 一致性：未確認 · C2：未確認");
    expect(financeProjectDiscoveryByNativeId([{ ...unknown, versions: [] }]).formal?.summary).toContain("未確認");
    expect(financeProjectDiscoveryByNativeId([{ ...unknown, versions: [{ ...unknown.versions[0]!, fiscal_year: "unknown" }] }]).formal?.summary).not.toContain("FYunknown");
    expect(financeProjectDiscoveryByNativeId([{ ...finance, external_id: null }])).toEqual({});
    expect(financeProjectDiscoveryByNativeId([finance, { ...finance, id: "b".repeat(32) }])).toEqual({});
  });
  it("keeps created-order/pin cohorts and generic Cuby path search, including FY search without reordering", () => {
    const projects = [project("old", "Old", false, "01"), project("formal", "Actual human company label"), project("pin", "Pinned", true, "02")];
    expect(deriveSidebarPlacement([], projects).projects.map(n => n.project.id)).toEqual(["formal", "old"]);
    expect(filterProjectTargetPickerProjects(projects, "2025/26", [], metadata).map(p => p.id)).toEqual(["formal"]);
    expect(filterProjectTargetPickerProjects(projects, "technical-old").map(p => p.id)).toEqual(["old"]);
    expect(projects.map(p => p.id)).toEqual(["old", "formal", "pin"]);
  });
  it("preserves the FB028 unstarted action API independently of started metadata", () => {
    expect(savedFinanceProjectsByNativeId([finance])).toEqual({});
    expect(metadata.formal).toBeDefined();
    const saved = { ...finance, versions: [{ ...finance.versions[1]!, runs: [], reviews: undefined }] };
    expect(savedFinanceProjectsByNativeId([saved]).formal?.selection).toEqual({ project_id: finance.id, version_id: "v2" });
  });
  it("clears stale metadata after an error and restores it only from a fresh successful retry", async () => {
    const request = vi.fn().mockResolvedValueOnce({ projects: [finance] }).mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce({ projects: [finance] });
    const client = { financeReaderRequest: request } as unknown as MemmyAgentClient;
    function Harness() { const value = useSavedFinanceProjects(client, true, "connected", () => undefined); return <><span>{value.metadata.formal?.summary}{value.error ? "unavailable" : ""}</span><button onClick={() => void value.refresh()}>refresh</button></>; }
    await act(async () => root.render(<Harness />)); expect(container.textContent).toContain("FY2025/26");
    await act(async () => buttons()[0]!.click()); expect(container.textContent).not.toContain("FY2025/26"); expect(container.textContent).toContain("unavailable");
    await act(async () => buttons()[0]!.click()); expect(container.textContent).toContain("FY2025/26"); expect(container.textContent).not.toContain("unavailable");
    expect(request.mock.calls).toEqual(Array(3).fill([{ action: "project-list" }]));
  });
});

describe("existing project picker and search", () => {
  it("shows project names and metadata and lists test-labelled projects without a visibility toggle", async () => {
    const projects = [project("formal", "Actual company label"), project("test", "TEST ONLY — fixture"), project("pin", "TEST ONLY — pinned", true)];
    const select = vi.fn();
    await act(async () => root.render(<I18nProvider language="zh-CN"><ProjectTargetPicker open target={{ kind: "standalone" }} selectedProject={null} projects={projects} projectDiscovery={metadata} registryState="ready" disabled={false} onToggle={() => undefined} onClose={() => undefined} onSelect={select} onChooseOther={() => undefined} /></I18nProvider>));
    const formal = container.querySelector('[data-project-id="formal"]')!;
    expect(formal.textContent).toContain("Actual company label"); expect(formal.textContent).toContain("FY2025/26"); expect(formal.textContent).not.toContain("private"); expect(formal.getAttribute("title")).toBe("C:\\private\\technical-formal");
    expect(container.querySelector('[data-project-id="test"]')).not.toBeNull();
    expect(container.querySelector('[data-project-id="pin"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
  it("finds a no-task project in the same palette by FY/path/name, keeps task selection and closes with Escape", async () => {
    const selectProject = vi.fn(), selectTask = vi.fn(), close = vi.fn();
    const projects = [project("formal", "Actual company label"), project("test", "TEST ONLY — empty")];
    await act(async () => root.render(<SearchPalette open tasks={[task("old-review", "formal")]} projects={projects} projectMetadata={metadata} onSelectProject={selectProject} onSelectTask={selectTask} onClose={close} />));
    const input = container.querySelector("input")!;
    await setInput(input, "TEST ONLY"); expect(container.querySelectorAll('[role="option"]').length).toBe(1);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(selectProject).toHaveBeenCalledWith(projects[1]); expect(selectTask).not.toHaveBeenCalled();
    await setInput(input, "2025/26"); expect(container.textContent).toContain("Actual company label"); expect(container.textContent).not.toContain("old-review");
    await setInput(input, "technical-formal"); expect(container.textContent).toContain("Actual company label");
    await setInput(input, "old-review"); await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))); expect(selectTask).toHaveBeenCalledOnce();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(close).toHaveBeenCalledOnce();
    expect(filterTasks([task("old-review", "formal")], "technical-formal", projects, { projectMetadata: metadata })).toHaveLength(1);
  });
});

describe("root discovery preserves the active work", () => {
  it("reveals a pinned project under the actual projects ancestor in archived view", async () => {
    const pinned = project("pinned-archived", "Pinned archived root", true);
    function Seed() {
      const { dispatch } = useAppState();
      useEffect(() => {
        const initial = createInitialAppState().agent.sidebarState;
        dispatch(appActions.bootstrapLoaded(mockBootstrap, "/main"));
        dispatch(agentActions.sessionSnapshotApplied({ projectRegistryState: "ready", projects: [pinned], sessions: [] }));
        dispatch(agentActions.sidebarStateLoaded({ ...initial, view: { ...initial.view, show_project_archived: true }, collapsed_groups: { projects: true, pinned: true, "project:pinned-archived": true } }));
      }, [dispatch]);
      return null;
    }
    await act(async () => root.render(<AppProviders><Seed /><AppFrame title="Cuby" projectDiscovery={{}}><p>Retained reader</p></AppFrame></AppProviders>));
    const row = () => container.querySelector<HTMLButtonElement>('[data-project-discovery-id="pinned-archived"]')!;
    expect(row().closest("section")?.querySelector(".app-frame-task-section-header__trigger")?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    const search = container.querySelector<HTMLInputElement>(".search-palette-input")!;
    await setInput(search, pinned.name);
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(row().closest("section")?.querySelector(".app-frame-task-section-header__trigger")?.getAttribute("aria-expanded")).toBe("true");
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(row());
  });
  it("lists and focuses a test-labelled root without changing the current chat, drafts, target or persisted sidebar", async () => {
    const projects = [project("formal", "Actual company label"), project("test", "TEST ONLY — fixture"), project("pin", "Pinned", true, "03")];
    let observed = createInitialAppState().agent;
    function SeedAndObserve() {
      const { state, dispatch } = useAppState(); observed = state.agent;
      useEffect(() => {
        dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, language: "zh-CN" } }, "/main"));
        dispatch(agentActions.sessionSnapshotApplied({ projectRegistryState: "ready", projects, sessions: [{ key: "websocket:old-review", title: "Old saved review", projectId: "formal", cwd: projects[0]!.rootPath }] }));
        dispatch(agentActions.historyLoading("websocket:old-review", "old-review", "history"));
        dispatch(agentActions.historyLoaded({ schemaVersion: 1, sessionKey: "websocket:old-review", messages: [{ role: "user", content: "preserved question" }] }, "history"));
        dispatch(agentActions.composerDraftUpdated("old-review", "preserved composer"));
        dispatch(agentActions.draftTargetUpdated("draft-new-task", { kind: "project", projectId: "formal" }));
        dispatch(agentActions.sidebarStateLoaded({ ...createInitialAppState().agent.sidebarState, collapsed_groups: { projects: true, "project:test": true } }));
      }, [dispatch]);
      return null;
    }
    await act(async () => root.render(<AppProviders><SeedAndObserve /><AppFrame title="Cuby" projectDiscovery={metadata}><input aria-label="retained reader question" defaultValue="reader draft" /><p>Existing selected source and issue</p></AppFrame></AppProviders>));
    const before = JSON.stringify(observed);
    expect(container.querySelector('[data-project-discovery-id="test"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    const search = container.querySelector<HTMLInputElement>(".search-palette-input")!; await setInput(search, "TEST ONLY");
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const revealed = container.querySelector('[data-project-discovery-id="test"]')!;
    expect(revealed).not.toBeNull(); expect(document.activeElement).toBe(revealed); expect(revealed.getAttribute("aria-expanded")).toBe("true");
    expect(JSON.stringify(observed)).toBe(before);
    expect(container.querySelector<HTMLInputElement>('[aria-label="retained reader question"]')?.value).toBe("reader draft");
    expect(container.textContent).toContain("Existing selected source and issue");
    expect(container.querySelector(".project-discovery-path code")?.textContent).toContain("C:\\private\\technical-");
  });
});
