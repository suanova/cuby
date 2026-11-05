import { useCallback, useEffect, useRef, useState } from "react";
import { C2_OUTCOME_LABELS, availableConsistencyComparisons, ConsistencyReportSchema, buildConsistencyQuestion, consistencyCheckState, type ConsistencyReport, type ConsistencySlot, type ConsistencySourceSlot, type ConsistencyComparison, type FinanceRequest } from "@memmy/local-api-contracts";
export { buildConsistencyQuestion } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { useConsistencyEditor, ConsistencyEditCard, ConsistencyEditDraftProvider, ConsistencyDraftExport, ConsistencySuggestionStatus } from "./consistency-edit-controls.js";
import {C2StatusPanel,C2FindingDetails} from "./c2-review-controls.js";
import { reviewAction, REVIEW_ACTIONS, REVIEW_ACTION_LABELS, type ReviewAction } from "./consistency-actions.js";
import { ConsistencyOverview } from "./consistency-overview.js";
import { consistencyWorkItems } from "./consistency-work-items.js";
import { c2CheckTask, c2TaskState, C2_TASK_LABELS } from "./c2-progress.js";
import { bilingualSourcePair, ConsistencySourceComparison } from "./consistency-source-comparison.js";
import { ConsistencyFollowupCard, useConsistencyFollowups, type ConsistencyFollowupContext } from "./consistency-followups.js";

const SLOTS: [ConsistencySlot,string][] = [["esg_zh","ESG · 繁中"],["esg_en","ESG · English"],["annual_zh","年報 · 繁中"],["annual_en","年報 · English"]];
const COMPARISONS:[ConsistencyComparison,string][]=[["bilingual","中英版本"],["cross_report","ESG ↔ 年報"],["internal","報告內部"],["restatement","跨年重述"]];
type Request = (input:FinanceRequest)=>Promise<unknown>;
export function ConsistencySetup(props:{client:MemmyAgentClient;request:Request;onComplete:(r:ConsistencyReport)=>void}) {
  const [mode,setMode]=useState("upload"),[year,setYear]=useState("2025/26");
  const [files,setFiles]=useState<Partial<Record<ConsistencySlot,File>>>({});
  const [comparisons,setComparisons]=useState<ConsistencyComparison[]>(COMPARISONS.map(([id])=>id));
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [lastRun]=useState(()=>localStorage.getItem("financebuddy.consistency.lastRun"));
  async function run(previous=false) {
    setBusy(true);setError("");
    try {
      let result:unknown;
      if(previous && lastRun) result=await props.request({action:"consistency-read",run_id:lastRun});
      else {
        let documents:{slot:ConsistencySlot;path:string}[]|undefined;
        if(mode==="upload") {
          if(!SLOTS.every(([s])=>files[s])) throw new Error("請為四個位置各選一份 PDF。");
          if(SLOTS.some(([s])=>files[s]!.size>30*1024*1024)) throw new Error("每份 PDF 上限 30 MB。");
          const uploaded=await props.client.uploadAgentMedia(SLOTS.map(([slot])=>({blob:files[slot]!,name:slot+"-"+files[slot]!.name,mime:"application/pdf",kind:"file"})));
          if(uploaded.length!==4 || uploaded.some(f=>f.kind!=="file" || f.mime!=="application/pdf")) throw new Error("四份 PDF 未能完整上載，請重試。");
          documents=SLOTS.map(([slot],i)=>({slot,path:uploaded[i]!.path}));
        }
        result=await props.request({action:"consistency-build",fiscal_year:year,comparisons,...(documents?{documents}:{})});
      }
      const report=ConsistencyReportSchema.parse(result);
      localStorage.setItem("financebuddy.consistency.lastRun",report.run_id);
      if(!previous) {
        try {props.onComplete(ConsistencyReportSchema.parse(await props.request({action:"consistency-semantic-start",run_id:report.run_id})));}
        catch(e) {props.onComplete(report);}
      } else props.onComplete(report);
    } catch(e) {setError(e instanceof Error?e.message:"核對未能完成。");} finally {setBusy(false);}
  }
  return <div className="finance-setup consistency-setup">
    <p>需求⑤ · 本年四份草稿＋WeKnora 歷史基準</p>
    <label>文件來源<select value={mode} disabled={busy} onChange={e=>{setMode(e.target.value);if(e.target.value==="existing")setYear("2025/26");}}>
      <option value="upload">上載本年四份草稿 PDF</option><option value="existing">試用本機 FY2025/26 四份範例</option>
    </select></label>
    <label>財年<input aria-label="一致性核對財年" value={year} disabled={busy||mode==="existing"} onChange={e=>setYear(e.target.value)} placeholder="2025/26" /></label>
    <div className="consistency-upload-grid">{SLOTS.map(([slot,label])=><label key={slot}>{label}
      {mode==="upload"?<input type="file" aria-label={`上載 ${label}`} accept="application/pdf,.pdf" disabled={busy} onChange={e=>setFiles(f=>({...f,[slot]:e.target.files?.[0]}))}/>:<small>億都 · FY2025/26 · 已有本機原件</small>}
    </label>)}</div>
    <fieldset className="consistency-comparison-choices"><legend>核對範圍 · 預設全部</legend>{COMPARISONS.map(([id,label])=><label key={id}><input type="checkbox" checked={comparisons.includes(id)} disabled={busy} onChange={e=>setComparisons(v=>e.target.checked?[...v,id]:v.filter(x=>x!==id))}/>{label}</label>)}</fieldset>
    <p className="finance-muted">跨年會向 WeKnora 核實上年度原件及版本；本年以今次上載草稿為準。已支援表格先作數值核對，全文方法與邊界未確認的項目保留待核。上載不會自動寫入共享知識庫。</p>
    {error&&<p className="finance-error" role="alert">{error}</p>}
    <button className="finance-primary" disabled={busy || !comparisons.length || !/^20\d{2}\/\d{2}$/.test(year) || (mode==="upload"&&!SLOTS.every(([s])=>files[s]))} onClick={()=>void run()}>{busy?"正在上載／核對本年及歷史文件…":"開始一致性核對"}</button>
    {lastRun&&<button disabled={busy} onClick={()=>void run(true)}>開啟上次結果</button>}
  </div>;
}

