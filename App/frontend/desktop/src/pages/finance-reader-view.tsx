import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Search,
  ZoomIn,
  ZoomOut,
  Undo2,
  Check,
  AlertCircle,
  HelpCircle,
  Lightbulb,
} from "lucide-react";
import {
  FinanceDraftSchema,
  FinanceDraftExportSchema,
  FinanceNotesSchema,
  type FinanceDraft,
  type FinanceOpen,
  type FinanceRequest,
  type FinanceNoteWrite,
} from "@memmy/local-api-contracts";
import {
  findingOf,
  findingOrder,
  FINDING_LABELS,
  canAdopt,
  type FindingLevel,
} from "./finance-findings.js";

type Drafts = Record<
  string,
  { decision: FinanceNoteWrite["decision"]; note: string }
>;
const DECISIONS = {
  open: "尚未標記",
  confirmed_gap: "確認問題",
  needs_data: "等待補件",
  not_an_issue: "毋須更改",
  resolved: "已處理／待覆核",
};
const ICONS = {
  error: AlertCircle,
  review: HelpCircle,
  suggestion: Lightbulb,
  evidence: Check,
};
function download(text: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function NativeFinanceReader(props: {
  opened: FinanceOpen;
  request: (r: FinanceRequest) => Promise<unknown>;
  draftKey: string;
  draftStore: Record<string, Drafts>;
}) {
  const { review, handle } = props.opened;
  const ordered = [...review.checks].sort(
    (a, b) => findingOrder(a) - findingOrder(b),
  );
  const first = ordered[0]!;
  const [selected, setSelected] = useState(first.id),
    [reference, setReference] = useState(0);
  const [page, setPage] = useState(review.anchors[first.id]?.[0]?.page ?? 1);
  const [kind, setKind] = useState<"page" | "rule">("page");
  const [image, setImage] = useState(""),
    [imageError, setImageError] = useState("");
  const [zoom, setZoom] = useState(1),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("actionable");
  const [notes, setNotes] = useState(props.opened.notes),
    [drafts, setDrafts] = useState<Drafts>(
      () => props.draftStore[props.draftKey] ?? {},
    );
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [scope, setScope] = useState(false);
  const [revision, setRevision] = useState<FinanceDraft | null>(null),
    [draftText, setDraftText] = useState<Record<number, string>>({});
  const [draftPreview, setDraftPreview] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const [wordings, setWordings] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [draftBusy, setDraftBusy] = useState(false);
  const imageScroll = useRef<HTMLDivElement>(null),
    pageImage = useRef<HTMLImageElement>(null),
    issueScroll = useRef<HTMLDivElement>(null);
  const check = review.checks.find((c) => c.id === selected)!;
  const finding = findingOf(check),
    anchors = review.anchors[selected] ?? [],
    anchor = anchors[reference];
  const pageInfo = review.pages[page - 1],
    max = kind === "rule" ? 27 : review.pages.length;
  const current = drafts[selected] ??
    notes.decisions[selected] ?? { decision: "open" as const, note: "" };
  const applied = revision?.edits.filter((e) => e.active) ?? [];
  const accepted = applied.find((e) => e.check_id === selected);
  const counts = Object.fromEntries(
    Object.keys(FINDING_LABELS).map((level) => [
      level,
      review.checks.filter((c) => findingOf(c).level === level).length,
    ]),
  );
  useEffect(() => {
    props.draftStore[props.draftKey] = drafts;
  }, [drafts, props.draftKey]);
  useEffect(() => {
    let active = true;
    void props
      .request({ action: "drafts", handle })
      .then((v) => {
        if (active) setRevision(FinanceDraftSchema.parse(v));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [handle]);
  useEffect(() => {
    if (!draftPreview) return;
    let active = true;
    void props
      .request({ action: "draft-export", handle })
      .then((v) => {
        const result = FinanceDraftExportSchema.parse(v);
        if (active) {
          setRevision(result.draft);
          setDraftText(
            Object.fromEntries(result.pages.map((p) => [p.number, p.text])),
          );
        }
      })
      .catch((e) => {
        if (active) setMessage(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [draftPreview, revision?.revision, handle]);
  function scrollToAnchor() {
    const img = pageImage.current,
      scroll = imageScroll.current;
    if (!img?.complete || !img.naturalHeight || !scroll) return;
    const mark = finding.marks.find((m) => m.page === page)?.rects[0];
    const rect =
      kind === "page"
        ? (mark ?? (anchor?.page === page ? anchor.rects[0] : undefined))
        : undefined;
    const y =
      rect && pageInfo ? (rect[1] / pageInfo.height) * img.clientHeight : 0;
    scroll.scrollTo({ top: Math.max(0, y - scroll.clientHeight * 0.3) });
  }
  useEffect(scrollToAnchor, [
    selected,
    reference,
    kind,
    page,
    image,
    draftPreview,
  ]);
  useEffect(() => {
    const list = issueScroll.current,
      card = list?.querySelector<HTMLElement>("article.selected");
    if (list && card)
      list.scrollTo({
        top:
          list.scrollTop +
          card.getBoundingClientRect().top -
          list.getBoundingClientRect().top,
      });
  }, [selected, filter]);
  useEffect(() => {
    let active = true;
    setImage("");
    setImageError("");
    if (!draftPreview)
      void props
        .request({ action: kind, handle, page })
        .then((r) => {
          if (active) setImage((r as { data_url: string }).data_url);
        })
        .catch((e) => {
          if (active) setImageError(errorText(e));
        });
    return () => {
      active = false;
    };
  }, [kind, page, handle, draftPreview]);
  function choose(id: string, ref = 0) {
    setSelected(id);
    setReference(ref);
    setMessage("");
    const a = review.anchors[id]?.[ref],
      mark = findingOf(review.checks.find((c) => c.id === id)!).marks[0];
    if (a || mark) {
      setKind("page");
      setPage(a?.page ?? mark!.page);
    }
    if (
      filter !== "all" &&
      filter !== "actionable" &&
      findingOf(review.checks.find((c) => c.id === id)!).level !== filter
    )
      setFilter("all");
  }
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      setNotes(
        FinanceNotesSchema.parse(
          await props.request({
            action: "save",
            handle,
            value: {
              expected_revision: notes.revision,
              check_id: selected,
              ...current,
            },
          }),
        ),
      );
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[selected];
        return next;
      });
      setMessage("標記已保存。");
    } catch (e) {
      if ((e as { status?: number }).status === 409)
        setNotes(
          FinanceNotesSchema.parse(
            await props.request({ action: "decisions", handle }),
          ),
        );
      setMessage(errorText(e) + "（備註草稿保留）");
    } finally {
      setSaving(false);
    }
  }
  async function changeDraft(operation: "accept" | "undo") {
    if (!revision) return;
    setDraftBusy(true);
    setMessage("");
    try {
      const next = FinanceDraftSchema.parse(
        await props.request({
          action: "draft-save",
          handle,
          value: {
            expected_revision: revision.revision,
            check_id: selected,
            operation,
            ...(operation === "accept"
              ? {
                  replacement:
                    wordings[selected] ?? finding.edit?.suggested ?? "",
                  facts_confirmed: confirmed[selected] === true,
                }
              : {}),
          },
        }),
      );
      setRevision(next);
      setDraftPreview(true);
      setKind("page");
      setPage(finding.edit?.page ?? page);
      setEditing(null);
      setMessage(
        operation === "accept" ? "已採用至草稿；待覆核。" : "已還原此項修訂。",
      );
    } catch (e) {
      if ((e as { status?: number }).status === 409)
        setRevision(
          FinanceDraftSchema.parse(
            await props.request({ action: "drafts", handle }),
          ),
        );
      setMessage(errorText(e));
    } finally {
      setDraftBusy(false);
    }
  }
  async function exportFile(
    action:
      | "notes-export"
      | "checklist-export"
      | "requests-export"
      | "draft-export",
    audit = false,
  ) {
    try {
      const result = await props.request({ action, handle });
      if (action === "draft-export") {
        const v = FinanceDraftExportSchema.parse(result);
        download(
          audit ? JSON.stringify(v.draft, null, 2) : v.text,
          audit ? "report-changes.json" : "report-draft.txt",
          audit ? "application/json" : "text/plain;charset=utf-8",
        );
      } else
        download(
          (result as { text: string }).text,
          action === "notes-export"
            ? "reviewer-notes.json"
            : action === "checklist-export"
              ? "checklist.csv"
              : "data-requests.csv",
          action === "notes-export"
            ? "application/json"
            : "text/csv;charset=utf-8",
        );
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  const visible = ordered.filter(
    (c) =>
      [c.label, c.id, c.reason, c.next_action, findingOf(c).title]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "actionable"
          ? findingOf(c).level !== "evidence"
          : findingOf(c).level === filter)),
  );
  useEffect(() => {
    if (visible.length && !visible.some((c) => c.id === selected)) choose(visible[0]!.id);
  }, [filter, query, selected]);
  return (
    <div className="finance-reader finance-reader--concise">
      <div className="finance-document-head">
        <div>
          <strong title={review.source.file_name}>
            {review.source.synthetic
              ? "TEST ONLY · 錯漏副本"
              : review.source.file_name}
          </strong>
          <small>
            {review.source.report_fiscal_year}
            {review.mode === "next_year_readiness"
              ? ` → ${review.target_period.fiscal_year} 準備度`
              : " · ESG 核對"}{" "}
            · {review.checks.filter((c) => c.kind !== "document_consistency").length}
            項規則
            {review.checks.some((c) => c.kind === "document_consistency") &&
              ` · ${review.checks.filter((c) => c.kind === "document_consistency").length}項加總`}
          </small>
        </div>
        <button onClick={() => setScope(!scope)} aria-expanded={scope}>
          範圍與版本
        </button>
      </div>
      {review.source.synthetic && (
        <p className="finance-test-notice" role="status">
          測試副本 · 問題不代表公司正式披露
        </p>
      )}
      {scope && (
        <div className="finance-scope finance-reader-scope">
          <strong>
            {review.rules.status === "selected_text_matches"
              ? "選定條文已核實"
              : "規則版本未確認"}
          </strong>
          <p>
            {review.rules.checked_at} · {review.rules.scope}
          </p>
          <p>{review.source.file_name}</p>
          <p>以待審稿及選定規則核對；沒有本年標準答案。全文敘述一致性及去年承諾銜接仍未完成。</p>
          <p>{review.human_review_notice}</p>
          <ul>
            {review.exclusions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="finance-reader-body">
        <section className="finance-document" aria-label="原件閱讀區">
          <div className="finance-document-toolbar">
            <button
              aria-pressed={!draftPreview && kind === "page"}
              onClick={() => {
                setDraftPreview(false);
                setKind("page");
                setPage(anchor?.page ?? 1);
              }}
            >
              待審稿
            </button>
            <button
              aria-pressed={draftPreview}
              disabled={!revision}
              onClick={() => {
                setDraftPreview(true);
                setKind("page");
              }}
            >
              修訂稿{applied.length ? ` · ${applied.length}` : ""}
            </button>
            <button
              aria-pressed={!draftPreview && kind === "rule"}
              disabled={check.kind === "document_consistency"}
              onClick={() => {
                setDraftPreview(false);
                setKind("rule");
                setPage(check.actual_pdf_page);
              }}
            >
              規則
            </button>
            <span className="finance-toolbar-divider" />
            <button
              aria-label="上一頁"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <input
              aria-label="實際 PDF 頁碼"
              type="number"
              min={1}
              max={max}
              value={page}
              onChange={(e) => {
                const n = +e.target.value;
                if (Number.isInteger(n) && n >= 1 && n <= max) setPage(n);
              }}
            />
            <span>/ {max}</span>
            <button
              aria-label="下一頁"
              disabled={page >= max}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={15} />
            </button>
            {!draftPreview && (
              <>
                <button
                  aria-label="縮小"
                  onClick={() => setZoom(Math.max(0.7, zoom - 0.2))}
                >
                  <ZoomOut size={15} />
                </button>
                <button aria-label="符合頁寬" onClick={() => setZoom(1)}>
                  <Maximize2 size={14} />
                </button>
                <button
                  aria-label="放大"
                  onClick={() => setZoom(Math.min(2, zoom + 0.2))}
                >
                  <ZoomIn size={15} />
                </button>
              </>
            )}
          </div>
          <div className="finance-location">
            {draftPreview
              ? `修訂草稿 · 第${page}頁 · 文字版，未重建PDF版式`
              : kind === "rule"
                ? `C2 ${check.clause} · 規則第${page}頁`
                : `第${page}頁 · ${finding.title}`}
          </div>
          <div className="finance-paper-scroll" ref={imageScroll}>
            {draftPreview ? (
              <div className="finance-draft-page">
                <div className="finance-draft-label">
                  {review.source.synthetic ? "TEST ONLY · " : ""}修訂草稿 ·
                  待覆核
                </div>
                {draftText[page] ? (
                  <pre>{draftText[page]}</pre>
                ) : (
                  <p role="status">載入草稿…</p>
                )}
              </div>
            ) : (
              <>
                {!image && <p role="status">{imageError || "載入原頁…"}</p>}
                {image && (
                  <div
                    className="finance-paper"
                    style={{ width: `${zoom * 100}%` }}
                  >
                    <img
                      ref={pageImage}
                      src={image}
                      alt={`${kind === "page" ? "報告" : "規則"}原件 PDF ${page}`}
                      onLoad={scrollToAnchor}
                    />
                    {kind === "page" && pageInfo && (
                      <svg
                        viewBox={`0 0 ${pageInfo.width} ${pageInfo.height}`}
                        aria-label="問題及引用高亮"
                      >
                        {anchors
                          .filter((a) => a.page === page)
                          .flatMap((a) =>
                            a.rects.map((r, i) => (
                              <rect
                                key={`${a.id}:${i}`}
                                className="finance-reference-mark"
                                x={r[0] - 1}
                                y={r[1] - 1}
                                width={r[2] - r[0] + 2}
                                height={r[3] - r[1] + 2}
                              >
                                <title>引用依據：{a.quote}</title>
                              </rect>
                            )),
                          )}
                        {review.checks.flatMap((c) =>
                          findingOf(c)
                            .marks.filter((m) => m.page === page)
                            .flatMap((m) =>
                              m.rects.map((r, i) => (
                                <g
                                  key={`${c.id}:${i}`}
                                  className={`finance-problem-mark${m.empty ? " finance-problem-mark--empty" : ""}`}
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`查看問題：${findingOf(c).title}`}
                                  onClick={() => choose(c.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      choose(c.id);
                                    }
                                  }}
                                >
                                  <rect
                                    x={r[0] - 1}
                                    y={r[1] - 1}
                                    width={r[2] - r[0] + 2}
                                    height={r[3] - r[1] + 2}
                                  />
                                  <title>{findingOf(c).title}</title>
                                </g>
                              )),
                            ),
                        )}
                      </svg>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <p className="finance-highlight-note">
            <span className="finance-key-dot error" />
            紅色：明確問題／漏欄 <span className="finance-key-dot reference" />
            淡黃：引用依據
          </p>
        </section>
        <section className="finance-findings" aria-label="核對項目及建議">
          <div className="finance-findings-toolbar">
            <div className="finance-level-tabs" aria-label="問題分類">
              {(["error", "review", "suggestion"] as FindingLevel[]).map(
                (level) => {
                  const Icon = ICONS[level];
                  return (
                    <button
                      key={level}
                      className={`finance-level-tab finance-level-${level}`}
                      aria-pressed={filter === level}
                      onClick={() =>
                        setFilter(filter === level ? "actionable" : level)
                      }
                    >
                      <Icon size={13} />
                      {FINDING_LABELS[level]} <b>{counts[level]}</b>
                    </button>
                  );
                },
              )}
            </div>
            <div className="finance-findings-controls">
              <label>
                <Search size={14} />
                <input
                  aria-label="搜尋核對項目"
                  placeholder="搜尋問題"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                aria-label="篩選核對狀態"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="actionable">待處理</option>
                <option value="all">全部 {review.checks.length}項</option>
                {Object.entries(FINDING_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label} {counts[v]}
                  </option>
                ))}
              </select>
            </div>
            <small className="finance-legend">
              紅色有原文證據；黃色仍需確認。均非合規裁決。
            </small>
          </div>
          <div className="finance-issue-list" ref={issueScroll}>
            {!visible.length && (
              <p className="finance-empty">沒有符合的項目。</p>
            )}
            {visible.map((c) => {
              const f = findingOf(c),
                active = c.id === selected,
                Icon = ICONS[f.level];
              return (
                <article
                  key={c.id}
                  className={`finance-level-${f.level}${active ? " selected" : ""}`}
                >
                  <button
                    className="finance-issue-title"
                    aria-expanded={active}
                    onClick={() => choose(c.id)}
                  >
                    <Icon size={16} />
                    <strong>
                      {f.title}
                      <small>
                        {FINDING_LABELS[f.level]} ·{" "}
                        {c.kind === "document_consistency"
                          ? "內文一致性"
                          : `C2 ${c.clause}`}
                      </small>
                    </strong>
                    {applied.some((e) => e.check_id === c.id) && (
                      <em className="finance-applied">已採用</em>
                    )}
                  </button>
                  {active && (
                    <div className="finance-issue-detail">
                      <div className="finance-brief-row">
                        <span>原因</span>
                        <p>{f.summary}</p>
                      </div>
                      <div className="finance-brief-row">
                        <span>引用</span>
                        <div className="finance-citations">
                          {anchors.map((a, i) => (
                            <button
                              key={a.id}
                              aria-pressed={
                                reference === i &&
                                kind === "page" &&
                                !draftPreview
                              }
                              onClick={() => {
                                setDraftPreview(false);
                                choose(c.id, i);
                              }}
                            >
                              報告 p.{a.page}
                            </button>
                          ))}
                          {c.kind !== "document_consistency" && (
                            <button
                              onClick={() => {
                                setDraftPreview(false);
                                setKind("rule");
                                setPage(c.actual_pdf_page);
                              }}
                            >
                              C2 {c.clause} ↗
                            </button>
                          )}
                        </div>
                      </div>
                      {!accepted && f.edit && (
                        <button
                          className="finance-rewrite-toggle"
                          aria-expanded={editing === c.id}
                          onClick={() => {
                            setEditing(editing === c.id ? null : c.id);
                            if (!wordings[c.id])
                              setWordings((v) => ({
                                ...v,
                                [c.id]: f.edit!.suggested,
                              }));
                          }}
                        >
                          <Lightbulb size={14} />
                          {f.edit.kind === "replace"
                            ? "建議寫法"
                            : "建議補充內容"}
                        </button>
                      )}
                      {accepted && (
                        <div className="finance-adopted">
                          <Check size={14} />已
                          {accepted.kind === "replace" ? "替換" : "新增"}至草稿
                          <button
                            disabled={draftBusy}
                            onClick={() => void changeDraft("undo")}
                          >
                            <Undo2 size={13} />
                            還原
                          </button>
                          <details>
                            <summary>查看改動</summary>
                            <del>{accepted.original || "（新增披露）"}</del>
                            <ins>{accepted.replacement}</ins>
                          </details>
                        </div>
                      )}
                      {editing === c.id && f.edit && !accepted && (
                        <div className="finance-rewrite">
                          {f.edit.original && (
                            <details>
                              <summary>原文 · 第{f.edit.page}頁</summary>
                              <del>{f.edit.original}</del>
                            </details>
                          )}
                          <label htmlFor={`rewrite-${c.id}`}>
                            建議草稿 <small>可直接修改</small>
                          </label>
                          <textarea
                            id={`rewrite-${c.id}`}
                            aria-label="建議寫法"
                            maxLength={3000}
                            value={wordings[c.id] ?? f.edit.suggested}
                            onChange={(e) => {
                              setWordings((v) => ({
                                ...v,
                                [c.id]: e.target.value,
                              }));
                              setConfirmed((v) => ({ ...v, [c.id]: false }));
                            }}
                          />
                          <p>先補齊【待確認】；採用只更新文字草稿。</p>
                          <label className="finance-confirm-facts">
                            <input
                              type="checkbox"
                              checked={!!confirmed[c.id]}
                              onChange={(e) =>
                                setConfirmed((v) => ({
                                  ...v,
                                  [c.id]: e.target.checked,
                                }))
                              }
                            />
                            已核實填入的數字及說法
                          </label>
                          <button
                            className="finance-primary"
                            disabled={
                              draftBusy ||
                              !revision ||
                              !canAdopt(
                                wordings[c.id] ?? f.edit.suggested,
                                !!confirmed[c.id],
                              )
                            }
                            onClick={() => void changeDraft("accept")}
                          >
                            {draftBusy
                              ? "保存中…"
                              : f.edit.kind === "replace"
                                ? "替換至草稿"
                                : "新增至草稿"}
                          </button>
                        </div>
                      )}
                      <details className="finance-more">
                        <summary>詳細依據與備註</summary>
                        <p>{c.reason}</p>
                        <p>{c.next_action}</p>
                        {anchor && <blockquote>{anchor.quote}</blockquote>}
                        <small>{anchor?.evidence_id}</small>
                        <blockquote>{c.rule_quote}</blockquote>
                        <select
                          disabled={saving}
                          aria-label="審閱標記"
                          value={current.decision}
                          onChange={(e) =>
                            setDrafts({
                              ...drafts,
                              [selected]: {
                                ...current,
                                decision: e.target
                                  .value as FinanceNoteWrite["decision"],
                              },
                            })
                          }
                        >
                          {Object.entries(DECISIONS).map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <textarea
                          disabled={saving}
                          aria-label="審閱備註"
                          maxLength={2000}
                          placeholder="備註／補件要求"
                          value={current.note}
                          onChange={(e) =>
                            setDrafts({
                              ...drafts,
                              [selected]: { ...current, note: e.target.value },
                            })
                          }
                        />
                        <button
                          className="finance-primary"
                          disabled={saving}
                          onClick={() => void save()}
                        >
                          保存標記
                        </button>
                      </details>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
      <footer className="finance-reader-footer">
        <span role="status">
          {message ||
            (Object.keys(drafts).length
              ? `${Object.keys(drafts).length}項備註未保存`
              : applied.length
                ? `${applied.length}項修訂已保存 · 待覆核`
                : "原件保留 · 採用後可還原")}
        </span>
        <div>
          <button
            onClick={() => void exportFile("draft-export")}
            disabled={!revision}
          >
            <Download size={13} />
            草稿
          </button>
          <button
            onClick={() => void exportFile("draft-export", true)}
            disabled={!revision}
          >
            修訂記錄
          </button>
          <button onClick={() => void exportFile("checklist-export")}>
            C2清單
          </button>
          <button onClick={() => void exportFile("notes-export")}>備註</button>
        </div>
      </footer>
    </div>
  );
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : "操作未完成。";
}
