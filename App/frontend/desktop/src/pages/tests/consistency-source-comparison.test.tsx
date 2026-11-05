// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ConsistencyReport } from "@memmy/local-api-contracts";
import { bilingualSourcePair, ConsistencySourceComparison } from "../consistency-source-comparison.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type Check = ConsistencyReport["checks"][number];
const chineseQuote = "目前\n     未將節能減排目標進度指標納入薪酬政策。";
const englishQuote = "At present, climate-related considerations have not been included in the remuneration policies.";
function fixture(): { check: Check; documents: ConsistencyReport["documents"] } {
  return {
    check: { id: "salary", category: "basis", semantic_kind: "bilingual", status: "difference", title: "薪酬未包括哪些氣候指標？", reason: "請確認否定範圍。", refs: [
      { slot: "esg_en", page: 4, quote: englishQuote, highlight_texts: ["climate-related considerations"] },
      { slot: "esg_zh", page: 3, quote: chineseQuote },
    ] },
    documents: (["esg_zh", "esg_en", "annual_en"] as const).map(slot => ({ slot, label: slot === "esg_zh" ? "ESG · 繁中" : slot === "esg_en" ? "ESG · English" : "年報 · English", file_name: `${slot}.pdf`, sha256: "a".repeat(64), page_count: 4, cover_year_found: true, identity_confirmed: true, textless_pages: [] })),
  };
}

