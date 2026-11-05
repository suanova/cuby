// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsistencyEditor, FinanceRequest } from "@memmy/local-api-contracts";
import { useConsistencyEditor } from "../consistency-edit-controls.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const runA = "20310101T000000-aabbccdd", runB = "20310102T000000-aabbccdd";
type Request = (input: FinanceRequest) => Promise<unknown>;
type EditorHook = ReturnType<typeof useConsistencyEditor>;
function requestedRun(input: FinanceRequest) {
  if (input.action !== "consistency-editor") throw new Error("Unexpected editor request");
  return input.run_id;
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function editor(run = runA, revision = 0, generating = false): ConsistencyEditor {
  return {
    run_id: run, base_sha256: "a".repeat(64), revision, history: [], decisions: {},
    proposals: { issue: { id: "proposal", status: generating ? "generating" : "ready", updated_at: "2031-01-01", summary: "Original suggestion" } },
    preparation: { id: "batch", status: generating ? "running" : "completed", updated_at: "2031-01-01", total: 1, ready: generating ? 0 : 1, failed: 0 },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function observe(strict = false) {
  const div = document.createElement("div"), root = createRoot(div);
  let current!: EditorHook, disposed = false;
  function Probe(props: { run: string; request: Request; signature: string }) {
    current = useConsistencyEditor(props.run, props.request, props.signature);
    return <><output>{JSON.stringify(current.editor)}</output>{current.error && <p role="alert">{current.error}</p>}</>;
  }
  const dispose = async () => { if (!disposed) { disposed = true; await act(async () => root.unmount()); } };
  cleanups.push(dispose);
  return {
    render: async (run: string, request: Request, signature = "") => {
      const probe = <Probe run={run} request={request} signature={signature}/>;
      await act(async () => root.render(strict ? <StrictMode>{probe}</StrictMode> : probe));
    },
    read: () => JSON.parse(div.querySelector("output")!.textContent!) as ConsistencyEditor | null,
    error: () => div.querySelector('[role="alert"]')?.textContent ?? "",
    hook: () => current,
    dispose,
  };
}

describe("useConsistencyEditor ownership", () => {
  it("keeps the selected review when the previous review finishes late", async () => {
    const a = deferred(), b = deferred();
    const request = vi.fn((input: FinanceRequest) => requestedRun(input) === runA ? a.promise : b.promise);
    const view = observe();
    await view.render(runA, request);
    await view.render(runB, request);
    expect(view.read()).toBeNull();
    await act(async () => b.resolve(editor(runB, 2)));
    await act(async () => a.resolve(editor(runA, 9)));
    expect(view.read()).toMatchObject({ run_id: runB, revision: 2 });
    expect(view.error()).toBe("");
  });

  it("ignores the previous review's late load error", async () => {
    const a = deferred(), b = deferred();
    const request = vi.fn((input: FinanceRequest) => requestedRun(input) === runA ? a.promise : b.promise);
    const view = observe();
    await view.render(runA, request);
    await view.render(runB, request);
    await act(async () => b.resolve(editor(runB)));
    await act(async () => a.reject(new Error("Review A could not load")));
    expect(view.read()?.run_id).toBe(runB);
    expect(view.error()).toBe("");
  });

  it("clears the old review error while another selected review is loading", async () => {
    const a = deferred(), b = deferred();
    const request = vi.fn((input: FinanceRequest) => requestedRun(input) === runA ? a.promise : b.promise);
    const view = observe();
    await view.render(runA, request);
    await act(async () => a.reject(new Error("Review A could not load")));
    expect(view.error()).toBe("Review A could not load");
    await view.render(runB, request);
    expect(view.read()).toBeNull();
    expect(view.error()).toBe("");
    await act(async () => b.resolve(editor(runB)));
  });

  it.each(["accepted", "dismissed"] as const)("keeps a newer %s decision when an older poll arrives", async status => {
    vi.useFakeTimers();
    const poll = deferred();
    const request = vi.fn<Request>().mockResolvedValueOnce(editor(runA, 4, true)).mockImplementation(() => poll.promise);
    const view = observe();
    await view.render(runA, request);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(request).toHaveBeenCalledTimes(2);
    const decided = { ...editor(runA, 5), decisions: { issue: { status, edits: [], at: "2031-01-01" } } };
    await act(async () => view.hook().setEditor(decided));
    await act(async () => poll.resolve(editor(runA, 4, true)));
    expect(view.read()).toMatchObject({ revision: 5, decisions: { issue: { status } } });
  });

  it("shows completed suggestions and preparation updates without a revision increase", async () => {
    vi.useFakeTimers();
    const updated = editor(runA, 4);
    updated.proposals.issue!.summary = "Newly prepared suggestion";
    const request = vi.fn<Request>().mockResolvedValueOnce(editor(runA, 4, true)).mockResolvedValue(updated);
    const view = observe();
    await view.render(runA, request);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(view.read()).toMatchObject({ revision: 4, proposals: { issue: { status: "ready", summary: "Newly prepared suggestion" } }, preparation: { status: "completed", ready: 1 } });
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("coalesces refresh and polling while a request is pending, then stops on unmount", async () => {
    vi.useFakeTimers();
    const poll = deferred();
    const request = vi.fn<Request>().mockResolvedValueOnce(editor(runA, 0, true)).mockImplementation(() => poll.promise);
    const view = observe();
    await view.render(runA, request);
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    const refresh = view.hook().refresh;
    void refresh(); void refresh();
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(2);
    await view.dispose();
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    void refresh();
    await act(async () => poll.reject(new Error("Late disconnected request")));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not submit a retained refresh from a previously selected review", async () => {
    const request = vi.fn<Request>().mockImplementation(async input => editor(requestedRun(input)));
    const view = observe();
    await view.render(runA, request);
    const oldRefresh = view.hook().refresh;
    await view.render(runB, request);
    await act(async () => oldRefresh());
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.read()?.run_id).toBe(runB);
  });

  it("does not start a queued refresh after unmount", async () => {
    const request = vi.fn<Request>().mockResolvedValue(editor());
    const view = observe();
    await view.render(runA, request);
    const pending = view.hook().refresh();
    await view.dispose();
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves functional setter updates and rejects an old review's mutation callback", async () => {
    const request = vi.fn<Request>().mockImplementation(async input => editor(requestedRun(input)));
    const view = observe();
    await view.render(runA, request);
    const oldSetter = view.hook().setEditor;
    await view.render(runB, request);
    await act(async () => oldSetter(editor(runA, 9)));
    expect(view.read()?.run_id).toBe(runB);
    await act(async () => view.hook().setEditor(previous => ({ ...previous!, revision: previous!.revision + 1 })));
    expect(view.read()).toMatchObject({ run_id: runB, revision: 1 });
  });

  it.each(["review reentry", "changed checks"])("ignores a delayed retained setter after %s", async scenario => {
    const request = vi.fn<Request>().mockImplementation(async input => editor(requestedRun(input)));
    const view = observe(), mutation = deferred<ConsistencyEditor>();
    await view.render(runA, request);
    const oldSetter = view.hook().setEditor;
    void mutation.promise.then(oldSetter);
    if (scenario === "review reentry") await view.render(runB, request);
    await view.render(runA, request, scenario === "changed checks" ? "expanded checks" : "");
    const current = editor(); current.proposals.issue!.summary = "Current owner suggestion";
    await act(async () => view.hook().setEditor(current));
    const stale = editor(); stale.proposals.issue!.summary = "Old owner suggestion";
    await act(async () => mutation.resolve(stale));
    expect(view.read()?.proposals.issue?.summary).toBe("Current owner suggestion");
  });

  it.each(["review reentry", "changed checks"])("ignores a delayed retained refresh after %s", async scenario => {
    const request = vi.fn<Request>().mockImplementation(async input => editor(requestedRun(input)));
    const view = observe(), trigger = deferred<void>();
    await view.render(runA, request);
    const oldRefresh = view.hook().refresh;
    void trigger.promise.then(oldRefresh);
    if (scenario === "review reentry") await view.render(runB, request);
    await view.render(runA, request, scenario === "changed checks" ? "expanded checks" : "");
    const count = request.mock.calls.length;
    await act(async () => trigger.resolve(undefined));
    expect(request).toHaveBeenCalledTimes(count);
  });

  it("does not replace newer same-revision suggestions after the report checks change", async () => {
    const first = deferred(), second = deferred();
    const request = vi.fn<Request>().mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    const view = observe();
    await view.render(runA, request, "first check set");
    await view.render(runA, request, "expanded check set");
    await act(async () => second.resolve(editor(runA, 4)));
    await act(async () => first.resolve(editor(runA, 4, true)));
    expect(view.read()?.preparation?.status).toBe("completed");
  });

  it("does not duplicate the initial load during StrictMode effect replay", async () => {
    const pending = deferred();
    const request = vi.fn<Request>().mockReturnValue(pending.promise);
    const view = observe(true);
    await view.render(runA, request);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(editor()));
    expect(view.read()?.run_id).toBe(runA);
  });

  it("does not refetch only because the caller creates a new request function", async () => {
    const request = vi.fn<Request>().mockResolvedValue(editor());
    const view = observe();
    await view.render(runA, input => request(input));
    await view.render(runA, input => request(input));
    await view.render(runA, input => request(input));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
