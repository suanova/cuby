import { useState } from "react";
import { consistencyWorkItems } from "./consistency-work-items.js";
import { c2CheckTask, c2Progress, c2TaskState, C2_TASK_LABELS } from "./c2-progress.js";
import { consistencyCheckState, type ConsistencyReport, type ConsistencyEditor, type ConsistencyComparison } from "@memmy/local-api-contracts";

type Check = ConsistencyReport["checks"][number];
export const OVERVIEW_STATES = ["checked", "difference", "verify", "not_started", "blocked", "running", "not_applicable"] as const;
export type OverviewState = typeof OVERVIEW_STATES[number];
export const OVERVIEW_LABELS: Record<OverviewState, string> = {
  checked: "已核對", difference: "有差異", verify: "待核實", not_started: "未做",
  blocked: "未能完成", running: "進行中", not_applicable: "不適用"
};
const SYMBOLS: Record<OverviewState, string> = { checked: "✓", difference: "×", verify: "?", not_started: "—", blocked: "!", running: "◷", not_applicable: "／" };
const COMPARISON_LABELS: Record<ConsistencyComparison, string> = { bilingual: "中英文字及口徑", cross_report: "ESG／年報對照", internal: "報告內部", restatement: "跨年重述" };

function comparison(check: Check): ConsistencyComparison {
  return check.semantic_kind ?? (check.category === "cross_report" || check.category === "internal" || check.category === "restatement" ? check.category : "bilingual");
}

/** A reviewer's accept/dismiss decision does not turn an original finding into a pass. */
export function overviewState(check: Check, report: ConsistencyReport): OverviewState {
  const outcome = check.regulatory?.outcome;
  if (outcome === "disclosed") return "checked";
  if (outcome === "not_applicable") return "not_applicable";
  if (outcome === "conflict") return "difference";
  if (outcome === "external_evidence_needed") return "blocked";
  if (outcome && outcome !== "not_reviewed") return "verify";
  if (outcome === "not_reviewed") {
    const task = c2CheckTask(check, report);
    if (task?.status === "running") return "running";
    if (task?.status === "failed" || report.compliance?.status === "failed") return "blocked";
  }
  const state = consistencyCheckState(check);
  if (!outcome && state === "matched") return "checked";
  if (!outcome && state === "difference") return "difference";
  if (!outcome && state === "needs_confirmation") return "verify";
  if (/未取得|未能|無法|缺少|未就緒|取不到|未取到|不支援/.test(check.reason)) return "blocked";
  const task = !outcome && report.semantic?.tasks.find(t => t.id === comparison(check));
  if (task && task.status === "failed") return "blocked";
  if (task && task.status === "running") return "running";
  return "not_started";
}

function countStates(checks: Check[], report: ConsistencyReport) {
  return Object.fromEntries(OVERVIEW_STATES.map(state => [state, checks.filter(c => overviewState(c, report) === state).length])) as Record<OverviewState, number>;
}

function readableFailure(reason: string, fallback: string): string {
  if (/No such file|ENOENT|Errno 2|FileNotFound|找不到.*檔案/i.test(reason)) return fallback;
  if (/context|上下文|token.*(?:limit|budget)/i.test(reason)) return "內容超出單次處理上限。";
  if (/503|no available channel|無可用.*通道/i.test(reason)) return "模型服務暫時無法使用。";
  if (/引用.*(?:驗證|定位|原頁)/.test(reason)) return "引用未能對上報告原文。";
  if (/timeout|timed out|逾時|超時/i.test(reason)) return "核對逾時。";
  return reason.length > 120 ? "核對中斷；詳細原因見執行狀態。" : reason;
}

function scopeNote(id: string, report: ConsistencyReport): string {
  if (id === "metric") return "表格數值比對；文字意思及計算口徑另外核對。";
  if (report.compliance) return "逐項核對披露及適用條件；有披露證據不代表已核實底稿。";
  const kind = id as ConsistencyComparison;
  const slots = report.documents.filter(d => !d.slot.startsWith("prior_")).map(d => d.slot);
  if (kind === "bilingual" && !["esg", "annual"].some(k => slots.includes(`${k}_zh` as typeof slots[number]) && slots.includes(`${k}_en` as typeof slots[number]))) return "未做：缺少同一報告的中英兩版。";
  if (kind === "cross_report" && !(slots.some(s => s.startsWith("esg_")) && slots.some(s => s.startsWith("annual_")))) return "未做：需要 ESG 及年報才能對照。";
  if (!report.comparisons.includes(kind)) return "未做：本次未選此項檢查。";
  if (kind === "restatement" && report.history.status === "unavailable") return `未能完成：${readableFailure(report.history.reason || "", "未取得上年度報告，請補上去年原件。") || "未取得上年度報告。"}`;
  const task = report.semantic?.tasks.find(t => t.id === kind);
  if (!task) return "內文意思未做；已有的數值核對結果仍列在下方。";
  if (task.status === "failed") return `內文未能完成：${readableFailure(task.error || "核對中斷。", "缺少所需文件。") } 已完成的結果保留。`;
  if (task.status === "running") return "內文核對進行中，結果會繼續更新。";
  if (task.status === "pending") return "內文未做：等待此步驟開始。";
  return `內文已執行；提交 ${task.submitted_pages} 頁，結果按下方各項列出。`;
}

