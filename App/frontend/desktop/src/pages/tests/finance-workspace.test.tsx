// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import {
  FinanceWorkflowCards,
  FinanceWorkspace,
} from "../finance-workspace.js";
import {
  buildFinancePrompt,
  financeWorkflowDisplayText,
} from "../finance-workflows.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
describe("FinanceBuddy guided entry", () => {
  it("exposes five understandable choices including honest waiting states", () => {
    const choose = vi.fn();
    act(() => root.render(<FinanceWorkflowCards onChoose={choose} />));
    expect(container.querySelectorAll("button")).toHaveLength(5);
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("檢查報告"))!
        .click(),
    );
    expect(choose).toHaveBeenCalledWith("review");
    expect(container.textContent).toContain("等待資料及權限");
  });
  it("builds a bounded next-year workflow without relabelling the old report", () => {
    const prompt = buildFinancePrompt({
      workflow: "review",
      mode: "next_year_readiness",
      peers: [],
    });
    expect(prompt).toContain("next_year_readiness");
    expect(prompt).toContain("不得把上年數據視為今年數據");
    expect(prompt).toContain("review.json");
  });
  it("requires selected official peers and carries provenance/comparability requirements", () => {
    expect(() =>
      buildFinancePrompt({ workflow: "peers", mode: "same_year", peers: [] }),
    ).toThrow();
    const prompt = buildFinancePrompt({
      workflow: "peers",
      mode: "same_year",
      peers: ["Truly International（信利國際，00732）"],
    });
    expect(prompt).toContain("read_public_report");
    expect(prompt).toContain("不可直接排名");
    expect(prompt).toContain("export_peer_comparison");
    expect(prompt).toContain(
      "第一步必須呼叫 mcp_financebuddy_reports_build_peer_comparison",
    );
  });
  it("shows a plain-language task summary only for an exact app-generated workflow", () => {
    const prompt = buildFinancePrompt({
      workflow: "review",
      mode: "same_year",
      peers: [],
    });
    expect(financeWorkflowDisplayText(prompt)).toContain("檢查億都 FY2025/26");
    expect(financeWorkflowDisplayText(prompt)).not.toContain("SKILL.md");
    expect(
      financeWorkflowDisplayText(prompt + "\nUser additional instructions"),
    ).toBeNull();
  });
  it("starts the review with defaults without requiring text entry", async () => {
    const launch = vi.fn(async (_prompt: string) => {});
    const client = {
      getFinanceCatalog: vi.fn(async () => ({
        reviews: [],
        unavailable: [],
        scope: "C2",
      })),
    } as unknown as MemmyAgentClient;
    await act(async () =>
      root.render(
        <FinanceWorkspace
          visible
          client={client}
          initialPath={null}
          workflow="review"
          busy={false}
          onChoose={() => {}}
          onLaunch={launch}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent === "開始此工作")!
        .click(),
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toContain("same_year");
  });
  it("does not offer an unimplemented source integration action", async () => {
    const launch = vi.fn(async (_prompt: string) => {});
    const client = {
      getFinanceCatalog: vi.fn(async () => ({
        reviews: [],
        unavailable: [],
        scope: "C2",
      })),
    } as unknown as MemmyAgentClient;
    await act(async () =>
      root.render(
        <FinanceWorkspace
          visible
          client={client}
          initialPath={null}
          workflow="sources"
          busy={false}
          onChoose={() => {}}
          onLaunch={launch}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("等待 Mavis");
    expect(container.textContent).not.toContain("開始此工作");
    expect(launch).not.toHaveBeenCalled();
  });
});
