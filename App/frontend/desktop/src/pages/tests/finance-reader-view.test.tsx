// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { FinanceOpen } from "@memmy/local-api-contracts";
import { NativeFinanceReader } from "../finance-reader-view.js";
import { canAdopt, findingOf } from "../finance-findings.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const sha = "a".repeat(64);
function fixture(): FinanceOpen {
  const base = {
    id: "UNIT",
    label: "Unit",
    status: "partial_or_not_found_pending_review",
    reason: "Long technical reasoning retained for detail.",
    next_action: "Check conversion",
    clause: "28",
    rule_quote: "metric tons",
    actual_pdf_page: 22,
    kind: "automatic",
  };
  return {
    handle: crypto.randomUUID(),
    notes: { review_sha256: sha, revision: 0, decisions: {}, history: [] },
    review: {
      schema_version: "financebuddy-reader-1",
      review_sha256: sha,
      source: {
        file_name: "TEST_ONLY.pdf",
        report_fiscal_year: "2025/26",
        sha256: sha,
        language: "en",
        synthetic: true,
      },
      mode: "same_year",
      target_period: {
        fiscal_year: "2025/26",
        start: "2025-04-01",
        end: "2026-03-31",
        scenario_assumption: false,
      },
      rules: {
        status: "selected_text_matches",
        checked_at: "2026-10-27",
        scope: "12 selected checks",
      },
      status_counts: {
        evidence_present: 1,
        partial_or_not_found_pending_review: 1,
      },
      rule_url: "https://en-rules.hkex.com.hk/",
      exclusions: [],
      human_review_notice: "Not approval",
      pages: [{ number: 1, width: 600, height: 800 }],
      anchors: {
        UNIT: [
          {
            id: "ref",
            page: 1,
            quote: "Original source wording.",
            evidence_id: "PDF:test:1",
            rects: [],
            occurrences: 1,
            location_status: "exact_text_match",
            context_only: false,
          },
        ],
      },
      checks: [
        {
          ...base,
          finding: {
            level: "error",
            title: "Scope 1 單位不符",
            summary: "本稿使用 kgCO2e。",
            marks: [],
            edit: {
              kind: "replace",
              page: 1,
              evidence_id: "PDF:test:1",
              original: "Original source wording.",
              suggested: "Scope 1 emissions: 【待確認】 tCO2e.",
              requires_confirmation: true,
            },
          },
        },
        {
          ...base,
          id: "PERIOD",
          label: "已有期間",
          status: "evidence_present",
          finding: {
            level: "evidence",
            title: "已有期間",
            summary: "已找到。",
            marks: [],
            edit: null,
          },
        },
      ],
    },
  };
}
describe("Concise finance review", () => {
  it("labels a candidate-only arithmetic conflict separately from a legal rule", async () => {
    const opened = fixture();
    opened.review.checks = [{
      ...opened.review.checks[0]!, kind: "document_consistency", clause: "本稿加總",
      finding: { level: "error", title: "排放加總不一致", summary: "本稿分項與總量不一致。", marks: [], edit: null },
    }];
    const div = document.createElement("div");
    const root = createRoot(div);
    const request = vi.fn(async (r: any) => r.action === "page"
      ? { data_url: "data:image/png;base64,AA==" }
      : { review_sha256: sha, revision: 0, edits: [], history: [] });
    try {
      await act(async () => root.render(<NativeFinanceReader opened={opened} request={request} draftKey="arithmetic" draftStore={{}} />));
      expect(div.querySelector("article.selected")?.textContent).toContain("內文一致性");
      expect(div.querySelector("article.selected")?.textContent).not.toContain("C2 本稿加總");
      expect(Array.from(div.querySelectorAll("button")).find((b) => b.textContent === "規則")?.disabled).toBe(true);
      expect(div.textContent).toContain("1項加總");
      expect(div.querySelector(".finance-rewrite-toggle")).toBeNull();
    } finally { act(() => root.unmount()); }
  });
  it("never interprets a missing search result as a proven error", () => {
    const c = {
      ...fixture().review.checks[0]!,
      finding: undefined,
      status: "not_found_pending_review",
    };
    expect(findingOf(c).level).toBe("review");
  });
  it("requires completed text and explicit facts confirmation before adoption", () => {
    expect(canAdopt("Scope 1: 【待確認】 tCO2e.", true)).toBe(false);
    expect(canAdopt("Scope 1 emissions: 100 tCO2e.", false)).toBe(false);
    expect(canAdopt("Scope 1 emissions: 100 tCO2e.", true)).toBe(true);
  });
  it("opens the actual issue, collapses details and keeps existing evidence out of the default list", async () => {
    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    const opened = fixture();
    const request = vi.fn(async (r: any) =>
      r.action === "page"
        ? { data_url: "data:image/png;base64,AA==" }
        : { review_sha256: sha, revision: 0, edits: [], history: [] },
    );
    try {
      await act(async () =>
        root.render(
          <NativeFinanceReader
            opened={opened}
            request={request}
            draftKey="test"
            draftStore={{}}
          />,
        ),
      );
      expect(div.querySelector("article.selected")?.textContent).toContain(
        "Scope 1 單位不符",
      );
      expect(div.querySelector("article.selected")?.className).toContain(
        "finance-level-error",
      );
      expect(div.querySelectorAll("article")).toHaveLength(1);
      expect(
        div.querySelector("details.finance-more")?.hasAttribute("open"),
      ).toBe(false);
      await act(async () =>
        Array.from(div.querySelectorAll("button"))
          .find((b) => b.textContent?.includes("建議寫法"))!
          .click(),
      );
      expect(
        div.querySelector("textarea[aria-label='建議寫法']"),
      ).not.toBeNull();
      expect(
        Array.from(div.querySelectorAll("button")).find(
          (b) => b.textContent === "替換至草稿",
        )?.disabled,
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      div.remove();
    }
  });
});
