import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConsistencyFollowupsSchema, ConsistencyFollowupsExportSchema,
  type ConsistencyFollowups, type ConsistencyReport, type FinanceRequest,
} from "@memmy/local-api-contracts";

export type ConsistencyFollowupContext = { project_id: string; version_id: string; run_id: string };
type Request = (input: FinanceRequest) => Promise<unknown>;
type Check = ConsistencyReport["checks"][number];
type Operation = "save" | "receive" | "verify" | "reopen";
type Draft = { owner: string; due_date: string; evidence_reference: string; note: string; reviewer: string };
type RecordValue = ConsistencyFollowups["records"][string];
const STATUS_LABELS = { awaiting: "待補料", received_pending_review: "已收到，待覆核", verified: "已核實", reopened: "重新開啟" };
const OPERATION_LABELS = { save: "保存跟進", receive: "收到資料，待覆核", verify: "核實完成", reopen: "重新開啟" };
const draftOf = (record?: RecordValue): Draft => ({ owner: record?.owner ?? "", due_date: record?.due_date ?? "", evidence_reference: record?.evidence_reference ?? "", note: record?.note ?? "", reviewer: "" });
const fieldsOf = (draft: Draft) => ({ owner: draft.owner.trim(), due_date: draft.due_date || null, evidence_reference: draft.evidence_reference.trim(), note: draft.note.trim() });
const sameFields = (draft: Draft, record?: RecordValue) => !!record && JSON.stringify(fieldsOf(draft)) === JSON.stringify({ owner: record.owner, due_date: record.due_date, evidence_reference: record.evidence_reference, note: record.note });
const messageOf = (error: unknown) => error instanceof Error ? error.name === "ZodError" ? "跟進紀錄格式或來源不符，請重新開啟此審閱。" : error.message : "未能讀取跟進紀錄。";

