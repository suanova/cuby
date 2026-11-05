// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsistencyEditor, ConsistencyReport, FinanceRequest } from "@memmy/local-api-contracts";
import { ConsistencyDraftExport } from "../consistency-edit-controls.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const runA = "20310101T000000-aabbccdd", runB = "20310102T000000-aabbccdd";
const downloadId = "12345678-1234-4234-8234-123456789abc";
type Request = (input: FinanceRequest) => Promise<unknown>;
const cleanups: Array<() => Promise<void>> = [];
const createObjectURL = vi.fn(() => "blob:verified-export"), revokeObjectURL = vi.fn();
let saveClick: ReturnType<typeof vi.spyOn>;

function report(run = runA): ConsistencyReport {
  return { run_id: run, documents: [{ slot: "esg_en", label: "ESG English" }] } as ConsistencyReport;
}

function editor(revision = 0, run = runA): ConsistencyEditor {
  return { run_id: run, base_sha256: "a".repeat(64), revision, history: [], proposals: {}, decisions: {} };
}

function exported(revision: number) {
  return {
    file_name: "revised.pdf", mime: "application/pdf", download_id: downloadId, bytes: 4,
    sha256: "a".repeat(64), revision, accepted: 0, layout_notice: "",
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  saveClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

function observe(request: Request, download = vi.fn(async () => new Blob(["%PDF"], { type: "application/pdf" }))) {
  const div = document.createElement("div"), root = createRoot(div);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  return {
    download,
    render: async (value: ConsistencyEditor | null, currentReport = report()) => {
      await act(async () => root.render(<ConsistencyDraftExport report={currentReport} editor={value} request={request} download={download}/>));
    },
    click: async () => { await act(async () => div.querySelector("button")!.click()); },
    select: async (slot: string) => {
      await act(async () => {
        const select = div.querySelector("select")!;
        select.value = slot;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    button: () => div.querySelector("button")!,
    error: () => div.querySelector('[role="alert"]')?.textContent ?? "",
  };
}

describe("ConsistencyDraftExport revision ownership", () => {
  it("keeps export disabled until an editor has loaded", async () => {
    const request = vi.fn(), view = observe(request);
    await view.render(null);
    expect(view.button().disabled).toBe(true);
    await view.click();
    expect(request).not.toHaveBeenCalled();
    expect(view.download).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(saveClick).not.toHaveBeenCalled();
  });

  it("keeps export disabled when the report and editor belong to different reviews", async () => {
    const request = vi.fn(async () => exported(3)), view = observe(request);
    await view.render(editor(3, runA), report(runB));
    expect(view.button().disabled).toBe(true);
    await view.click();
    expect(request).not.toHaveBeenCalled();
    expect(view.download).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(saveClick).not.toHaveBeenCalled();
  });

  it("requests the visible editor revision including revision zero and saves a matching export", async () => {
    const request = vi.fn(async () => exported(0)), view = observe(request);
    await view.render(editor(0));
    await view.click();
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: "consistency-draft-export", run_id: runA, expected_revision: 0 });
    expect(view.download).toHaveBeenCalledExactlyOnceWith(downloadId);
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(await view.download.mock.results[0]!.value);
    expect(saveClick).toHaveBeenCalledOnce();
    const link = saveClick.mock.instances[0] as HTMLAnchorElement;
    expect(link.href).toBe("blob:verified-export");
    expect(link.download).toBe("revised.pdf");
    expect(view.error()).toBe("");
    await act(async () => vi.advanceTimersByTime(30000));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:verified-export");
  });

  it("includes the selected PDF slot with the click-time revision and run", async () => {
    const request = vi.fn(async () => exported(4)), view = observe(request);
    await view.render(editor(4, runB), report(runB));
    await view.select("esg_en");
    await view.click();
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: "consistency-draft-export", run_id: runB, expected_revision: 4, slot: "esg_en" });
    expect(view.download).toHaveBeenCalledExactlyOnceWith(downloadId);
    expect(view.error()).toBe("");
  });

  it.each([2, 4])("rejects returned revision %i for visible revision 3 before download or browser save", async revision => {
    const request = vi.fn(async () => exported(revision)), view = observe(request);
    await view.render(editor(3));
    await view.click();
    expect(view.error()).toBe("修訂版本已變更，請重新載入後再匯出。");
    expect(view.download).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(saveClick).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(view.button().disabled).toBe(false);
  });

  it("saves the requested revision when another editor and report arrive while the export is pending", async () => {
    const pending = deferred(), request = vi.fn(() => pending.promise), view = observe(request);
    await view.render(editor(3));
    await view.click();
    expect(view.button().disabled).toBe(true);
    await view.render(editor(8, runB), report(runB));
    await act(async () => pending.resolve(exported(3)));
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: "consistency-draft-export", run_id: runA, expected_revision: 3 });
    expect(view.download).toHaveBeenCalledExactlyOnceWith(downloadId);
    expect(saveClick).toHaveBeenCalledOnce();
    expect(view.error()).toBe("");
  });

  it("rejects a response matching a newer editor instead of the revision requested at the click", async () => {
    const pending = deferred(), request = vi.fn(() => pending.promise), view = observe(request);
    await view.render(editor(3));
    await view.click();
    await view.render(editor(4));
    await act(async () => pending.resolve(exported(4)));
    expect(view.error()).toBe("修訂版本已變更，請重新載入後再匯出。");
    expect(view.download).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(saveClick).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
