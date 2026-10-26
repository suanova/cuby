import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCheck2,
  Files,
  Maximize2,
  RefreshCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  FinanceOpenSchema,
  FinanceNotesSchema,
  type FinanceCatalog,
  type FinanceOpen,
  type FinanceNoteWrite,
  type FinanceRequest,
} from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import {
  buildFinancePrompt,
  FINANCE_WORKFLOWS,
  type FinanceWorkflowId,
} from "./finance-workflows.js";
import "./finance-workspace.css";

export const FINANCE_REVIEW_LINK =
  /^outputs\/c2-reviews\/[A-Za-z0-9_-]+\/review\.(?:json|html)$/;
const STATUS: Record<string, string> = {
  evidence_present: "數據存在",
  partially_disclosed: "部分披露",
  not_found_pending_review: "待補支持",
  evidence_found_pending_review: "已有依據",
  applicability_pending_review: "適用性待核",
  explanation_claim_pending_review: "解釋待核",
  prior_period_reference_requires_update: "舊年度待更新",
  rule_version_unconfirmed: "規則未確認",
};
const DECISIONS = {
  open: "尚未標記",
  confirmed_gap: "確認需補充",
  needs_data: "等待補件",
  not_an_issue: "本項毋須更改",
  resolved: "已處理／待重新核對",
};
const PEERS = [
  "Truly International（信利國際，00732）",
  "Solomon Systech（晶門半導體，02878）",
];