const LABELS={matched:"已核對一致",difference:"發現差異",needs_confirmation:"待確認",not_checked:"未檢查",candidate:"初篩紀錄 · 未確認差異"};
type ReviewCheck = ConsistencyReport['checks'][number];
function referencePair(check:ReviewCheck):[number,number] {
  const refs=check.refs;
  const kind=check.semantic_kind??check.category;
  if(check.regulatory)return [0,1];
  const prior=(slot:string)=>slot.startsWith("prior_");
  const base=(slot:string)=>slot.replace(/^prior_/,"");
  const pair=(matches:(left:string,right:string)=>boolean):[number,number]|undefined=>{
    for(let left=0;left<refs.length;left++)for(let right=0;right<refs.length;right++){
      if(left!==right&&matches(refs[left]!.slot,refs[right]!.slot))return [left,right];
    }
  };
  // Several quotations can refer to one language; pair sources, not citation order.
  if(kind==="restatement")return pair((a,b)=>!prior(a)&&prior(b)&&base(a)===base(b))??pair((a,b)=>!prior(a)&&prior(b))??[0,1];
  if(kind==="cross_report")return pair((a,b)=>base(a).startsWith("esg_")&&base(b).startsWith("annual_")&&a.endsWith("_zh")===b.endsWith("_zh")&&prior(a)===prior(b))??pair((a,b)=>base(a).startsWith("esg_")&&base(b).startsWith("annual_")&&prior(a)===prior(b))??[0,1];
  if(kind==="internal")return [0,1];
  return pair((a,b)=>a.endsWith("_zh")&&b.endsWith("_en")&&a.replace(/_zh$/,"")===b.replace(/_en$/,""))??[0,1];
}
function download(text:string,name:string,type:string) {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function SemanticProgress({review}:{review:NonNullable<ConsistencyReport['semantic']>}) {
  const [clock,setClock]=useState(Date.now);
  useEffect(()=>{setClock(Date.now());if(review.status!=="running")return;const timer=setInterval(()=>setClock(Date.now()),15000);return()=>clearInterval(timer);},[review.job_id,review.status]);
  const percent=Math.max(0,Math.min(100,Math.round(review.completed_tasks/Math.max(1,review.total_tasks)*100)));
  const start=Date.parse(review.started_at??""),end=review.status==="running"?clock:Date.parse(review.updated_at);
  const minutes=Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/60000)):undefined;
  const labels:Record<ConsistencyComparison,string>={bilingual:"中英意思",cross_report:"ESG／年報",internal:"內文前後",restatement:"跨年說法"};
  const steps=[...review.tasks.map(t=>({label:labels[t.id],status:t.status})),{label:"覆核差異",status:["completed","partial"].includes(review.status)?"completed":review.status==="failed"&&review.tasks.every(t=>t.status==="completed")?"failed":review.status==="running"&&review.phase?.includes("覆核")?"running":"pending"}];
  const states:Record<string,string>={completed:"已完成",running:"核對中",pending:"待進行",failed:"未完成"};
  const failed=review.tasks.filter(t=>t.status==="failed");
  return <div className={`consistency-semantic-progress ${review.status}`}>
    <div className="consistency-progress-numbers"><strong>{review.status==="running"?`步驟進度 ${percent}%`:`核對已結束 · ${review.completed_tasks}/${review.total_tasks}步成功`}</strong>{minutes!==undefined&&<span>{review.status==="running"?"已用":"用時"} {minutes<1?"少於1分鐘":`${minutes}分鐘`}</span>}{review.status==="running"&&<span>剩餘時間：暫未能估算</span>}</div>
    {review.status==="running"&&<progress aria-label="內文核對步驟進度" aria-valuetext={`已完成 ${review.completed_tasks}/${review.total_tasks} 步`} value={Math.min(review.completed_tasks,review.total_tasks)} max={review.total_tasks} title="按已完成步驟更新；每步所需時間不同。"/>}
    {failed.map(t=><p key={t.id} className="consistency-interrupted">{t.label}未完成：{t.error} 已完成部分已保留。</p>)}
    <ol aria-label="內文核對步驟">{steps.map((step,i)=><li key={i} className={step.status} aria-label={`${step.label}：${states[step.status]}`}><span aria-hidden="true">{step.status==="completed"?"✓":step.status==="failed"?"!":"●"}</span>{step.label}{step.status==="running"&&<small>核對中</small>}</li>)}</ol>
  </div>;
}
export function ConsistencyReader(props:{report:ConsistencyReport;request:Request;followupContext?:ConsistencyFollowupContext;download?:(id:string)=>Promise<Blob>;onAsk?:(prompt:string)=>Promise<void>;busy?:boolean;askBlockedReason?:string;askQueued?:boolean;askRecovery?:{label:string;onClick:()=>void};onShowChat?:()=>void;onReportChange?:(report:ConsistencyReport)=>void;onSupplement?:()=>void}) {
  const [report,setReport]=useState(props.report);
  const followups=useConsistencyFollowups(report,props.followupContext,props.request);
  const {editor,setEditor,error:editorError}=useConsistencyEditor(report.run_id,props.request,report.checks.map(c=>c.id+":"+c.review_state).join(","));
  useEffect(()=>{setReport(props.report);},[props.report]);
  const updateReport=(next:ConsistencyReport)=>{setReport(next);props.onReportChange?.(next);};
  const [semanticBusy,setSemanticBusy]=useState(false),[semanticError,setSemanticError]=useState("");
  const finalVerificationOnly=!!report.semantic?.tasks.length&&report.semantic.tasks.every(t=>t.status==="completed");
  async function startSemantic() {
    setSemanticBusy(true);setSemanticError("");
    try {updateReport(ConsistencyReportSchema.parse(await props.request({action:"consistency-semantic-start",run_id:report.run_id})));}
    catch(e){setSemanticError(e instanceof Error?e.message:"內容核對未能開始。");}finally{setSemanticBusy(false);}
  }
  useEffect(()=>{
    if(report.semantic?.status!=="running"&&report.compliance?.status!=="running")return;
    let active=true,inFlight=false;
    const timer=setInterval(()=>{if(inFlight)return;inFlight=true;void props.request({action:"consistency-read",run_id:report.run_id}).then(value=>{if(active){updateReport(ConsistencyReportSchema.parse(value));setSemanticError("");}}).catch(()=>{if(active)setSemanticError("暫時未能更新進度，正在重試。");}).finally(()=>{inFlight=false;});},5000);
    return()=>{active=false;clearInterval(timer);};
  },[report.run_id,report.semantic?.status,report.compliance?.status,props.request]);
  const [selected,setSelected]=useState(()=>report.checks.find(c=>c.status==="difference")?.id??report.checks[0]?.id??"");
  const [filter,setFilter]=useState("issues"),[query,setQuery]=useState(""),[c2Part,setC2Part]=useState("all");
  const [navigation,setNavigation]=useState<{key:string;indices:[number,number];version:number}>({key:"",indices:[0,1],version:0});
  const listRef=useRef<HTMLDivElement>(null);
  const displayed=report.compliance?report.checks.filter(c=>c.category==="regulatory"):report.checks;
  const workItems=consistencyWorkItems(displayed,editor);
  const workChecks=workItems.map(item=>item.check);
  const todo=workChecks.filter(c=>!editor?.decisions[c.id]&&reviewAction(c,editor?.proposals[c.id]));
  const recordCount=displayed.filter(c=>consistencyCheckState(c)!=="candidate").length;
  const acceptedCount=workChecks.filter(c=>editor?.decisions[c.id]?.status==="accepted").length;
  const dismissedCount=workChecks.filter(c=>editor?.decisions[c.id]?.status==="dismissed").length;
  const actionCounts=Object.fromEntries(REVIEW_ACTIONS.map(action=>[action,todo.filter(c=>reviewAction(c,editor?.proposals[c.id])===action).length])) as Record<ReviewAction,number>;
  const primaryFilter=["issues","action-edit","action-verify","action-supplement","resolved"].includes(filter)?filter:"records";
  const workView=["issues","action-edit","action-verify","action-supplement","resolved","accepted","dismissed"].includes(filter);
  const visible=(workView?workChecks:displayed).filter(c=>{
    const state=consistencyCheckState(c);
    const decision=editor?.decisions[c.id];
    const c2=c.regulatory;
    const action=reviewAction(c,editor?.proposals[c.id]);
    const selected=filter.startsWith("action-")?!decision&&action===filter.slice(7):filter==="resolved"?!!decision:filter==="c2-all"?!!c2:filter==="c2-issues"?!!c2&&!decision&&["conflict","partially_disclosed","not_located"].includes(c2.outcome):filter==="c2-disclosed"?c2?.outcome==="disclosed":filter==="c2-explanations"?c2?.outcome==="explanation_claim":filter==="c2-data"?c2&&["external_evidence_needed","applicability_pending","not_applicable"].includes(c2.outcome):filter==="c2-unreviewed"?c2?.outcome==="not_reviewed":filter==="accepted"||filter==="dismissed"?decision?.status===filter:filter==="all"?state!=="candidate":filter==="semantic"?!!c.semantic_kind:filter==="issues"?!decision&&!!action:["difference","needs_confirmation","not_checked","matched"].includes(filter)?state===filter:c.category===filter;
    return selected&&(primaryFilter!=="records"||c2Part==="all"||c2?.part===c2Part)&&(c.title+c.reason+(c.reader_copy?.title??"")+(c.reader_copy?.problem??"")+(c.reader_copy?.next_step??"")+(c2?.clause??"")).includes(query);
  });
  if(filter==="issues"||filter==="c2-issues")visible.sort((a,b)=>Number(consistencyCheckState(a)!=="difference")-Number(consistencyCheckState(b)!=="difference"));
  const check=visible.find(c=>c.id===selected||workView&&workItems.find(item=>item.check.id===c.id)?.members.some(member=>member.id===selected))??visible[0];
  const editCheck=workItems.find(item=>editor?.decisions[item.check.id]&&item.members.some(member=>member.id===check?.id))?.check??check;
  const checkKey=report.run_id+":"+check?.id;
  const references:[number,number]=navigation.key===checkKey?navigation.indices:check?referencePair(check):[0,1];
  function selectCheck(next:ReviewCheck) {
    setSelected(next.id);
    setNavigation(v=>({key:report.run_id+":"+next.id,indices:referencePair(next),version:v.version+1}));
    setAskStatus("");
  }
  function selectReference(index:number) {
    if(!check)return;
    const indices:[number,number]=[references[0]!,references[1]!];
    const slot=check.refs[index]!.slot;
    const leftSlot=check.refs[indices[0]]?.slot,rightSlot=check.refs[indices[1]]?.slot;
    const pane=report.compliance||slot===leftSlot&&slot!==rightSlot?0:slot===rightSlot&&slot!==leftSlot?1:index===0?0:1;
    indices[pane]=index;
    setNavigation(v=>({key:checkKey,indices,version:v.version+1}));
  }
  const state=check?consistencyCheckState(check):undefined;
  const sourcePair=check?bilingualSourcePair(check,report.documents,report.source_focus?.[check.id]):null;
  const unresolved=displayed.filter(c=>consistencyCheckState(c)==="needs_confirmation").length;
  const unchecked=displayed.filter(c=>consistencyCheckState(c)==="not_checked").length;
  const fallbackSlot=report.documents.find(d=>d.slot===report.compliance?.profile.primary_esg_slot)?.slot??report.documents.find(d=>!d.slot.startsWith("prior_"))!.slot;
  const [details,setDetails]=useState(false);
  const [reading,setReading]=useState(false);
  const [issueOpen,setIssueOpen]=useState(false);
  const [overviewOpen,setOverviewOpen]=useState(false);
  const [question,setQuestion]=useState(""),[asking,setAsking]=useState(false),[askStatus,setAskStatus]=useState("");
  const [decisionNotice,setDecisionNotice]=useState("");
  function advanceAfterDecision(id:string,operation:"accept"|"dismiss") {
    setDecisionNotice(operation==="accept"?"已加入修訂稿。":"已忽略。");
    if(primaryFilter==="records"||primaryFilter==="resolved")return;
    const index=visible.findIndex(c=>c.id===id);
    const next=[...visible.slice(index+1),...visible.slice(0,index)].find(c=>c.id!==id&&!editor?.decisions[c.id]);
    if(next)selectCheck(next);
  }
  useEffect(()=>{
    const selectedCard=listRef.current?.querySelector<HTMLElement>('.consistency-check-item--active');
    selectedCard?.scrollIntoView?.({block:"start"});
  },[checkKey]);
  async function ask() {
    if(!check||!props.onAsk)return;setAsking(true);setAskStatus("");
    try {await props.onAsk(buildConsistencyQuestion(report.run_id,check.id,question));setQuestion("");setAskStatus("已送到對話。");setIssueOpen(false);}
    catch(e){setAskStatus(e instanceof Error?e.message:"未能送出追問。");}finally{setAsking(false);}
  }
  function csv() {
    const cell=(s:unknown)=>'"'+String(s??"").replaceAll('"','""')+'"';
    download('\uFEFF'+[["項目","條款","義務","結果","原因","補充建議","缺少要素","規則頁碼","原文與頁碼"],...displayed.filter(c=>consistencyCheckState(c)!=="candidate").map(c=>[c.title,c.regulatory?.clause??c.category,c.regulatory?.obligation??"",c.regulatory?C2_OUTCOME_LABELS[c.regulatory.outcome]:LABELS[consistencyCheckState(c)],c.reason,c.regulatory?.action??"",c.regulatory?.missing_elements.join('；')??"",c.regulatory?.rule_page??"",JSON.stringify(c.refs)])].map(row=>row.map(cell).join(',')).join('\r\n'),`${report.compliance?"c2-disclosure":"consistency"}-${report.fiscal_year.replace('/','-')}.csv`,"text/csv;charset=utf-8");
  }
  const sourceDocuments=report.compliance?.source_plan?.documents;
  const sourcePages=sourceDocuments?.reduce((sum,d)=>sum+d.pages,0)??report.coverage.scanned_pages;
  return <ConsistencyEditDraftProvider key={report.run_id} report={report} editor={editor}><div className={`consistency-reader${reading?" consistency-reader--reading":""}`}>
    <div className="consistency-summary"><strong>{report.compliance?"C2 披露檢查結果":"一致性審閱結果"} · FY{report.fiscal_year} · {sourceDocuments?`主審${sourceDocuments.length}`:report.documents.filter(d=>!d.slot.startsWith("prior_")).length}份文件</strong>
      <span>{sourcePages}頁{sourceDocuments?"全文":"已掃描"} · {report.compliance?`${report.compliance.coverage.checks_total}項C2核對`:report.comparisons.includes("bilingual")?`${report.coverage.metric_checks}組中英指標`:`${report.coverage.internal_checks}項內部檢查 · ${report.coverage.restatement_checks}項跨年檢查`}</span>
      <button aria-expanded={overviewOpen} onClick={()=>setOverviewOpen(true)}>檢查總覽</button>
      <button onClick={()=>setReading(!reading)}>{reading?"返回審閱":"專注閱讀"}</button>
      <ConsistencyDraftExport report={report} editor={editor} request={props.request} download={props.download}/>
      <button onClick={csv}>匯出表格</button><button onClick={()=>download(JSON.stringify(report,null,2),"consistency-review.json","application/json")}>核對記錄</button>
    </div>
    {details&&!report.compliance&&<div className="finance-review-coverage" aria-label="本次檢查範圍">{([["internal","內文與數據"],["bilingual","中英對照"],["cross_report","ESG／年報"],["restatement","與去年比較"]] as const).map(([id,label])=>{
      const available=availableConsistencyComparisons(report.documents.filter(d=>!d.slot.startsWith("prior_")).map(d=>d.slot as ConsistencySlot));
      return <span key={id} className={report.comparisons.includes(id)?"selected":"unavailable"}>{label}：{report.comparisons.includes(id)?id==="restatement"&&report.history.status==="unavailable"?"歷史文件未就緒":"已選":available.includes(id)?"未選":"缺少對應文件"}</span>;
    })}<small>規則披露：本次未執行</small></div>}
    {report.compliance&&<C2StatusPanel report={report} request={props.request} onChange={updateReport}/>}
    {report.compliance&&semanticError&&<p className="finance-error" role="status">{semanticError}</p>}
    {editorError&&<div className="finance-error" role="alert">{editorError}</div>}
    <div className="consistency-toolbar">
    <div className="consistency-counts consistency-action-counts" aria-label="按處理方式分類"><button aria-pressed={filter==="issues"} onClick={()=>setFilter("issues")}>全部待辦 {todo.length}</button>{REVIEW_ACTIONS.map(action=><button key={action} data-action={action} aria-pressed={filter===`action-${action}`} onClick={()=>setFilter(`action-${action}`)}>{REVIEW_ACTION_LABELS[action]} {actionCounts[action]}</button>)}<span className="consistency-count-divider" aria-hidden="true"/><button aria-pressed={filter==="accepted"} onClick={()=>setFilter("accepted")}>已接受 {acceptedCount}</button><button aria-pressed={filter==="dismissed"} onClick={()=>setFilter("dismissed")}>已忽略 {dismissedCount}</button><button title="包含一致、有差異及尚未完成的檢查；不是問題數。" onClick={()=>setOverviewOpen(true)}>檢查紀錄 {recordCount}筆</button><button onClick={()=>setDetails(!details)} aria-expanded={details}>{details?"收起詳情":"檢查詳情"}</button></div>
      <ConsistencySuggestionStatus editor={editor} request={props.request} onChange={setEditor}/>
    </div>
    {details&&<div className="consistency-history-status">歷史基準：{report.history.source} · FY{report.history.fiscal_year} · {report.history.status==="ready"?`已核實（${report.coverage.historical_pages}頁）`:report.history.status==="not_requested"?"本次未選跨年核對":"未能取得，跨年仍未核對"} · 內部 {report.coverage.internal_checks}項 · 跨年 {report.coverage.restatement_checks}項</div>}
    {(!report.compliance||report.semantic)&&<div className="consistency-semantic-status" role="status">
      {props.onSupplement&&!report.compliance&&(report.history.status==='unavailable'||!!report.history.missing_slots?.length)&&<button className="consistency-supplement-button" disabled={report.semantic?.status==='running'} onClick={props.onSupplement}>補上去年報告</button>}
      <strong>{!report.semantic?"內文意思尚未核對":report.semantic.status==="running"?`正在核對內文 · ${report.semantic.completed_tasks}/${report.semantic.total_tasks}步${report.semantic.phase?` · ${report.semantic.phase}`:""}`:report.semantic.status==="completed"?"內文核對完成":report.semantic.status==="partial"?report.semantic.tasks.some(t=>t.status==="failed")?"內文核對部分完成":`核對已結束 · ${report.semantic.gaps.length}項未能核實`:finalVerificationOnly?"最後覆核中斷，前面結果已保留":"內文核對中斷，已完成結果保留"}</strong>
      {(!report.semantic||report.semantic.status==="failed"||report.semantic.status==="partial"&&report.semantic.tasks.some(t=>t.status==="failed"))&&<button disabled={semanticBusy} title="沿用已保存結果，只重跑未完成步驟；已接受及忽略的修改保留。" onClick={()=>void startSemantic()}>{semanticBusy?"啟動中…":report.semantic?finalVerificationOnly?"繼續最後覆核":"繼續核對":"核對內文"}</button>}
      {report.semantic?.status==="failed"&&<span>已保存 {report.semantic.completed_tasks}/{report.semantic.total_tasks} 步，毋須重新上載。</span>}
      {!!report.semantic?.matched_count&&<button onClick={()=>setFilter("semantic")}>查看內容核對</button>}
      {semanticError&&<span className="finance-error">{semanticError}</span>}
      {report.semantic?.error&&<span className="finance-error">{report.semantic.error}</span>}
      {report.semantic&&<details className="consistency-progress-details"><summary>{report.semantic.status==="running"?`${Math.round(report.semantic.completed_tasks/Math.max(1,report.semantic.total_tasks)*100)}% · 進度詳情`:report.semantic.gaps.length?`未核實範圍（${report.semantic.gaps.length}）`:"查看核對狀態"}</summary><SemanticProgress review={report.semantic}/>{report.semantic.gaps.length>0&&<ul className="consistency-unchecked-list">{report.semantic.gaps.map((gap,i)=><li key={i}>{gap}</li>)}</ul>}</details>}
    </div>}
    {details&&<div className="finance-scope"><p>差異 {displayed.filter(c=>consistencyCheckState(c)==="difference").length} · 待確認 {unresolved} · 尚未核對 {unchecked}。分類按你下一步要做的事，不改變原有核對結論。</p><p>已掃描全文 ≠ 全部數字及口徑已確認。</p><ul>{report.limits.map(t=><li key={t}>{t}</li>)}</ul>{report.semantic&&<><p>內文模型：{report.semantic.model} · {report.semantic.reasoning_effort}。各項一致只指所列主題。</p>{report.semantic.tasks.map(t=><p key={t.id}>{t.label}：{t.status==="completed"?"已核對":t.status==="running"?"核對中":"未完成"} · 提交{t.submitted_pages}頁原文{t.error?` · ${t.error}`:""}</p>)}<ul>{report.semantic.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></>}<p>{report.coverage.page_pairs}組同頁數字初篩，其中{report.coverage.same_numeric_inventory_pages}組數字集合相同；只作定位參考。</p>{report.documents.map(d=><p key={d.slot}>{d.label} · {d.file_name} · {d.page_count}頁{!d.cover_year_found?" · 財年待核":""}{d.textless_pages.length?` · ${d.textless_pages.length}頁未取到文字`:""}</p>)}</div>}
    <div className="consistency-body">
      <section className="consistency-checks" aria-label={report.compliance?"C2核對項目":"一致性核對項目"}>
        <input aria-label={report.compliance?"搜尋C2項目":"搜尋一致性項目"} placeholder={report.compliance?"搜尋條款或披露":"搜尋指標"} value={query} onChange={e=>setQuery(e.target.value)}/>
        <select aria-label={report.compliance?"C2結果分類":"一致性項目分類"} value={primaryFilter} onChange={e=>setFilter(e.target.value==="records"?report.compliance?"c2-all":"all":e.target.value)}><option value="issues">全部待辦</option><option value="action-edit">修改文字</option><option value="action-verify">核實資料</option><option value="action-supplement">補充說明</option><option value="resolved">已處理</option><option value="records">檢查記錄</option></select>
        {primaryFilter==="records"&&<><select aria-label="檢查記錄分類" value={filter} onChange={e=>setFilter(e.target.value)}>{report.compliance?<><option value="c2-all">全部 C2 核對項</option><option value="c2-disclosed">有披露證據</option><option value="c2-explanations">解釋待核</option><option value="c2-data">補件及適用性</option><option value="c2-unreviewed">尚未核對</option></>:<><option value="all">全部核對結果</option><option value="difference">具體差異</option><option value="needs_confirmation">待確認</option><option value="not_checked">未檢查</option><option value="matched">已核對一致</option><option value="semantic">內容核對結果</option><option value="metric">中英指標</option><option value="basis">方法與口徑</option><option value="cross_report">ESG ↔ 年報</option><option value="internal">報告內部</option><option value="restatement">跨年重述</option><option value="page_numbers">同頁數字初篩（進階）</option></>}<option value="accepted">已接受修改</option><option value="dismissed">已忽略</option></select>{report.compliance&&<select aria-label="C2章節" value={c2Part} onChange={e=>setC2Part(e.target.value)}><option value="all">所有章節</option><option value="A">A · 報告原則及發布</option><option value="B">B · 強制披露</option><option value="C">C · 環境及社會</option><option value="D">D · 氣候披露</option></select>}</>}
        {filter==="page_numbers"&&<p className="consistency-scan-note">只比較同頁碼的數字，未確認段落是否對應。初篩紀錄不算報告問題。</p>}
        <div className="consistency-queue-guide"><span>{decisionNotice||"選中問題 → 查看改法 → 接受或忽略"}</span>{decisionNotice&&<button onClick={()=>{setFilter("resolved");setDecisionNotice("");}}>查看／撤回</button>}</div>
        <div className="consistency-check-list" ref={listRef}>{visible.map(c=>{
          const cardState=consistencyCheckState(c);
          const [current,previous]=c.refs;
          const owner=workItems.find(item=>editor?.decisions[item.check.id]&&item.members.some(member=>member.id===c.id))?.check??c;
          const action=reviewAction(c,editor?.proposals[c.id]),decision=editor?.decisions[owner.id];
          const related=workView?workItems.find(item=>item.check.id===c.id)?.members.length??1:1;
          const liveTask=c.regulatory?.outcome==='not_reviewed'?c2CheckTask(c,report):undefined;
          const actionLabel=(!decision&&c.regulatory?.obligation==='recommended'?'可選改善 · ':'')+(decision?decision.status==="accepted"?"已接受修改":"已忽略":action?REVIEW_ACTION_LABELS[action]:liveTask?C2_TASK_LABELS[c2TaskState(liveTask)]:c.regulatory?C2_OUTCOME_LABELS[c.regulatory.outcome]:LABELS[cardState])+(related>1?` · 合併${related}筆檢查`:"");
          const unitsDiffer=c.category==="restatement" && ["difference","needs_confirmation"].includes(cardState) && current?.unit && previous?.unit && current.unit!==previous.unit;
          return <div className={`consistency-check-item${check?.id===c.id?" consistency-check-item--active":""}`} key={c.id}><button title={c.reader_copy?.title??c.title} data-action={action??undefined} aria-pressed={check?.id===c.id} className={`consistency-check ${cardState}${check?.id===c.id?" selected":""}`} onClick={()=>{selectCheck(c);}}><strong>{c.reader_copy?.title??c.title}</strong><small className={unitsDiffer?"consistency-check-unit-label":undefined}>{unitsDiffer?`${actionLabel} · 單位不同`:actionLabel}</small>{unitsDiffer&&<span className="consistency-check-units"><span>今年報告：{current.unit_label??current.unit}</span><span>去年報告：{previous.unit_label??previous.unit}</span></span>}{!unitsDiffer&&<span className="consistency-check-preview">{c.reader_copy?.problem??c.reason}</span>}</button>{check?.id===c.id&&<><button className="consistency-open-issue" onClick={()=>setIssueOpen(true)}>詳細／建議</button>{!issueOpen&&(action||decision)&&<div className="consistency-card-suggestion"><ConsistencyEditCard key={c.id} compact report={report} check={editCheck!} editor={editor} request={props.request} onChange={setEditor} onDecided={operation=>advanceAfterDecision(c.id,operation)}/></div>}{(action||decision)&&<ConsistencyFollowupCard check={c} followups={followups}/>}</>}</div>;
        })}{!visible.length&&<p>{report.compliance?.status==="running"?"正在初核／覆核，完成的結果會自動加入。可先開啟「檢查總覽」查看正在檢查的項目。":"此分類沒有項目。"}</p>}</div>
      </section>
      <section className="consistency-evidence" aria-label="報告原文核對">
        {check&&<>
        <div className="consistency-paper-area">
        {report.compliance&&check.refs.length>1&&<div className="c2-evidence-selector"><label htmlFor="c2-evidence-ref">報告證據</label><select id="c2-evidence-ref" aria-label="C2引用原文" value={references[0]} onChange={e=>selectReference(Number(e.target.value))}>{check.refs.map((r,i)=><option key={i} value={i}>{report.documents.find(d=>d.slot===r.slot)?.label} · p.{r.page} · {r.quote.replace(/\s+/g," ").slice(0,65)}</option>)}</select></div>}
        <div className="consistency-papers">{check.refs.length?<ConsistencyPaper key={checkKey+"left"+references[0]+":"+navigation.version} report={report} request={props.request} revision={editor?.revision??0} checkId={check.id} highlight={state!=="not_checked"&&state!=="candidate"} initial={check.refs[references[0]]??check.refs[0]}/>:<ConsistencyPaper report={report} request={props.request} checkId="" highlight={false} initial={{slot:fallbackSlot,page:1,quote:""}}/>}{!report.compliance&&check.refs.length>1?<ConsistencyPaper key={checkKey+"right"+references[1]+":"+navigation.version} report={report} request={props.request} revision={editor?.revision??0} checkId={check.id} highlight={state!=="not_checked"&&state!=="candidate"} initial={check.refs[references[1]]??check.refs[0]}/>:null}</div></div></>}
        {!check&&<div className="consistency-papers"><ConsistencyPaper report={report} request={props.request} checkId="" highlight={false} initial={{slot:fallbackSlot,page:1,quote:""}}/></div>}
      </section>
    </div>
    {check&&issueOpen&&<IssueDialog title={check.reader_copy?.title??check.title} onClose={()=>setIssueOpen(false)}><div className={`consistency-reason ${state}`}>{check.regulatory?<C2FindingDetails report={report} check={check} editor={editor} request={props.request} onChange={value=>{setEditor(value);if(value.decisions[check.id])setIssueOpen(false);}} onDecided={operation=>advanceAfterDecision(check.id,operation)} onSelectRef={index=>{selectReference(index);setIssueOpen(false);}}/>:<>{sourcePair&&<ConsistencySourceComparison pair={sourcePair} onSelectRef={index=>{selectReference(index);setIssueOpen(false);}}/>}<p>{check.reader_copy?.problem??check.reason}</p>{!sourcePair&&<div className="consistency-values">{check.refs.map((r,i)=><button key={i} aria-pressed={references.includes(i)} title="查看引用原頁" onClick={()=>{selectReference(i);setIssueOpen(false);}}>{report.documents.find(d=>d.slot===r.slot)?.label} p.{r.page}{r.value!==undefined?`：${r.value} ${r.unit_label??r.unit??""}`:""}</button>)}</div>}{check.left_only&&<details><summary>同頁碼的數字差別</summary><p>左側獨有：{check.left_only.join('、')||'無'}</p><p>右側獨有：{check.right_only?.join('、')||'無'}</p></details>}
        {(state==="difference"||state==="needs_confirmation")&&<ConsistencyEditCard report={report} check={editCheck!} editor={editor} request={props.request} onChange={value=>{setEditor(value);if(value.decisions[editCheck!.id])setIssueOpen(false);}} onDecided={operation=>advanceAfterDecision(check.id,operation)}/>}
        {check.reader_copy&&<details className="consistency-followup"><summary>完整核對說明</summary><p>{check.reason}</p></details>}</>}
        {props.onAsk&&(check.regulatory||state!=="not_checked"&&state!=="candidate")&&<details className="consistency-followup"><summary>追問 Cuby</summary><div className="consistency-ask"><input aria-label="追問此項" maxLength={600} placeholder="輸入你想確認的內容" value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&!asking&&!props.askBlockedReason){e.preventDefault();void ask();}}}/><button disabled={asking||!!props.askBlockedReason} title={props.askBlockedReason} onClick={()=>void ask()}>{asking?"送出中…":props.askQueued?"加入待答":"送出"}</button><small role="status">{props.askBlockedReason||askStatus||(props.askQueued?'Cuby 正處理上一則訊息；追問會排入此對話。':'')}</small>{props.askBlockedReason?.includes('模型')&&(props.askRecovery?<button className="consistency-recover-model" onClick={props.askRecovery.onClick}>{props.askRecovery.label}</button>:props.onShowChat&&<button className="consistency-recover-model" onClick={()=>{setIssueOpen(false);props.onShowChat?.();}}>前往選擇模型</button>)}</div></details>}</div></IssueDialog>}
    <p className="consistency-footer">黃色標示引用位置。左右報告可各自捲動；「整頁」可查看完整一頁。</p>
    {overviewOpen&&<IssueDialog title="檢查總覽" side closeLabel="關閉檢查總覽" onClose={()=>setOverviewOpen(false)}><ConsistencyOverview report={report} editor={editor} onSelect={next=>{
      setFilter(consistencyCheckState(next)==="candidate"?"page_numbers":report.compliance?"c2-all":"all");setQuery("");setC2Part("all");setReading(false);selectCheck(next);setOverviewOpen(false);setIssueOpen(true);
    }}/></IssueDialog>}
  </div></ConsistencyEditDraftProvider>;
}
function ConsistencyPaper(props:{report:ConsistencyReport;request:Request;revision?:number;checkId:string;highlight:boolean;initial?:ConsistencyReport['checks'][number]['refs'][number]}) {
  const [slot,setSlot]=useState<ConsistencySourceSlot>(props.initial?.slot??"esg_zh"),[page,setPage]=useState(props.initial?.page??1);
  const [image,setImage]=useState(""),[error,setError]=useState("");
  const [highlightInfo,setHighlightInfo]=useState<{status:string;quotes:string[]}|null>(null);
  const [draft,setDraft]=useState(false),[draftImage,setDraftImage]=useState(""),[draftError,setDraftError]=useState(""),[layoutNotice,setLayoutNotice]=useState("");
  const [zoom,setZoom]=useState(100),[fitMode,setFitMode]=useState<"width"|"page"|"manual">("width");
  const scrollRef=useRef<HTMLDivElement>(null),imageRef=useRef<HTMLImageElement>(null);
  const fitPage=useCallback(()=>{
    const scroller=scrollRef.current,img=imageRef.current;
    if(!scroller||!img?.naturalWidth||!img.naturalHeight)return;
    const width=scroller.clientWidth-16,height=scroller.clientHeight-16;
    if(width<=0||height<=0)return;
    setZoom(Math.max(1,Math.floor(Math.min(1,height*img.naturalWidth/(img.naturalHeight*width))*100)));
  },[]);
  useEffect(()=>{
    if(fitMode!=="page")return;
    fitPage();
    if(typeof ResizeObserver==="undefined"||!scrollRef.current)return;
    const observer=new ResizeObserver(fitPage);observer.observe(scrollRef.current);
    return()=>observer.disconnect();
  },[fitMode,fitPage]);
  function changeZoom(next:number){setFitMode("manual");setZoom(Math.max(10,Math.min(250,next)));}
  const doc=props.report.documents.find(d=>d.slot===slot)!;
  useEffect(()=>{let active=true;if(draft&&!slot.startsWith("prior_")){setDraftImage("");setDraftError("");setLayoutNotice("");void props.request({action:"consistency-draft-page",run_id:props.report.run_id,slot:slot as ConsistencySlot,page}).then(v=>{if(active){const result=v as {data_url:string;layout_notice:string};setDraftImage(result.data_url);setLayoutNotice(result.layout_notice);}}).catch(e=>{if(active)setDraftError(e instanceof Error?e.message:"未能產生修訂PDF。");});}return()=>{active=false;};},[draft,slot,page,props.revision,props.report.run_id]);
  useEffect(()=>{let active=true;setImage("");setError("");setHighlightInfo(null);void props.request({action:"consistency-page",run_id:props.report.run_id,slot,page,...(props.highlight?{check_id:props.checkId}:{})}).then((v)=>{if(active){const result=v as {data_url:string;highlight_status?:string;unlocated_quotes?:string[]};setImage(result.data_url);if(result.highlight_status==="partial"||result.highlight_status==="unlocated")setHighlightInfo({status:result.highlight_status,quotes:result.unlocated_quotes??[]});}}).catch(e=>{if(active)setError(e instanceof Error?e.message:"未能載入原頁");});return()=>{active=false;};},[props.report.run_id,slot,page,props.checkId,props.highlight]);
  return <div className="consistency-paper-pane">
    <div className="consistency-paper-header">
    <div className="consistency-paper-controls">
      <select aria-label="引用文件" value={slot} onChange={e=>{setSlot(e.target.value as ConsistencySourceSlot);setPage(1);}}>{props.report.documents.map(d=><option key={d.slot} value={d.slot}>{d.label}</option>)}</select>
      <button aria-label="引用上一頁" disabled={page<=1} onClick={()=>setPage(page-1)}>‹</button>
      <input aria-label="引用 PDF 頁碼" type="number" min={1} max={doc.page_count} value={page} onChange={e=>{const n=+e.target.value;if(Number.isInteger(n)&&n>=1&&n<=doc.page_count)setPage(n);}}/>
      <span>/{doc.page_count}</span><button aria-label="引用下一頁" disabled={page>=doc.page_count} onClick={()=>setPage(page+1)}>›</button>
    </div>
    <div className="consistency-paper-tools">
      <button disabled={slot.startsWith("prior_")} onClick={()=>setDraft(!draft)}>{draft?"查看原PDF":"修訂PDF預覽"}</button>
      <div><button aria-label="整頁顯示報告" aria-pressed={fitMode==="page"} onClick={()=>{setFitMode("page");fitPage();}}>整頁</button><button aria-label="報告適合寬度" aria-pressed={fitMode==="width"} onClick={()=>{setFitMode("width");setZoom(100);}}>頁寬</button><button aria-label="縮小報告" disabled={zoom<=10} onClick={()=>changeZoom(zoom-25)}>−</button><span>{zoom}%</span><button aria-label="放大報告" disabled={zoom>=250} onClick={()=>changeZoom(zoom+25)}>＋</button></div>
    </div>
    </div>
    {draft&&layoutNotice&&<small className="consistency-pdf-notice">{layoutNotice}</small>}
    {!draft&&highlightInfo&&<details className="consistency-highlight-notice"><summary>{highlightInfo.status==="partial"?"部分引用未能標示 · 查看原文":"引用未能標示 · 查看原文"}</summary>{highlightInfo.quotes.map((quote,i)=><blockquote key={i}>{quote}</blockquote>)}</details>}
    <div className="consistency-paper-scroll" ref={scrollRef} tabIndex={0} aria-label={`${doc.label} 報告捲動區`}>
      {draft&&!slot.startsWith("prior_")?draftImage?<img ref={imageRef} onLoad={()=>{if(fitMode==="page")fitPage();}} src={draftImage} style={{width:zoom+"%",maxWidth:"none"}} alt={doc.label+" 修訂PDF "+page}/>:<p role={draftError?"alert":"status"}>{draftError||"正在套用修改及核對版面…"}</p>:image?<img ref={imageRef} onLoad={()=>{if(fitMode==="page")fitPage();}} src={image} style={{width:`${zoom}%`,maxWidth:"none"}} alt={`${doc.label} PDF ${page}`}/>:<p role="status">{error||"載入原頁…"}</p>}
    </div>
  </div>;
}

function IssueDialog(props:{title:string;onClose:()=>void;children:React.ReactNode;side?:boolean;closeLabel?:string}) {
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>{previous?.isConnected&&previous.focus();};},[]);
  return <div className={`consistency-issue-backdrop${props.side?" consistency-overview-backdrop":""}`} onMouseDown={e=>{if(e.target===e.currentTarget)props.onClose();}}>
    <div ref={ref} className="consistency-issue-dialog" role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();props.onClose();}
      if(e.key==='Tab') {const items=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href]'));const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    }}><header><h3>{props.title}</h3><button aria-label={props.closeLabel??"關閉問題詳情"} onClick={props.onClose}>✕</button></header>{props.children}</div>
  </div>;
}