/** The store is separate from report decisions; drafts remain bound to the exact source and issue. */
export function useConsistencyFollowups(report: ConsistencyReport, context: ConsistencyFollowupContext | undefined, request: Request) {
  const fullContext = context?.run_id === report.run_id && context.project_id && context.version_id ? context : undefined;
  const sourceIdentity = useMemo(() => JSON.stringify(report.documents.map(doc => [doc.slot, doc.sha256]).sort()), [report.documents]);
  const issueIdentity = useMemo(() => JSON.stringify(report.checks), [report.checks]);
  const scope = fullContext ? JSON.stringify([fullContext.project_id, fullContext.version_id, fullContext.run_id, sourceIdentity, issueIdentity]) : "";
  const currentScope = useRef(scope); currentScope.current = scope;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const sequence = useRef(0);
  const [state, setState] = useState<{ scope: string; store: ConsistencyFollowups | null; valid: boolean; loading: boolean; error: string; notice: { check_id: string; text: string } | null }>({ scope, store: null, valid: false, loading: !!scope, error: "", notice: null });
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map());
  const [pending, setPending] = useState<{ scope: string; check: string } | null>(null);
  const store = state.scope === scope ? state.store : null;
  const valid = state.scope === scope && state.valid;
  const current = valid && store?.binding_status === "current";
  const busy = pending?.scope === scope;
  const validate = (raw: unknown, historical = false) => {
    const next = ConsistencyFollowupsSchema.parse(raw);
    if (!fullContext || next.project_id !== fullContext.project_id || next.version_id !== fullContext.version_id || next.run_id !== fullContext.run_id)
      throw new Error("跟進紀錄的項目或版本不符，請重新開啟此審閱。");
    if (next.binding_status !== (historical ? "historical_unvalidated" : "current")) throw new Error("未能確認跟進紀錄的來源狀態。");
    if (!historical) {
      const sources = JSON.stringify(Object.entries(next.source_sha256).sort());
      if (sources !== sourceIdentity) throw new Error("報告來源已變更，請重新開啟此審閱後再跟進。");
    }
    return next;
  };
  const load = useCallback(async (historical = false, retainedError = "") => {
    if (!fullContext) return;
    const ticket = ++sequence.current;
    setState(previous => ({ scope, store: previous.scope === scope ? previous.store : null, valid: false, loading: true, error: retainedError, notice: null }));
    try {
      const next = validate(await request({ action: "consistency-followups", ...fullContext, ...(historical ? { history_only: true } : {}) }), historical);
      if (active.current && ticket === sequence.current && currentScope.current === scope) setState({ scope, store: next, valid: true, loading: false, error: retainedError, notice: null });
    } catch (error) {
      if (active.current && ticket === sequence.current && currentScope.current === scope) setState(previous => ({ ...previous, scope, valid: false, loading: false, error: [retainedError, messageOf(error)].filter(Boolean).join(" "), notice: null }));
    }
  // scope contains the full identity; object-valued context props may be recreated by the reader.
  }, [scope, request]);
  useEffect(() => { if (scope) void load(); else setState({ scope, store: null, valid: false, loading: false, error: "", notice: null }); return () => { sequence.current++; }; }, [scope, load]);
  const draftKey = (check: Check) => store?.issues[check.id] ? JSON.stringify([scope, store.binding_sha256, store.issues[check.id]!.issue_sha256, check.id]) : "";
  const getDraft = (check: Check) => drafts.get(draftKey(check)) ?? draftOf(store?.records[check.id]);
  function changeDraft(check: Check, update: Partial<Draft>) {
    const key = draftKey(check); if (!current || !key || busy) return;
    setState(previous => ({ ...previous, notice: null }));
    setDrafts(previous => new Map(previous).set(key, { ...(previous.get(key) ?? draftOf(store?.records[check.id])), ...update }));
  }
  async function update(check: Check, operation: Operation) {
    if (!current || !store || !fullContext || busy || !store.issues[check.id]) return;
    const draft = getDraft(check), key = draftKey(check), record = store.records[check.id];
    if (!draft.owner.trim() || ((operation === "receive" || operation === "verify") && !draft.evidence_reference.trim())) return;
    if (operation === "verify" && (record?.status !== "received_pending_review" || !sameFields(draft, record) || !draft.reviewer.trim())) return;
    const ticket = sequence.current;
    setState(previous => ({ ...previous, notice: null }));
    setPending({ scope, check: check.id });
    try {
      const next = validate(await request({ action: "consistency-followup-update", ...fullContext, check_id: check.id, expected_revision: store.revision, expected_binding_sha256: store.binding_sha256, operation, ...fieldsOf(draft), ...(operation === "verify" ? { reviewer: draft.reviewer.trim() } : {}) }));
      if (!active.current || currentScope.current !== scope || ticket !== sequence.current) return;
      if (next.binding_sha256 !== store.binding_sha256 || next.revision < store.revision) throw new Error("跟進來源或版本已變更，請重新載入。");
      const notice = operation === "receive" ? "資料已記錄，仍待覆核；未視為已解決。" : operation === "verify" ? "已保存覆核人、核實時間與證據。" : operation === "reopen" || next.records[check.id]?.status === "reopened" ? "跟進已重新開啟；先前核實紀錄已保留。" : "跟進已保存。";
      setState({ scope, store: next, valid: true, loading: false, error: "", notice: { check_id: check.id, text: notice } });
      setDrafts(previous => { const changed = new Map(previous); changed.delete(key); return changed; });
    } catch (error) {
      if (active.current && currentScope.current === scope && ticket === sequence.current) await load(false, `保存未確認；你的草稿已保留。${messageOf(error)}`);
    } finally { setPending(previous => previous?.scope === scope && previous.check === check.id ? null : previous); }
  }
  async function exportCsv(check: Check) {
    if (!current || !store || !fullContext || busy) return;
    const ticket = sequence.current;
    setState(previous => ({ ...previous, notice: null }));
    setPending({ scope, check: check.id });
    try {
      const result = ConsistencyFollowupsExportSchema.parse(await request({ action: "consistency-followups-export", ...fullContext, expected_revision: store.revision, expected_binding_sha256: store.binding_sha256 }));
      if (!active.current || currentScope.current !== scope || ticket !== sequence.current) return;
      if (result.revision !== store.revision || result.binding_sha256 !== store.binding_sha256) throw new Error("跟進版本已變更，請重新載入後再匯出。");
      const url = URL.createObjectURL(new Blob([result.text], { type: result.mime }));
      const link = document.createElement("a"); link.href = url; link.download = result.file_name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      setState(previous => ({ ...previous, error: "", notice: { check_id: check.id, text: "已匯出本輪所有已保存的補料跟進。" } }));
    } catch (error) { if (active.current && currentScope.current === scope && ticket === sequence.current) await load(false, `匯出未完成。${messageOf(error)}`); }
    finally { setPending(previous => previous?.scope === scope && previous.check === check.id ? null : previous); }
  }
  return { context: fullContext, store, current, valid, busy, loading: state.scope !== scope || state.loading, error: state.scope === scope ? state.error : "", notice: state.scope === scope ? state.notice : null, getDraft, changeDraft, update, load, exportCsv };
}