export function ConsistencyOverview(props: { report: ConsistencyReport; editor: ConsistencyEditor | null; onSelect: (check: Check) => void }) {
  const { report, editor } = props;
  const [filter, setFilter] = useState<OverviewState | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState(false);
  const source = report.compliance ? report.checks.filter(c => c.regulatory) : report.checks;
  const checks = source.filter(c => consistencyCheckState(c) !== "candidate");
  const workItems = consistencyWorkItems(source, editor);
  const candidates = source.filter(c => consistencyCheckState(c) === "candidate");
  const counts = countStates(checks, report);
  const live = report.compliance ? c2Progress(report) : null;
  const stateLabel = (state: OverviewState) => report.compliance ? state === 'checked' ? '有披露證據' : state === 'blocked' ? '待補件／未完成' : report.compliance.status === 'running' && state === 'not_started' ? '排隊' : state === 'running' ? '檢查中' : OVERVIEW_LABELS[state] : OVERVIEW_LABELS[state];
  const groups = report.compliance
    ? ([['A', 'C2 A · 報告原則及發布'], ['B', 'C2 B · 強制披露'], ['C', 'C2 C · 環境及社會'], ['D', 'C2 D · 氣候披露']] as const).map(([id, label]) => ({ id, label, checks: checks.filter(c => c.regulatory?.part === id) }))
    : [{ id: "metric", label: "中英數字", checks: checks.filter(c => c.category === "metric" && !c.semantic_kind) },
      ...(["bilingual", "cross_report", "internal", "restatement"] as const).map(id => ({ id, label: COMPARISON_LABELS[id], checks: checks.filter(c => !(c.category === "metric" && !c.semantic_kind) && comparison(c) === id) }))];
  const matches = (c: Check) => (filter === "all" || overviewState(c, report) === filter) &&
    `${c.reader_copy?.title ?? c.title} ${c.reader_copy?.problem ?? c.reason} ${c.regulatory?.clause ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  const summary = (items: Check[]) => {
    const values = countStates(items, report);
    return OVERVIEW_STATES.filter(s => values[s]).map(s => `${SYMBOLS[s]} ${stateLabel(s)} ${values[s]}`).join(" · ");
  };
  const row = (c: Check, candidate = false) => {
    const state = overviewState(c, report);
    const owner = workItems.find(item => editor?.decisions[item.check.id] && item.members.some(member => member.id === c.id))?.check ?? c;
    const decision = editor?.decisions[owner.id];
    const task = c.regulatory?.outcome === 'not_reviewed' ? c2CheckTask(c, report) : undefined;
    const reason = task ? `${task.label} · ${C2_TASK_LABELS[c2TaskState(task)]}。${task.status === 'running' ? '完成覆核後會出現結果。' : task.status === 'pending' ? '等候前面的批次完成。' : task.error ? readableFailure(task.error, '本批核對未完成。') : '尚未有可發布結果。'}` : c.reader_copy?.problem ?? readableFailure(c.reason, comparison(c) === "restatement" ? "未取得上年度報告，這項跨年核對未完成。" : "缺少所需文件，這項核對未完成。");
    return <li key={c.id}><button className="consistency-overview-item" data-state={candidate ? "candidate" : state} onClick={() => props.onSelect(c)}>
      <span className="consistency-overview-symbol" aria-hidden="true">{candidate ? "·" : SYMBOLS[state]}</span>
      <span><strong>{c.regulatory ? `${c.regulatory.clause} · ` : ""}{c.reader_copy?.title ?? c.title}</strong>
        <small><b>{candidate ? "只作初篩" : task?.status === 'running' ? C2_TASK_LABELS[c2TaskState(task)] : stateLabel(state)}</b>{decision && ` · ${owner.id !== c.id ? "同一問題" : ""}${decision.status === "accepted" ? "已接受修改" : "已忽略"}`}</small>
        <span>{reason}</span>
        {!!c.refs.length && <small>{[...new Set(c.refs.map(r => `${report.documents.find(d => d.slot === r.slot)?.label ?? r.slot} p.${r.page}`))].join(" · ")}</small>}
      </span><span aria-hidden="true">›</span>
    </button></li>;
  };
  const visibleGroups = groups.map(g => ({ ...g, visible: g.checks.filter(matches) })).filter(g => filter === "all" && !query.trim() || g.visible.length);
  return <div className="consistency-overview-content">
    <p className="consistency-overview-intro">{report.compliance ? "C2 披露檢查" : "一致性審閱"} · FY{report.fiscal_year} · {checks.length} 項核對紀錄</p>
    {live&&<p className="consistency-overview-live" aria-label="總覽即時進度"><strong>已出結果 {live.counts.completed}/{live.total} · 檢查中 {live.counts.reading+live.counts.verifying} · 排隊 {live.counts.queued}</strong><small>下方按核對結論分類；已出結果包括需要改善及補件的項目。</small></p>}
    <div className="consistency-overview-counts" aria-label="檢查狀態總數">
      <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部 <strong>{checks.length}</strong></button>
      {OVERVIEW_STATES.filter(s => counts[s] || ["checked", "difference", "verify", "not_started", "blocked"].includes(s)).map(s => <button key={s} data-state={s} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? "all" : s)}><span aria-hidden="true">{SYMBOLS[s]} </span>{stateLabel(s)} <strong>{counts[s]}</strong></button>)}
    </div>
    <p className="consistency-overview-note">這裡是檢查紀錄，不是問題數；同一指標可有中英、跨年等多筆核對。待辦及已接受／忽略的數量見主畫面。接受或忽略不會把原有差異變成「已核對一致」。</p>
    <div className="consistency-overview-search"><input aria-label="搜尋全部檢查項" placeholder="搜尋檢查項或條款" value={query} onChange={e => setQuery(e.target.value)} /><button onClick={() => { setAllOpen(!allOpen); setExpanded({}); }}>{allOpen ? "收起全部" : "展開全部"}</button></div>
    <div className="consistency-overview-groups" tabIndex={0} aria-label="全部檢查項清單">
      {visibleGroups.map(g => <details key={g.id} open={!!query.trim() || filter !== "all" || (expanded[g.id] ?? allOpen)} onToggle={e => {
        const open = e.currentTarget.open;
        if (!query.trim() && filter === "all" && open !== (expanded[g.id] ?? allOpen)) setExpanded(v => ({ ...v, [g.id]: open }));
      }}><summary><strong>{g.label}</strong><span>{filter !== "all" || query.trim() ? `${g.visible.length} 項符合篩選（本類共 ${g.checks.length} 項）` : g.checks.length ? summary(g.checks) : "— 尚無核對結果"}</span>{!g.checks.length && <small>{scopeNote(g.id, report)}</small>}</summary>
        {!!g.checks.length && <p className="consistency-overview-scope-note">{scopeNote(g.id, report)}</p>}
        <ul>{g.visible.sort((a, b) => ["difference", "verify", "blocked", "not_started", "running", "checked", "not_applicable"].indexOf(overviewState(a, report)) - ["difference", "verify", "blocked", "not_started", "running", "checked", "not_applicable"].indexOf(overviewState(b, report))).map(c => row(c))}</ul>
        {!g.visible.length && <p className="consistency-overview-empty">尚無逐項結果；原因見上方說明。</p>}
      </details>)}
      {!visibleGroups.length && <p className="consistency-overview-empty">此狀態沒有檢查項。</p>}
      {!!candidates.length && filter === "all" && !query.trim() && <details className="consistency-overview-candidates"><summary><strong>頁碼數字初篩 · {candidates.length} 組</strong><small>只作定位參考，不計入上方核對結果。</small></summary><ul>{candidates.map(c => row(c, true))}</ul></details>}
      {(report.compliance?.tasks.length || report.semantic) && <details className="consistency-overview-execution"><summary>執行狀態及未完成原因</summary><ul>{(report.compliance?.tasks ?? report.semantic?.tasks ?? []).map(t => <li key={t.id}><strong>{t.label} · {({ completed: "步驟已執行", failed: "未能完成", running: "進行中", pending: "未做" })[t.status]}</strong>{t.error && <p>{t.error}</p>}</li>)}</ul>{report.semantic?.error && <p>{report.semantic.error}</p>}{(report.compliance?.gaps ?? report.semantic?.gaps ?? []).map((gap, i) => <p key={i}>{gap}</p>)}</details>}
    </div>
    <footer>{report.compliance ? "一致性審閱請由上方分頁查看。" : "此處只列一致性結果；C2 披露檢查請由上方分頁查看／設定。"}點檢查項可查看原文及詳細說明。</footer>
  </div>;
}
