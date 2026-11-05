import { consistencyCheckState, type ConsistencyReport } from "@memmy/local-api-contracts";
import type { ReactNode } from "react";
import "./consistency-source-comparison.css";

type Check = ConsistencyReport["checks"][number];
type Focus = NonNullable<ConsistencyReport["source_focus"]>[string];
type Span = readonly [number, number];
type Source = { index: number; ref: Check["refs"][number]; label: string; focus: Span[] };
type SourcePair = readonly [Source[], Source[]];

function focusForReference(ref: Check["refs"][number], metadata?: Focus): Span[] {
  if (!Array.isArray(metadata)) return [];
  const matching = metadata.filter(item => item && item.slot === ref.slot && item.page === ref.page && item.quote === ref.quote);
  if (matching.length !== 1) return [];
  const phrases = matching[0]!.phrases;
  if (!Array.isArray(phrases) || !phrases.length || phrases.length > 4 || new Set(phrases).size !== phrases.length) return [];
  const spans: Span[] = [];
  for (const phrase of phrases) {
    if (typeof phrase !== "string" || !phrase.trim() || phrase !== phrase.trim() || phrase.length > 120 || phrase === ref.quote.trim()) return [];
    const start = ref.quote.indexOf(phrase);
    if (start < 0 || ref.quote.indexOf(phrase, start + 1) !== -1) return [];
    spans.push([start, start + phrase.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((span, index) => index > 0 && span[0] < spans[index - 1]![1]) ||
      spans.reduce((length, [start, end]) => length + end - start, 0) >= ref.quote.trim().length) return [];
  let cursor = 0, unemphasized = "";
  for (const [start, end] of spans) {
    unemphasized += ref.quote.slice(cursor, start);
    cursor = end;
  }
  unemphasized += ref.quote.slice(cursor);
  if (!/[\p{L}\p{N}]/u.test(unemphasized)) return [];
  return spans;
}

function sourceQuote(source: Source): ReactNode {
  if (!source.focus.length) return source.ref.quote;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of source.focus) {
    parts.push(source.ref.quote.slice(cursor, start), <strong className="consistency-source-focus" key={start}>{source.ref.quote.slice(start, end)}</strong>);
    cursor = end;
  }
  parts.push(source.ref.quote.slice(cursor));
  return parts;
}

/** Group complete bilingual evidence without dropping or merging source fragments. */
export function bilingualSourcePair(check: Check, documents: ConsistencyReport["documents"], focus?: Focus): SourcePair | null {
  if (check.regulatory || check.category === "regulatory" || check.semantic_kind !== "bilingual" ||
      !["difference", "needs_confirmation"].includes(consistencyCheckState(check)) || check.refs.length < 2 || check.refs.length > 8) return null;
  const family = check.refs[0]!.slot.replace(/_(zh|en)$/, "");
  if (!["esg", "annual", "prior_esg", "prior_annual"].includes(family) ||
      check.refs.some(ref => ref.slot !== `${family}_zh` && ref.slot !== `${family}_en`) ||
      new Set(check.refs.map(ref => JSON.stringify([ref.slot, ref.page, ref.quote]))).size !== check.refs.length) return null;
  const sources: Source[] = [];
  for (const [index, ref] of check.refs.entries()) {
    const matches = documents.filter(doc => doc.slot === ref.slot), document = matches[0];
    if (matches.length !== 1 || !document?.label.trim() || !ref.quote.trim() ||
        !Number.isInteger(ref.page) || ref.page < 1 || ref.page > document.page_count) return null;
    sources.push({ index, ref, label: document.label, focus: focusForReference(ref, focus) });
  }
  const chinese = sources.filter(source => source.ref.slot.endsWith("_zh"));
  const english = sources.filter(source => source.ref.slot.endsWith("_en"));
  if (!chinese.length || !english.length) return null;
  return [chinese, english];
}

export function ConsistencySourceComparison(props: { pair: SourcePair; onSelectRef: (index: number) => void }) {
  return <section className="consistency-source-comparison" aria-label="原文對照">
    <h4>原文對照</h4>
    <div className="consistency-source-comparison-grid">{props.pair.map((sources, side) =>
      <section className={`consistency-source-panel consistency-source-panel--${side === 0 ? "zh" : "en"}`} aria-label={side === 0 ? "中文版本" : "英文版本"} key={sources[0]!.ref.slot}>
        <strong>{side === 0 ? "中文版本" : "英文版本"}</strong>
        {sources.map((source, fragment) => <div className="consistency-source-fragment" key={source.index}>
        <button type="button" title="查看引用原頁" aria-label={`查看 ${source.label} p.${source.ref.page} 原頁${sources.length > 1 ? `，片段 ${fragment + 1}` : ""}`} onClick={() => props.onSelectRef(source.index)}>
          {source.label} · p.{source.ref.page}{source.ref.value !== undefined ? `：${source.ref.value} ${source.ref.unit_label ?? source.ref.unit ?? ""}` : ""}<span aria-hidden="true"> ↗</span>
        </button>
        <blockquote lang={side === 0 ? "zh-Hant" : "en"}>{sourceQuote(source)}</blockquote>
        </div>)}
      </section>
    )}</div>
  </section>;
}