export function ConsistencyFollowupCard({ check, followups }: { check: Check; followups: ReturnType<typeof useConsistencyFollowups> }) {
  const { store, current, valid, busy, loading } = followups;
  const issue = store?.issues[check.id], record = store?.records[check.id], draft = followups.getDraft(check);
  const historical = valid && store?.binding_status === "historical_unvalidated";
  const editable = !!current && !!issue && !busy && !loading;
  const changed = !sameFields(draft, record), ownerReady = !!draft.owner.trim(), evidenceReady = !!draft.evidence_reference.trim();
  const status = historical ? "舊紀錄 · 只讀" : !valid ? loading ? "讀取中…" : "目前狀態未確認" : record ? STATUS_LABELS[record.status] : "尚未指派";
  const change = (value: Partial<Draft>) => followups.changeDraft(check, value);
  return <details className="consistency-evidence-followup">
    <summary>補料跟進 <span className={current && record ? `consistency-followup-status consistency-followup-status--${record.status}` : "consistency-followup-status"}>{followups.context ? status : "項目版本未確認"}</span></summary>
    {!followups.context ? <p>請從已保存的項目開啟此審閱，以確認報告版本和來源後再指派跟進。</p> : <div className="consistency-followup-fields">
      <p>收到資料後仍需覆核；不會自動接受修改或把問題標為已處理。</p>
      {historical && <p className="consistency-followup-historical" role="status">只讀舊紀錄：尚未核實目前來源，以下狀態只代表當時紀錄，不能用作目前版本的核實結果。</p>}
      {!loading && !issue && valid && <p>此檢查沒有可用的來源綁定，未能指派跟進。</p>}
      {issue && <>
        <label>負責人<input aria-label="補料負責人" maxLength={100} placeholder="由你填寫，不會自動指派" value={draft.owner} disabled={!editable} onChange={event => change({ owner: event.target.value })} /></label>
        <label>預計補齊日（可留空）<input aria-label="補料預計日期" type="date" value={draft.due_date} disabled={!editable} onChange={event => change({ due_date: event.target.value })} /></label>
        <label>已收到的資料／證據索引<input aria-label="補料證據" maxLength={1000} placeholder="例如：收到的文件名稱、頁碼或連結" value={draft.evidence_reference} disabled={!editable} onChange={event => change({ evidence_reference: event.target.value })} /></label>
        <label>跟進備註<textarea aria-label="補料跟進備註" maxLength={2000} rows={2} value={draft.note} disabled={!editable} onChange={event => change({ note: event.target.value })} /></label>
        {current && record?.status === "verified" && changed && <p className="consistency-followup-hint">保存變更後會重新開啟跟進；先前核實證據及時間會保留在歷史。</p>}
        {current && <div className="consistency-followup-actions">
          <button disabled={!editable || !ownerReady || !changed} onClick={() => void followups.update(check, "save")}>保存跟進</button>
          <button disabled={!editable || !ownerReady || !evidenceReady || record?.status === "verified"} onClick={() => void followups.update(check, "receive")}>收到資料，待覆核</button>
          {record && ["verified", "received_pending_review"].includes(record.status) && <button disabled={!editable || !ownerReady} onClick={() => void followups.update(check, "reopen")}>重新開啟</button>}
        </div>}
        {current && record?.status === "received_pending_review" && <div className="consistency-followup-verify">
          <label>覆核人<input aria-label="補料覆核人" maxLength={100} value={draft.reviewer} placeholder="覆核後由你填寫" disabled={!editable} onChange={event => change({ reviewer: event.target.value })} /></label>
          {changed && <small>資料有未保存變更，請先保存並確認收到的證據。</small>}
          <button disabled={!editable || changed || !ownerReady || !evidenceReady || !draft.reviewer.trim()} onClick={() => void followups.update(check, "verify")}>核實完成</button>
          <small>核實時間由系統在保存時記錄。</small>
        </div>}
        {record && <p className="consistency-followup-saved">{historical ? "當時狀態" : valid ? "已保存狀態" : "最後讀取的狀態（待重新確認）"}：{STATUS_LABELS[record.status]}{record.reviewer ? ` · 覆核人：${record.reviewer}` : ""}{record.verified_at && <><br /><time dateTime={record.verified_at}>核實時間：{record.verified_at}</time></>}</p>}
        <details className="consistency-followup-binding"><summary>來源與版本</summary><p>只適用於此審閱及報告版本；新版本須重新審閱，舊紀錄保留。</p><code>項目 {store!.project_id}<br />版本 {store!.version_id}<br />審閱 {store!.run_id}</code>{issue.refs.map((ref, index) => <div key={index}><span>{ref.slot} · PDF {ref.page}</span><code>SHA256 {ref.source_sha256}</code><blockquote>{ref.quote}</blockquote></div>)}</details>
        <details className="consistency-followup-history"><summary>跟進歷史（{store!.history.filter(entry => entry.check_id === check.id).length}）</summary><ol>{store!.history.filter(entry => entry.check_id === check.id).map(entry => <li key={entry.revision}><strong>{OPERATION_LABELS[entry.operation]} · {STATUS_LABELS[entry.record.status]}</strong><time dateTime={entry.at}>{entry.at}</time><span>負責人：{entry.record.owner}{entry.record.due_date ? ` · 預計補齊日：${entry.record.due_date}` : ""}</span>{entry.record.evidence_reference && <p>證據：{entry.record.evidence_reference}</p>}{entry.record.note && <p>備註：{entry.record.note}</p>}{entry.record.reviewer && <span>覆核人：{entry.record.reviewer} · {entry.record.verified_at}</span>}</li>)}</ol>{!store!.history.some(entry => entry.check_id === check.id) && <p>尚未保存跟進紀錄。</p>}</details>
        {current && <button disabled={!editable || !Object.keys(store!.records).length} onClick={() => void followups.exportCsv(check)}>匯出本輪已保存補料 CSV（{Object.keys(store!.records).length}項）</button>}
      </>}
      {followups.error && <p className="finance-error" role="alert">{followups.error}</p>}
      {followups.notice?.check_id === check.id && <p role="status">{followups.notice.text}</p>}
      {!loading && <div className="consistency-followup-actions"><button disabled={busy} onClick={() => void followups.load()}>重新載入跟進</button>{!current && !historical && <button disabled={busy} onClick={() => void followups.load(true)}>只讀舊紀錄</button>}</div>}
    </div>}
  </details>;
}
