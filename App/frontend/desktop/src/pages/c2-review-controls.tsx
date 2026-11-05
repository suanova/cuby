import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {ConsistencyReportSchema,type ConsistencyReport,type ConsistencyEditor,type FinanceRequest} from "@memmy/local-api-contracts";
import { c2Progress, c2TaskActivity, c2TaskState, C2_TASK_LABELS } from "./c2-progress.js";
import {ConsistencyEditCard} from "./consistency-edit-controls.js";
import {reviewAction} from "./consistency-actions.js";
type Request=(input:FinanceRequest)=>Promise<unknown>;
export const C2_OBLIGATIONS:Record<string,string>={mandatory:"強制披露",mandatory_scope1_scope2:"Scope 1／2 強制披露",comply_or_explain:"不遵守就解釋",recommended:"建議披露",reporting_principle:"報告原則",classification_pending:"義務類別待確認"};

export function C2StatusPanel(props:{report:ConsistencyReport;request:Request;onChange:(report:ConsistencyReport)=>void}){
  const review=props.report.compliance!,[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [clock,setClock]=useState(()=>Date.now());
  useEffect(()=>{if(review.status!=="running")return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[review.status,review.started_at]);
  const failed=review.tasks.some(t=>t.status==="failed"),progress=c2Progress(props.report);
  const activeTasks=review.tasks.filter(t=>t.status==='running');
  const age=(at:string)=>{const n=Math.max(0,Math.floor((clock-Date.parse(at))/1000))||0;return n<60?`${n}秒`:`${Math.floor(n/60)}分${n%60}秒`;};
  const remaining=Math.max(0,review.coverage.checks_total-review.coverage.checks_reviewed);
  const contextFailure=review.tasks.some(t=>t.status==="failed"&&/context|上下文/.test(t.error??""));
  const citationFailure=review.tasks.some(t=>t.status==="failed"&&/引用|原頁|證據|片段/.test(t.error??""));
  const layoutOnly=review.gaps.every(g=>/圖|矩陣|跨欄|多欄|版面|OCR|無文字頁/.test(g));
  const seconds=Math.max(0,Math.floor(((review.status==="running"?clock:Date.parse(review.updated_at))-Date.parse(review.started_at))/1000))||0;
  const elapsed=`${Math.floor(seconds/60)}分${seconds%60}秒`;
  const freshness=review.rule_freshness?.status;
  async function resume(){setBusy(true);setError("");try{const p=review.profile;props.onChange(ConsistencyReportSchema.parse(await props.request({action:"c2-start",run_id:props.report.run_id,profile:{period_start:p.period_start,period_end:p.period_end,part_d_mandatory:p.part_d_mandatory,...(p.primary_esg_slot?{primary_esg_slot:p.primary_esg_slot}:{})}})));}catch(e){setError(e instanceof Error?e.message:"未能繼續核對。");}finally{setBusy(false);}}
  return <section className="c2-status-panel" aria-label="C2披露檢查狀態"><div><strong>{review.status==="running"?`C2 核對中 · ${progress.percent}%`:review.status==="failed"||failed?`${remaining}項未完成，已完成結果保留`:review.gaps.length?layoutOnly?"文字核對完成，部分圖表需確認":"文字核對完成，部分範圍待確認":"C2 文字核對完成"}</strong><span>已核對 {review.coverage.checks_reviewed}/{review.coverage.checks_total} 項</span><small>本次用時 {elapsed}</small><small className={freshness==="full_text_matches"?"verified":"pending"}>{freshness==="full_text_matches"?"官方全文版本已核對":freshness==="rules_changed"?"官方規則已變更，已停止":"規則最新版本待確認"}</small>{(review.status==="failed"||failed)&&<button disabled={busy} onClick={()=>void resume()}>{busy?"正在繼續…":"繼續未完成部分"}</button>}</div>
    {review.status!=="running"&&(failed||review.status==="failed")&&<p role="status">{contextFailure?"單次讀取的內容過多，本批尚未開始核對。原件及已完成結果保留。":citationFailure?"模型引文未能對上報告原頁，相關項目尚未有結論。":"部分核對未能完成，相關項目尚未有結論。"}按「繼續未完成部分」重試。</p>}
    {review.status==="running"&&<><progress aria-label="C2核對步驟進度" aria-valuetext={`初核完成${progress.firstPass}項，已出結果${progress.counts.completed}項`} value={progress.weighted??review.completed_tasks} max={progress.weighted===undefined?review.total_tasks:Math.max(1,progress.total*2)} title="按已完成的初核及覆核項目計算；處理中不會自動增加百分比。"/>
      <div className="c2-live-counts" aria-label="即時項目進度">{(['completed','reading','verifying','queued','failed'] as const).map(state=><span key={state} data-state={state}><b>{C2_TASK_LABELS[state]} {progress.counts[state]}</b></span>)}<small>每5秒自動更新 · 背景回報 {age(review.updated_at)}前</small></div>
      {!!activeTasks.length&&<div className="c2-live-tasks" aria-label="正在處理的批次">{activeTasks.map(task=><div key={task.id}><strong><i aria-hidden="true"/>{task.label} · {C2_TASK_LABELS[c2TaskState(task)]}{task.check_ids?` ${task.check_ids.length}項`:''}</strong><span>{c2TaskActivity(task)}{task.phase_started_at?` · 本輪 ${age(task.phase_started_at)}`:''}{task.activity?.updated_at?` · 最近回傳 ${age(task.activity.updated_at)}前`:''}</span></div>)}</div>}
      {!review.coverage.checks_reviewed&&<p className="c2-awaiting-results">首批覆核完成後會出現結果；目前處理中的項目可在「檢查總覽」查看。</p>}
    </>}
    {review.source_plan&&<div className="c2-source-scope" aria-label="本次全文核對範圍">全文核對：{review.source_plan.documents.map(d=>`${props.report.documents.find(s=>s.slot===d.slot)?.label??d.slot} ${d.pages}頁`).join(" ＋ ")}{!!review.source_plan.historical_documents.length&&<small>；氣候計劃另對照去年 ESG</small>}</div>}
    <div className="c2-part-counts">{review.coverage.parts.map(p=><span key={p.part}>Part {p.part} · {p.reviewed}/{p.total}</span>)}<span>{review.profile.period_start} 至 {review.profile.period_end}</span></div>
    <details><summary>{review.gaps.length?`未核實範圍（${review.gaps.length}）`:`進度及適用範圍 · ${review.completed_tasks}/${review.total_tasks} 步`}</summary><div className="c2-progress-list">{review.tasks.map(t=><p key={t.id}><strong>{t.label}</strong> · {t.phase}{t.error?`：${/context|上下文/.test(t.error)?"內容超出單次處理上限，尚未核對。":t.error}`:""}</p>)}{review.gaps.map((g,i)=><p key={i}>{g}</p>)}{review.source_plan&&<p>{review.source_plan.policy}</p>}<p>主板 C2 · 清單 {review.catalog_revision} · {review.coverage.inventory_units} 個條款／KPI單元。{review.scope_note}</p><p>模型：{review.model} · {review.reasoning_effort}。有披露證據不代表已核實台帳或完成合規審批。</p></div></details>
    {(error||review.error)&&<p role="alert" className="finance-error">{error||review.error}</p>}
  </section>;
}

export function C2FindingDetails(props:{report:ConsistencyReport;check:ConsistencyReport['checks'][number];editor:ConsistencyEditor|null;request:Request;onChange:(value:ConsistencyEditor)=>void;onDecided:(operation:'accept'|'dismiss')=>void;onSelectRef:(index:number)=>void}) {
  const {check,report}=props,rule=check.regulatory!;
  const actionable=reviewAction(check,props.editor?.proposals[check.id]);
  const refs=check.refs.map((ref,index)=>({ref,index})).filter(({ref,index})=>check.refs.findIndex(r=>r.slot===ref.slot&&r.page===ref.page)===index);
  return <div className="c2-finding-details">
    {rule.obligation==='recommended'&&<small className="c2-optional-note">可選改善 · 建議披露</small>}
    <div className="c2-brief-problem"><strong>{actionable?'問題':'核對結果'}</strong><p>{check.reader_copy?.problem??check.reason}</p></div>
    {actionable&&<ConsistencyEditCard report={report} check={check} editor={props.editor} request={props.request} onChange={props.onChange} onDecided={props.onDecided}/>}
    <div className="c2-brief-sources"><C2RuleCitation compact report={report} check={check} request={props.request} showAction={false}/><div className="consistency-values">{refs.map(({ref,index})=><button key={index} title="查看引用原頁" onClick={()=>props.onSelectRef(index)}>{report.documents.find(d=>d.slot===ref.slot)?.label} p.{ref.page}</button>)}</div></div>
    <details className="c2-full-analysis"><summary>完整分析與規則要求</summary><small>{C2_OBLIGATIONS[rule.obligation]??rule.obligation}</small><p>{check.reason}</p><p><strong>要求：</strong>{rule.criteria}</p><p><strong>處理建議：</strong>{rule.action}</p>{rule.missing_elements.length>0&&<ul>{rule.missing_elements.map((s,i)=><li key={i}>{s}</li>)}</ul>}</details>
  </div>;
}

export function C2RuleCitation(props:{report:ConsistencyReport;check:ConsistencyReport['checks'][number];request:Request;showAction?:boolean;compact?:boolean}){
  const rule=props.check.regulatory!,[open,setOpen]=useState(false),[image,setImage]=useState(""),[error,setError]=useState("");
  const clause=rule.clause.endsWith('-GD')?`${rule.clause.slice(0,-3)} 一般披露`:rule.clause.split('-')[0];
  const close=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;let active=true;close.current?.focus();setImage("");setError("");void props.request({action:"c2-rule-page",run_id:props.report.run_id,page:rule.rule_page}).then(value=>{if(active)setImage((value as {data_url:string}).data_url);}).catch(()=>{if(active)setError("未能載入守則原頁，請重試。");});return()=>{active=false;};},[open,props.report.run_id,rule.rule_page]);
  return <div className="c2-rule-citation"><div><button onClick={()=>setOpen(true)}>C2 {clause} · 規則 p.{rule.rule_page}</button>{!props.compact&&<small>{C2_OBLIGATIONS[rule.obligation]??rule.obligation}</small>}</div>{props.showAction!==false&&<p>{rule.action}</p>}{!props.compact&&rule.missing_elements.length>0&&<ul>{rule.missing_elements.map((s,i)=><li key={i}>{s}</li>)}</ul>}
    {open&&createPortal(<div className="c2-rule-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setOpen(false);}}><section role="dialog" aria-modal="true" aria-label={`C2 ${clause} 規則原文`} className="c2-rule-dialog" onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();setOpen(false);}if(e.key==="Tab"){e.preventDefault();close.current?.focus();}}}><header><strong>C2 {clause} · 規則 PDF {rule.rule_page}</strong><button ref={close} aria-label="關閉規則原文" onClick={()=>setOpen(false)}>✕</button></header><p>{rule.criteria}</p><blockquote>{rule.rule_quote}</blockquote>{image?<img src={image} alt={`HKEX C2 規則 PDF ${rule.rule_page}`}/>:<p role={error?"alert":"status"}>{error||"正在載入守則原頁…"}</p>}</section></div>,document.body)}
  </div>;
}