describe("Bilingual source comparison", () => {
  it("groups three references while keeping same-page excerpts and their citations separate", async () => {
    const { check, documents } = fixture();
    check.refs.push({ slot: "esg_en", page: 4, quote: "A second English excerpt describes a separate safety procedure." });
    const pair = bilingualSourcePair(check, documents);
    expect(pair).not.toBeNull();
    const div = document.createElement("div"), root = createRoot(div), onSelectRef = vi.fn();
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={pair!} onSelectRef={onSelectRef} />));
      const panels = div.querySelectorAll(".consistency-source-panel");
      expect(panels).toHaveLength(2);
      expect(Array.from(panels[0]!.querySelectorAll("blockquote")).map(quote => quote.textContent)).toEqual([chineseQuote]);
      expect(Array.from(panels[1]!.querySelectorAll("blockquote")).map(quote => quote.textContent)).toEqual([englishQuote, check.refs[2]!.quote]);
      await act(async () => panels[1]!.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
      expect(onSelectRef).toHaveBeenCalledWith(2);
    } finally { act(() => root.unmount()); }
  });
  it.each([2, 1, 2, 4].flatMap((chinese, index) => [false, true].map(reverse => ({ chinese, english: [1, 2, 2, 4][index]!, reverse }))))("keeps every $chinese+$english source fragment, exact focus and citation with reverse=$reverse", async ({ chinese, english, reverse }) => {
    const { check, documents } = fixture();
    check.refs = [];
    for (let index = 0; index < Math.max(chinese, english); index++) {
      if (index < english) check.refs.push({ slot: "esg_en", page: 3, quote: `English excerpt ${index + 1} describes energy scope.\nKeep this original text.` });
      if (index < chinese) check.refs.push({ slot: "esg_zh", page: index + 1, quote: `中文來源${index + 1}列出能源範圍。\n保留這段原文。` });
    }
    if (reverse) check.refs.reverse();
    const metadata = check.refs.map(({ slot, page, quote }) => ({ slot, page, quote, phrases: [slot === "esg_zh" ? "能源" : "energy"] }));
    const original = JSON.stringify(check), pair = bilingualSourcePair(check, documents, metadata)!;
    expect(pair).not.toBeNull();
    const div = document.createElement("div"), root = createRoot(div), onSelectRef = vi.fn();
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={pair} onSelectRef={onSelectRef} />));
      const panels = div.querySelectorAll(".consistency-source-panel"), expectedIndices: number[] = [];
      expect(panels).toHaveLength(2);
      for (const [side, slot] of (["esg_zh", "esg_en"] as const).entries()) {
        const expected = check.refs.map((ref, index) => ({ ref, index })).filter(source => source.ref.slot === slot);
        const fragments = panels[side]!.querySelectorAll(".consistency-source-fragment");
        expect(fragments).toHaveLength(expected.length);
        for (const [index, source] of expected.entries()) {
          const fragment = fragments[index]!, quote = fragment.querySelector("blockquote")!, button = fragment.querySelector<HTMLButtonElement>("button")!;
          expect(quote.textContent).toBe(source.ref.quote);
          expect(quote.getAttribute("lang")).toBe(side === 0 ? "zh-Hant" : "en");
          expect(quote.querySelector("strong")!.textContent).toBe(side === 0 ? "能源" : "energy");
          expect(button.textContent).toContain(`${documents.find(doc => doc.slot === slot)!.label} · p.${source.ref.page}`);
          if (expected.length > 1) expect(button.getAttribute("aria-label")).toContain(`片段 ${index + 1}`);
          await act(async () => button.click());
          expectedIndices.push(source.index);
        }
      }
      expect(onSelectRef.mock.calls).toEqual(expectedIndices.map(index => [index]));
      expect(div.querySelectorAll("blockquote")).toHaveLength(check.refs.length);
      expect(JSON.stringify(check)).toBe(original);
    } finally { act(() => root.unmount()); }
  });
  it.each([false, true])("keeps language, document, page and exact quote associated with reversed=%s", async reverse => {
    const { check, documents } = fixture();
    if (reverse) check.refs.reverse();
    const pair = bilingualSourcePair(check, documents)!;
    const onSelectRef = vi.fn(), div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={pair} onSelectRef={onSelectRef} />));
      const panels = div.querySelectorAll(".consistency-source-panel");
      expect(panels).toHaveLength(2);
      expect(panels[0]!.getAttribute("aria-label")).toBe("中文版本");
      expect(panels[1]!.getAttribute("aria-label")).toBe("英文版本");
      expect(panels[0]!.querySelector("button")!.textContent).toBe("ESG · 繁中 · p.3 ↗");
      expect(panels[1]!.querySelector("button")!.textContent).toBe("ESG · English · p.4 ↗");
      expect(panels[0]!.querySelector("blockquote")!.textContent).toBe(chineseQuote);
      expect(panels[1]!.querySelector("blockquote")!.textContent).toBe(englishQuote);
      expect(panels[0]!.querySelector("blockquote")!.lang).toBe("zh-Hant");
      expect(panels[1]!.querySelector("blockquote")!.lang).toBe("en");
      expect(div.querySelectorAll("blockquote strong")).toHaveLength(0);
      expect(div.querySelectorAll("mark,ins,del")).toHaveLength(0);
      expect(div.textContent).not.toMatch(/正確|錯誤|應採用|較好|較差/);
      await act(async () => panels[0]!.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () => panels[1]!.querySelector<HTMLButtonElement>("button")!.click());
      expect(onSelectRef.mock.calls).toEqual(reverse ? [[0], [1]] : [[1], [0]]);
    } finally { act(() => root.unmount()); }
  });

  it.each([false, true])("bolds only supplied exact phrases without changing evidence or quote text, reversed=%s", async reverse => {
    const { check, documents } = fixture();
    if (reverse) check.refs.reverse();
    const metadata = check.refs.map(({ slot, page, quote }) => ({ slot, page, quote, phrases: [slot === "esg_zh" ? "節能減排目標進度指標" : "climate-related considerations"] }));
    const original = JSON.stringify({ check, metadata });
    const div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={bilingualSourcePair(check, documents, metadata)!} onSelectRef={() => {}} />));
      expect(Array.from(div.querySelectorAll("blockquote strong")).map(element => element.textContent)).toEqual(["節能減排目標進度指標", "climate-related considerations"]);
      expect(Array.from(div.querySelectorAll("blockquote")).map(element => element.textContent)).toEqual([chineseQuote, englishQuote]);
      expect(div.querySelectorAll("mark,ins,del")).toHaveLength(0);
      expect(JSON.stringify({ check, metadata })).toBe(original);
    } finally { act(() => root.unmount()); }
  });

  it.each([
    "stale quote", "wrong page", "wrong slot", "missing phrase", "case mismatch", "empty phrases", "whitespace phrase",
    "whole quote", "whole meaningful quote", "combined meaningful quote", "all words separated by whitespace", "all words surrounded by punctuation", "leading whitespace", "trailing whitespace",
    "overlong phrase", "too many phrases", "duplicate phrases", "overlap", "repeated text", "duplicate metadata", "conflicting metadata",
  ])("keeps a quote plain for %s focus metadata", async failure => {
    const { check, documents } = fixture(), ref = check.refs[0]!;
    if (failure === "repeated text") ref.quote = "Policy scope, then policy scope; policy scope.";
    if (failure === "overlong phrase") ref.quote = `${"x".repeat(121)} end`;
    if (failure === "whole meaningful quote") ref.quote = ` \n${englishQuote} \n`;
    if (failure === "combined meaningful quote") ref.quote = " \npolicy:scope \n";
    if (failure === "all words separated by whitespace") ref.quote = "Alpha Beta";
    if (failure === "all words surrounded by punctuation") ref.quote = "Alpha, Beta.";
    const annotation = { slot: ref.slot, page: ref.page, quote: ref.quote, phrases: ["climate-related considerations"] };
    const metadata = [annotation];
    if (failure === "stale quote") annotation.quote += " Revised.";
    if (failure === "wrong page") annotation.page = 2;
    if (failure === "wrong slot") annotation.slot = "annual_en";
    if (failure === "missing phrase") annotation.phrases = ["unsupported phrase"];
    if (failure === "case mismatch") annotation.phrases = ["Climate-related considerations"];
    if (failure === "empty phrases") annotation.phrases = [];
    if (failure === "whitespace phrase") annotation.phrases = [" "];
    if (failure === "whole quote") annotation.phrases = [ref.quote];
    if (failure === "whole meaningful quote") annotation.phrases = [ref.quote.trim()];
    if (failure === "combined meaningful quote") annotation.phrases = ["policy:", "scope"];
    if (failure === "all words separated by whitespace" || failure === "all words surrounded by punctuation") annotation.phrases = ["Alpha", "Beta"];
    if (failure === "leading whitespace") annotation.phrases = [" climate-related considerations"];
    if (failure === "trailing whitespace") annotation.phrases = ["climate-related considerations "];
    if (failure === "overlong phrase") annotation.phrases = ["x".repeat(121)];
    if (failure === "too many phrases") annotation.phrases = ["At", "present", "climate-related", "considerations", "remuneration"];
    if (failure === "duplicate phrases") annotation.phrases.push(annotation.phrases[0]!);
    if (failure === "overlap") annotation.phrases.push("considerations");
    if (failure === "repeated text") annotation.phrases = ["policy scope"];
    if (failure === "duplicate metadata") metadata.push({ ...annotation });
    if (failure === "conflicting metadata") metadata.push({ ...annotation, phrases: ["remuneration policies"] });
    const div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={bilingualSourcePair(check, documents, metadata)!} onSelectRef={() => {}} />));
      expect(div.querySelectorAll("blockquote strong")).toHaveLength(0);
      expect(div.querySelector('blockquote[lang="en"]')!.textContent).toBe(ref.quote);
      expect(div.querySelector('blockquote[lang="zh-Hant"]')!.textContent).toBe(chineseQuote);
    } finally { act(() => root.unmount()); }
  });

  it("keeps partial emphasis when an unemphasized word remains", async () => {
    const { check, documents } = fixture(), ref = check.refs[0]!;
    ref.quote = "Alpha, Beta. Gamma";
    const phrases = ["Alpha", "Beta"];
    const metadata = [{ slot: ref.slot, page: ref.page, quote: ref.quote, phrases }];
    const div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={bilingualSourcePair(check, documents, metadata)!} onSelectRef={() => {}} />));
      const quote = div.querySelector('blockquote[lang="en"]')!;
      expect(quote.textContent).toBe(ref.quote);
      expect(Array.from(quote.querySelectorAll("strong")).map(element => element.textContent)).toEqual(phrases);
    } finally { act(() => root.unmount()); }
  });

  it("renders HTML-like and Markdown-like focus phrases as exact text", async () => {
    const { check, documents } = fixture(), ref = check.refs[0]!;
    ref.quote = "A <img src=x onerror=alert(1)> policy **must** remain.";
    const phrases = ["<img src=x onerror=alert(1)>", "**must**"];
    const metadata = [{ slot: ref.slot, page: ref.page, quote: ref.quote, phrases }];
    const div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={bilingualSourcePair(check, documents, metadata)!} onSelectRef={() => {}} />));
      const quote = div.querySelector('blockquote[lang="en"]')!;
      expect(quote.textContent).toBe(ref.quote);
      expect(Array.from(quote.querySelectorAll("strong")).map(element => element.textContent)).toEqual(phrases);
      expect(quote.querySelectorAll("img,script,b,em")).toHaveLength(0);
    } finally { act(() => root.unmount()); }
  });

  it("supports a needs-confirmation pair without assigning a verdict to either source", () => {
    const { check, documents } = fixture();
    check.status = "pending"; check.review_state = "needs_confirmation";
    expect(bilingualSourcePair(check, documents)?.map(sources => sources.map(source => source.ref.slot))).toEqual([["esg_zh"], ["esg_en"]]);
  });

  it("preserves a reference's displayed value and unit alongside its citation", async () => {
    const { check, documents } = fixture();
    Object.assign(check.refs[1]!, { value: "12", unit: "tCO2e", unit_label: "公噸 CO₂e" });
    const div = document.createElement("div"), root = createRoot(div);
    try {
      await act(async () => root.render(<ConsistencySourceComparison pair={bilingualSourcePair(check, documents)!} onSelectRef={() => {}} />));
      expect(div.querySelector("button")!.textContent).toBe("ESG · 繁中 · p.3：12 公噸 CO₂e ↗");
      expect(div.querySelector("blockquote")!.textContent).toBe(chineseQuote);
    } finally { act(() => root.unmount()); }
  });

  it.each([
    "missing reference", "empty quote", "whitespace quote", "missing document", "empty document label", "out-of-range page",
    "same language", "different reports", "different periods", "extra references", "non-bilingual", "matched", "regulatory",
    "invalid extra quote", "unknown extra source", "out-of-range extra page", "fractional page", "ambiguous document", "nine references",
  ])("leaves %s to the original details layout", failure => {
    const { check, documents } = fixture();
    if (failure === "missing reference") check.refs.pop();
    if (failure === "empty quote") check.refs[0]!.quote = "";
    if (failure === "whitespace quote") check.refs[0]!.quote = " \n ";
    if (failure === "missing document") documents.splice(0, 1);
    if (failure === "empty document label") documents[0]!.label = " ";
    if (failure === "out-of-range page") check.refs[0]!.page = 5;
    if (failure === "same language") check.refs[0]!.slot = "esg_zh";
    if (failure === "different reports") check.refs[0]!.slot = "annual_en";
    if (failure === "different periods") { documents.push({ ...documents[1]!, slot: "prior_esg_en" }); check.refs[0]!.slot = "prior_esg_en"; }
    if (failure === "extra references") check.refs.push({ ...check.refs[0]! });
    if (failure === "non-bilingual") check.semantic_kind = "cross_report";
    if (failure === "matched") check.status = "matched";
    if (failure === "regulatory") check.category = "regulatory";
    if (failure === "invalid extra quote") check.refs.push({ slot: "esg_en", page: 4, quote: "" });
    if (failure === "unknown extra source") check.refs.push({ slot: "prior_esg_en", page: 2, quote: "Unknown additional document." });
    if (failure === "out-of-range extra page") check.refs.push({ slot: "esg_en", page: 5, quote: "Invalid additional page." });
    if (failure === "fractional page") check.refs[0]!.page = 1.5;
    if (failure === "ambiguous document") documents.push({ ...documents[0]! });
    if (failure === "nine references") for (let index = 0; index < 7; index++) check.refs.push({ slot: "esg_zh", page: 2, quote: `Additional unique quotation ${index}.` });
    expect(bilingualSourcePair(check, documents)).toBeNull();
  });
});