export function FinanceWorkflowCards(props: {
  onChoose: (id: FinanceWorkflowId) => void;
}) {
  return (
    <section className="finance-shortcuts" aria-label="FinanceBuddy 五大功能">
      <div className="finance-shortcuts-heading">
        <span>FinanceBuddy</span>
        <small>選擇工作，唔使寫 prompt</small>
      </div>
      <div className="finance-shortcut-grid">
        {FINANCE_WORKFLOWS.map((item, i) => (
          <button
            type="button"
            key={item.id}
            onClick={() => props.onChoose(item.id)}
          >
            <span className="finance-step">0{i + 1}</span>
            <strong>{item.title}</strong>
            <small>{item.stage}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

type Drafts = Record<
  string,
  { decision: FinanceNoteWrite["decision"]; note: string }
>;
export function FinanceWorkspace(props: {
  visible: boolean;
  client: MemmyAgentClient;
  initialPath: string | null;
  artifactPath?: string | null;
  workflow: FinanceWorkflowId | null;
  busy: boolean;
  onChoose: (id: FinanceWorkflowId | null) => void;
  onLaunch: (prompt: string) => Promise<void>;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<FinanceCatalog | null>(null);
  const [opened, setOpened] = useState<FinanceOpen | null>(null);
  const [openedPath, setOpenedPath] = useState("");
  const draftStore = useRef<Record<string, Drafts>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"same_year" | "next_year_readiness">(
    "same_year",
  );
  const [peers, setPeers] = useState(PEERS);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const openSequence = useRef(0);
  const client = props.client;
  async function request(input: FinanceRequest) {
    if (!client.financeReaderRequest)
      throw new Error("此版本 Cuby 未支援內置 Reader，請更新 Cuby。");
    return client.financeReaderRequest(input);
  }
  async function refresh() {
    try {
      setError("");
      if (!client.getFinanceCatalog)
        throw new Error("請更新 Cuby 的 FinanceBuddy 支援。");
      setCatalog(await client.getFinanceCatalog());
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function open(path: string, artifact?: string | null) {
    const sequence = ++openSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = FinanceOpenSchema.parse(
        await request({
          action: "open",
          review_path: path,
          ...(artifact ? { artifact_path: artifact } : {}),
        }),
      );
      if (sequence === openSequence.current) {
        setOpened(result);
        setOpenedPath(path);
        props.onChoose(null);
      }
    } catch (e) {
      if (sequence === openSequence.current) setError(errorText(e));
    } finally {
      if (sequence === openSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [client]);
  useEffect(() => {
    if (props.initialPath) void open(props.initialPath, props.artifactPath);
  }, [props.initialPath, props.artifactPath, client]);
  const selected = FINANCE_WORKFLOWS.find((x) => x.id === props.workflow);
  async function launch() {
    if (props.workflow !== "review" && props.workflow !== "peers") return;
    setLaunching(true);
    setError("");
    try {
      await props.onLaunch(
        buildFinancePrompt({ workflow: props.workflow, mode, peers }),
      );
      setLaunched(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLaunching(false);
    }
  }
  return (
    <aside
      hidden={!props.visible}
      className={`finance-workspace${expanded ? " finance-workspace--expanded" : ""}`}
      aria-label="FinanceBuddy 內置工作台"
    >
      <header className="finance-header">
        <div>
          <span className="finance-eyebrow">FINANCEBUDDY · CUBY</span>
          <h2>
            <FileCheck2 size={18} />
            報告工作台
          </h2>
        </div>
        <div className="finance-actions">
          <button
            title={expanded ? "並排對話" : "展開工作台"}
            aria-label={expanded ? "並排對話" : "展開工作台"}
            onClick={() => setExpanded(!expanded)}
          >
            <Maximize2 size={16} />
          </button>
          <button
            title="返回功能選擇"
            aria-label="返回功能選擇"
            onClick={() => {
              props.onChoose(null);
              setOpened(null);
            }}
          >
            <Files size={17} />
          </button>
          <button
            title="重新載入底稿清單"
            aria-label="重新載入底稿清單"
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} />
          </button>
          <button
            title="關閉工作台"
            aria-label="關閉工作台"
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      {error && (
        <div className="finance-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="finance-loading" role="status">
          正在驗證原件版本及載入底稿…
        </div>
      )}
      {!loading && selected ? (
        <div className="finance-setup">
          <span className="finance-badge">{selected.stage}</span>
          <h3>{selected.title}</h3>
          <p>{selected.detail}</p>
          {selected.id === "review" || selected.id === "peers" ? (
            <>
              <label>
                基準報告
                <select value="yeebo2025" disabled>
                  <option value="yeebo2025">
                    億都 · FY2025/26 · 英文 ESG 報告
                  </option>
                </select>
              </label>
              <p className="finance-muted">
                目前已驗證此報告。其他年份及任意上載報告尚未接通。
              </p>
              {selected.id === "review" ? (
                <>
                  <label>
                    核對目的
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value as typeof mode);
                        setLaunched(false);
                      }}
                    >
                      <option value="same_year">
                        核對 FY2025/26 本年度披露
                      </option>
                      <option value="next_year_readiness">
                        以舊報告評估 FY2026/27 準備度
                      </option>
                    </select>
                  </label>
                  <div className="finance-scope">
                    <strong>範圍：12 項 C2 Scope 1／2 披露核對</strong>
                    <p>
                      檢查已披露的證據、口徑及規則版本。其餘 ESG
                      章節、原始數據審計及完整合規判定不包含在內。
                    </p>
                    {mode === "next_year_readiness" && (
                      <p>
                        原件年份仍是
                        2025/26；所有舊數據及今年適用性均須另行確認。
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <fieldset>
                  <legend>同行 · 2025 年官方報告</legend>
                  {PEERS.map((peer) => (
                    <label className="finance-checkbox" key={peer}>
                      <input
                        type="checkbox"
                        checked={peers.includes(peer)}
                        onChange={(e) => {
                          setPeers(
                            e.target.checked
                              ? [...peers, peer]
                              : peers.filter((p) => p !== peer),
                          );
                          setLaunched(false);
                        }}
                      />
                      {peer}
                    </label>
                  ))}
                  <p className="finance-muted">
                    比較 Scope 1、Scope
                    2、碳密度；保留期間、邊界、分母及來源，口徑不同不直接排名。
                  </p>
                </fieldset>
              )}
              <button
                className="finance-primary"
                disabled={
                  props.busy ||
                  launching ||
                  (selected.id === "peers" && !peers.length)
                }
                onClick={() => void launch()}
              >
                {launching ? "正在交畀 Cuby…" : "開始此工作"}
              </button>
              {props.busy && (
                <p role="status">Cuby 正在處理對話；完成後可開始另一項工作。</p>
              )}
              {launched && (
                <p role="status">
                  已交畀左邊 Cuby 對話處理。核對完成後，點 review.json
                  可在此閱讀；沒有重新核對的話可直接開啟下面現有底稿。
                </p>
              )}
            </>
          ) : (
            <div className="finance-scope">
              <strong>
                {selected.id === "commitments"
                  ? "專用流程尚待開發"
                  : "等待 Mavis 確認來源"}
              </strong>
              <p>
                {selected.id === "commitments"
                  ? "需要上年度承諾清單、今年結果及對應證據；之後建立逐項追蹤和人工覆核。此入口目前不會啟動一個未驗證的流程。"
                  : "需要來源 Excel／系統、欄位說明、報告期間、業務邊界、負責人及讀取權限。資料齊備後才接通整合及報告生成。"}
              </p>
            </div>
          )}
          {selected.id === "review" && (
            <ReviewList catalog={catalog} onOpen={(p) => void open(p)} />
          )}
        </div>
      ) : !loading && opened ? (
        <NativeFinanceReader
          key={opened.handle}
          opened={opened}
          request={request}
          draftKey={openedPath + ":" + opened.review.review_sha256}
          draftStore={draftStore.current}
        />
      ) : !loading ? (
        <div className="finance-setup">
          <h3>今日要處理邊項工作？</h3>
          <FinanceWorkflowCards onChoose={props.onChoose} />
          <ReviewList catalog={catalog} onOpen={(p) => void open(p)} />
        </div>
      ) : null}
    </aside>
  );
}

function ReviewList(props: {
  catalog: FinanceCatalog | null;
  onOpen: (path: string) => void;
}) {
  return (
    <section className="finance-review-list">
      <h3>現有核對底稿</h3>
      <p className="finance-muted">
        直接閱讀已完成底稿，不重新呼叫模型。全部仍需業務覆核。
      </p>
      {!props.catalog && <p role="status">正在連接 FinanceBuddy…</p>}
      {props.catalog?.reviews.map((r) => (
        <button key={r.review_path} onClick={() => props.onOpen(r.review_path)}>
          <BookOpen size={18} />
          <span>
            <strong>{r.label}</strong>
            <small>
              {r.check_count} 項 · 原件 {r.source.report_fiscal_year} → 目標{" "}
              {r.target_period.fiscal_year}
            </small>
          </span>
          <ChevronRight size={16} />
        </button>
      ))}
      {props.catalog && !props.catalog.reviews.length && (
        <p>未有可用底稿。請先完成一次報告核對。</p>
      )}
      {!!props.catalog?.unavailable.length && (
        <p className="finance-muted">
          以下底稿尚未就緒或未能驗證：{props.catalog.unavailable.join("、")}
        </p>
      )}
    </section>
  );
}

function NativeFinanceReader(props: {
  opened: FinanceOpen;
  request: (r: FinanceRequest) => Promise<unknown>;
  draftKey: string;
  draftStore: Record<string, Drafts>;
}) {
  const { review, handle } = props.opened;
  const first =
    review.checks.find((c) => c.id === "C2-29BI-INPUTS") ?? review.checks[0]!;
  const [selected, setSelected] = useState(first.id);
  const [reference, setReference] = useState(0);
  const [page, setPage] = useState(review.anchors[first.id]?.[0]?.page ?? 1);
  const [kind, setKind] = useState<"page" | "rule">("page");
  const [image, setImage] = useState("");
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [notes, setNotes] = useState(props.opened.notes);
  const [drafts, setDrafts] = useState<Drafts>(
    () => props.draftStore[props.draftKey] ?? {},
  );
  useEffect(() => {
    props.draftStore[props.draftKey] = drafts;
  }, [drafts, props.draftKey]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [imageError, setImageError] = useState("");
  const [scope, setScope] = useState(false);
  const imageScroll = useRef<HTMLDivElement>(null);
  const pageImage = useRef<HTMLImageElement>(null);
  const issueScroll = useRef<HTMLDivElement>(null);
  const check = review.checks.find((c) => c.id === selected)!;
  const anchors = review.anchors[selected] ?? [];
  const anchor = anchors[reference];
  const pageInfo = review.pages[page - 1];
  const max = kind === "rule" ? 27 : review.pages.length;
  const current = drafts[selected] ??
    notes.decisions[selected] ?? { decision: "open" as const, note: "" };
  const count = Object.values(notes.decisions).filter(
    (d) => d.decision !== "open",
  ).length;
  function scrollToAnchor() {
    const img = pageImage.current;
    const scroll = imageScroll.current;
    if (!img?.complete || !img.naturalHeight || !scroll) return;
    const y =
      kind === "page" && anchor?.page === page && anchor.rects[0] && pageInfo
        ? (anchor.rects[0][1] / pageInfo.height) * img.clientHeight
        : 0;
    scroll.scrollTo({ top: Math.max(0, y - scroll.clientHeight * 0.25) });
  }
  useEffect(scrollToAnchor, [selected, reference, kind, page, image]);
  useEffect(() => {
    const list = issueScroll.current;
    const card = list?.querySelector<HTMLElement>("article.selected");
    if (list && card)
      list.scrollTo({
        top:
          list.scrollTop +
          card.getBoundingClientRect().top -
          list.getBoundingClientRect().top,
      });
  }, [selected]);
  useEffect(() => {
    let active = true;
    setImage("");
    setImageError("");
    props
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
  }, [kind, page, handle]);
  function choose(id: string, ref = 0) {
    setSelected(id);
    setReference(ref);
    const a = review.anchors[id]?.[ref];
    if (a) {
      setKind("page");
      setPage(a.page);
    }
    setMessage("");
  }
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const value = FinanceNotesSchema.parse(
        await props.request({
          action: "save",
          handle,
          value: {
            expected_revision: notes.revision,
            check_id: selected,
            ...current,
          },
        }),
      );
      setNotes(value);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[selected];
        return next;
      });
      setMessage("已保存；原報告及原核對結論保持原版本。");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        const latest = await props.request({ action: "decisions", handle });
        setNotes(FinanceNotesSchema.parse(latest));
      }
      setMessage(errorText(e) + "（草稿已保留）");
    } finally {
      setSaving(false);
    }
  }
  async function exportFile(
    action: "notes-export" | "checklist-export" | "requests-export",
  ) {
    try {
      const result = (await props.request({ action, handle })) as {
        text: string;
      };
      const csv = action !== "notes-export";
      const url = URL.createObjectURL(
        new Blob([result.text], {
          type: csv
            ? "text/csv;charset=utf-8"
            : "application/json;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download =
        action === "notes-export"
          ? "reviewer-notes.json"
          : action === "checklist-export"
            ? "checklist.csv"
            : "data-requests.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  const visible = review.checks.filter(
    (c) =>
      [c.label, c.id, c.reason, c.next_action]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        c.status === filter ||
        (filter === "open" &&
          (!notes.decisions[c.id] ||
            notes.decisions[c.id]?.decision === "open"))),
  );
  return (
    <div className="finance-reader">
      <div className="finance-document-head">
        <strong title={review.source.file_name}>
          {review.source.file_name}
        </strong>
        <small>
          原件 {review.source.report_fiscal_year} · 目標{" "}
          {review.target_period.fiscal_year} · {review.pages.length} 頁 ·
          SHA-256 已驗證
        </small>
        <button onClick={() => setScope(!scope)}>規則版本及核對範圍</button>
      </div>
      {scope && (
        <div className="finance-scope finance-reader-scope">
          <strong>
            {review.rules.status === "selected_text_matches"
              ? "選定官方條文文字已核實"
              : "官方條文版本未確認"}
          </strong>
          <p>核實時間：{review.rules.checked_at}</p>
          <p>{review.rules.scope}</p>
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
              aria-pressed={kind === "page"}
              onClick={() => {
                setKind("page");
                setPage(anchor?.page ?? 1);
              }}
            >
              報告
            </button>
            <button
              aria-pressed={kind === "rule"}
              onClick={() => {
                setKind("rule");
                setPage(check.actual_pdf_page);
              }}
            >
              規則
            </button>
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
          </div>
          <div className="finance-location">
            {kind === "rule"
              ? `規則 C2 ${check.clause} · PDF ${page}`
              : `${check.label} · PDF ${page}${anchor?.page === page ? (anchor.context_only ? " · 相關段落，不是錯句位置" : anchor.location_status === "unlocated" ? " · 引句未可靠定位" : " · 原文依據已定位") : " · 原件閱讀"}`}
          </div>
          <div className="finance-paper-scroll" ref={imageScroll}>
            {!image && <p role="status">{imageError || "正在載入原件頁面…"}</p>}
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
                    aria-label="所選項目原文高亮"
                  >
                    {anchors
                      .filter((a) => a.page === page)
                      .flatMap((a) =>
                        a.rects.map((r, i) => (
                          <rect
                            key={`${a.id}:${i}`}
                            x={r[0] - 1}
                            y={r[1] - 1}
                            width={r[2] - r[0] + 2}
                            height={r[3] - r[1] + 2}
                          >
                            <title>{a.quote}</title>
                          </rect>
                        )),
                      )}
                  </svg>
                )}
              </div>
            )}
          </div>
          <p className="finance-highlight-note">
            黃色表示引用依據；缺少披露不會虛構錯句高亮。
          </p>
        </section>
        <section className="finance-findings" aria-label="核對項目及建議">
          <div className="finance-findings-toolbar">
            <strong>
              {review.checks.length} 項 · {count} 已標記
            </strong>
            <label>
              <Search size={14} />
              <input
                aria-label="搜尋核對項目"
                placeholder="搜尋項目或建議"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="篩選核對狀態"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部項目</option>
              <option value="open">尚未標記</option>
              {Object.entries(STATUS)
                .filter(([key]) => review.status_counts[key])
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          <div className="finance-issue-list" ref={issueScroll}>
            {!visible.length && <p>沒有符合篩選的項目。</p>}
            {visible.map((c) => (
              <article
                className={c.id === selected ? "selected" : ""}
                key={c.id}
              >
                <button
                  className="finance-issue-title"
                  aria-expanded={c.id === selected}
                  onClick={() => choose(c.id)}
                >
                  <span>
                    {String(review.checks.indexOf(c) + 1).padStart(2, "0")}
                  </span>
                  <strong>
                    {c.label}
                    <small>C2 {c.clause}</small>
                  </strong>
                  <em>{STATUS[c.status] ?? c.status}</em>
                </button>
                {c.id === selected && (
                  <div className="finance-issue-detail">
                    <p>{c.reason}</p>
                    <h4>建議跟進</h4>
                    <p className="finance-suggestion">{c.next_action}</p>
                    <h4>原文依據</h4>
                    <div className="finance-citations">
                      {anchors.map((a, i) => (
                        <button
                          key={a.id}
                          aria-pressed={reference === i && kind === "page"}
                          onClick={() => choose(c.id, i)}
                        >
                          PDF {a.page}
                          {a.occurrences > 1 ? ` · ${a.occurrences} 處` : ""}
                          {a.location_status === "unlocated" ? " · 未定位" : ""}
                        </button>
                      ))}
                    </div>
                    {(!anchors.length ||
                      c.status === "not_found_pending_review") && (
                      <p className="finance-context">
                        未找到充分支持；引用只表示查閱依據，並非某句錯誤。
                      </p>
                    )}
                    {anchor && (
                      <details>
                        <summary>查看原文引句及來源 ID</summary>
                        <blockquote>{anchor.quote}</blockquote>
                        <small>{anchor.evidence_id}</small>
                      </details>
                    )}
                    <details>
                      <summary>
                        規則 C2 {c.clause} · PDF {c.actual_pdf_page}
                      </summary>
                      <blockquote>{c.rule_quote}</blockquote>
                      <button
                        onClick={() => {
                          setKind("rule");
                          setPage(c.actual_pdf_page);
                        }}
                      >
                        在左邊查看規則原件
                      </button>
                    </details>
                    <h4>你的審閱標記</h4>
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
                      {Object.entries(DECISIONS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <textarea
                      disabled={saving}
                      aria-label="審閱備註"
                      maxLength={2000}
                      placeholder="判斷、補件要求或覆核說明…"
                      value={current.note}
                      onChange={(e) =>
                        setDrafts({
                          ...drafts,
                          [selected]: { ...current, note: e.target.value },
                        })
                      }
                    />
                    <div className="finance-save-row">
                      <button
                        className="finance-primary"
                        disabled={saving}
                        onClick={() => void save()}
                      >
                        {saving ? "保存中…" : "保存標記"}
                      </button>
                      <small>
                        {drafts[selected]
                          ? "有未保存變更"
                          : notes.decisions[selected]
                            ? "已保存"
                            : "獨立保存，不改原報告"}
                      </small>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
      <footer className="finance-reader-footer">
        <span role="status">
          {message ||
            (Object.keys(drafts).length
              ? `有 ${Object.keys(drafts).length} 項未保存。關閉工作台前請保存。`
              : "本機審閱備註，並非業務批准或合規認證。")}
        </span>
        <div>
          <button onClick={() => void exportFile("checklist-export")}>
            <Download size={13} />
            清單
          </button>
          <button onClick={() => void exportFile("requests-export")}>
            補件
          </button>
          <button onClick={() => void exportFile("notes-export")}>備註</button>
        </div>
      </footer>
    </div>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "未能完成此操作。";
}
