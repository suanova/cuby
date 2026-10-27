import { useEffect, useState } from "react";
import { ConsistencyReportSchema, buildConsistencyQuestion, consistencyCheckState, type ConsistencyReport, type ConsistencySlot, type ConsistencySourceSlot, type ConsistencyComparison, type FinanceRequest } from "@memmy/local-api-contracts";
export { buildConsistencyQuestion } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";

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

const LABELS={matched:"已核對一致",difference:"發現差異",needs_confirmation:"待確認",not_checked:"未檢查",candidate:"頁面候選"};
function download(text:string,name:string,type:string) {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function SemanticProgress({review}:{review:NonNullable<ConsistencyReport['semantic']>}) {
  const labels:Record<ConsistencyComparison,string>={bilingual:"中英意思",cross_report:"ESG／年報",internal:"內文前後",restatement:"跨年說法"};
  const steps=[...review.tasks.map(t=>({label:labels[t.id],status:t.status})),{label:"覆核差異",status:["completed","partial"].includes(review.status)?"completed":review.phase?.includes("覆核")?"running":review.status==="failed"&&review.tasks.every(t=>t.status==="completed")?"failed":"pending"}];
  const states:Record<string,string>={completed:"已完成",running:"核對中",pending:"待進行",failed:"未完成"};
  return <div className={`consistency-semantic-progress ${review.status}`}>
    <progress aria-label="內文核對步驟進度" aria-valuetext={`已完成 ${review.completed_tasks}/${review.total_tasks} 步`} value={Math.min(review.completed_tasks,review.total_tasks)} max={review.total_tasks} title="按已完成步驟更新；每步所需時間不同。"/>
    <ol aria-label="內文核對步驟">{steps.map((step,i)=><li key={i} className={step.status} aria-label={`${step.label}：${states[step.status]}`}><span aria-hidden="true">{step.status==="completed"?"✓":step.status==="failed"?"!":"●"}</span>{step.label}{step.status==="running"&&<small>核對中</small>}</li>)}</ol>
  </div>;
}
export function ConsistencyReader(props:{report:ConsistencyReport;request:Request;onAsk?:(prompt:string)=>Promise<void>;busy?:boolean}) {
  const [report,setReport]=useState(props.report);
  useEffect(()=>{setReport(props.report);},[props.report]);
  const [semanticBusy,setSemanticBusy]=useState(false),[semanticError,setSemanticError]=useState("");
  async function startSemantic() {
    setSemanticBusy(true);setSemanticError("");
    try {setReport(ConsistencyReportSchema.parse(await props.request({action:"consistency-semantic-start",run_id:report.run_id})));}
    catch(e){setSemanticError(e instanceof Error?e.message:"內容核對未能開始。");}finally{setSemanticBusy(false);}
  }
  useEffect(()=>{
    if(report.semantic && report.semantic.status!=="running")return;
    let active=true,inFlight=false;
    const timer=setInterval(()=>{if(inFlight)return;inFlight=true;void props.request({action:"consistency-read",run_id:report.run_id}).then(value=>{if(active){setReport(ConsistencyReportSchema.parse(value));setSemanticError("");}}).catch(()=>{if(active)setSemanticError("暫時未能更新進度，正在重試。");}).finally(()=>{inFlight=false;});},5000);
    return()=>{active=false;clearInterval(timer);};
  },[report.run_id,report.semantic?.status,props.request]);
  const [selected,setSelected]=useState(()=>report.checks.find(c=>c.status==="difference")?.id??report.checks[0]?.id??"");
  const [filter,setFilter]=useState("issues"),[query,setQuery]=useState("");
  const [references,setReferences]=useState<[number,number]>([0,1]);
  const visible=report.checks.filter(c=>{
    const state=consistencyCheckState(c);
    return (filter==="all" || (filter==="semantic"?!!c.semantic_kind:filter==="issues"?["difference","needs_confirmation"].includes(state):["difference","needs_confirmation","not_checked","matched"].includes(filter)?state===filter:c.category===filter)) && (c.title+c.reason).includes(query);
  });
  const check=visible.find(c=>c.id===selected)??visible[0];
  const state=check?consistencyCheckState(check):undefined;
  const unresolved=report.checks.filter(c=>consistencyCheckState(c)==="needs_confirmation").length;
  const unchecked=report.checks.filter(c=>consistencyCheckState(c)==="not_checked").length;
  useEffect(()=>{setReferences([0,1]);},[check?.id]);
  const [details,setDetails]=useState(false);
  const [question,setQuestion]=useState(""),[asking,setAsking]=useState(false),[askStatus,setAskStatus]=useState("");
  async function ask() {
    if(!check||!props.onAsk)return;setAsking(true);setAskStatus("");
    try {await props.onAsk(buildConsistencyQuestion(report.run_id,check.id,question));setQuestion("");setAskStatus("已送到對話。");}
    catch(e){setAskStatus(e instanceof Error?e.message:"未能送出追問。");}finally{setAsking(false);}
  }
  function csv() {
    const cell=(s:unknown)=>'"'+String(s??"").replaceAll('"','""')+'"';
    download('\uFEFF'+[["項目","分類","結果","原因","原文與頁碼"],...report.checks.map(c=>[c.title,c.category,LABELS[consistencyCheckState(c)],c.reason,JSON.stringify(c.refs)])].map(row=>row.map(cell).join(',')).join('\r\n'),`consistency-${report.fiscal_year.replace('/','-')}.csv`,"text/csv;charset=utf-8");
  }
  return <div className="consistency-reader">
    <div className="consistency-summary"><strong>四份報告一致性 · FY{report.fiscal_year}</strong>
      <span>{report.coverage.scanned_pages}頁已掃描 · {report.coverage.metric_checks}組指標核對</span>
      <button onClick={csv}>匯出表格</button><button onClick={()=>download(JSON.stringify(report,null,2),"consistency-review.json","application/json")}>核對記錄</button>
    </div>
    <div className="consistency-counts"><button className="difference" onClick={()=>setFilter("difference")}>差異 {report.checks.filter(c=>consistencyCheckState(c)==="difference").length}</button><button onClick={()=>setFilter("needs_confirmation")}>待確認 {unresolved}</button><button className="not-checked" onClick={()=>setFilter("not_checked")}>未檢查 {unchecked}</button><span>數值一致 {report.checks.filter(c=>c.category==="metric"&&c.status==="matched").length}</span><button onClick={()=>setDetails(!details)} aria-expanded={details}>覆蓋範圍</button></div>
    <div className="consistency-history-status">歷史基準：{report.history.source} · FY{report.history.fiscal_year} · {report.history.status==="ready"?`已核實（${report.coverage.historical_pages}頁）`:report.history.status==="not_requested"?"本次未選跨年核對":"未能取得，跨年仍未核對"} · 內部 {report.coverage.internal_checks}項 · 跨年 {report.coverage.restatement_checks}項</div>
    <div className="consistency-semantic-status" role="status">
      <strong>{!report.semantic?"內文意思尚未核對":report.semantic.status==="running"?`正在核對內文 · ${report.semantic.completed_tasks}/${report.semantic.total_tasks}步${report.semantic.phase?` · ${report.semantic.phase}`:""}`:report.semantic.status==="completed"?`內文核對完成 · ${report.semantic.findings_count}項需處理 · ${report.semantic.matched_count}項一致`:report.semantic.status==="partial"?`內文核對部分完成 · ${report.semantic.findings_count}項需處理`:"內文核對中斷，已完成結果保留"}</strong>
      {(!report.semantic||["failed","partial"].includes(report.semantic.status))&&<button disabled={semanticBusy} onClick={()=>void startSemantic()}>{semanticBusy?"啟動中…":report.semantic?"重新核對內文":"核對內文"}</button>}
      {!!report.semantic?.matched_count&&<button onClick={()=>setFilter("semantic")}>查看內容核對</button>}
      {semanticError&&<span className="finance-error">{semanticError}</span>}
      {report.semantic?.error&&<span className="finance-error">{report.semantic.error}</span>}
      {report.semantic&&<SemanticProgress review={report.semantic}/>}
    </div>
    {details&&<div className="finance-scope"><p>已掃描全文 ≠ 全部數字及口徑已確認。</p><ul>{report.limits.map(t=><li key={t}>{t}</li>)}</ul>{report.semantic&&<><p>內文模型：{report.semantic.model} · {report.semantic.reasoning_effort}。各項一致只指所列主題。</p>{report.semantic.tasks.map(t=><p key={t.id}>{t.label}：{t.status==="completed"?"已核對":t.status==="running"?"核對中":"未完成"} · 提交{t.submitted_pages}頁原文{t.error?` · ${t.error}`:""}</p>)}<ul>{report.semantic.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></>}<p>{report.coverage.page_pairs}組同頁序候選，其中{report.coverage.same_numeric_inventory_pages}組數字集合相同；均未代替語義配對。</p>{report.documents.map(d=><p key={d.slot}>{d.label} · {d.file_name} · {d.page_count}頁{!d.cover_year_found?" · 財年待核":""}{d.textless_pages.length?` · ${d.textless_pages.length}頁未取到文字`:""}</p>)}</div>}
    <div className="consistency-body">
      <section className="consistency-checks" aria-label="一致性核對項目">
        <input aria-label="搜尋一致性項目" placeholder="搜尋指標" value={query} onChange={e=>setQuery(e.target.value)}/>
        <select aria-label="一致性項目分類" value={filter} onChange={e=>setFilter(e.target.value)}><option value="issues">具體差異與待確認</option><option value="difference">具體差異</option><option value="needs_confirmation">待確認</option><option value="not_checked">未檢查</option><option value="semantic">內容核對結果</option><option value="metric">中英指標</option><option value="basis">方法與口徑</option><option value="cross_report">ESG ↔ 年報</option><option value="internal">報告內部</option><option value="restatement">跨年重述</option><option value="page_numbers">全文頁面候選</option><option value="all">全部</option></select>
        <div className="consistency-check-list">{visible.map(c=>{
          const cardState=consistencyCheckState(c);
          const [current,previous]=c.refs;
          const unitsDiffer=c.category==="restatement" && ["difference","needs_confirmation"].includes(cardState) && current?.unit && previous?.unit && current.unit!==previous.unit;
          return <button key={c.id} className={`consistency-check ${cardState}${check?.id===c.id?" selected":""}`} onClick={()=>{setSelected(c.id);setReferences([0,1]);setAskStatus("");}}><strong>{c.title}</strong><small className={unitsDiffer?"consistency-check-unit-label":undefined}>{unitsDiffer?`單位不同 · ${LABELS[cardState]}`:LABELS[cardState]}</small>{unitsDiffer&&<span className="consistency-check-units"><span>今年報告：{current.unit_label??current.unit}</span><span>去年報告：{previous.unit_label??previous.unit}</span></span>}</button>;
        })}{!visible.length&&<p>此分類沒有項目。</p>}</div>
      </section>
      <section className="consistency-evidence" aria-label="雙文件原文核對">
        {check&&<><div className={`consistency-reason ${state}`}><strong>{check.title}{state==="not_checked"?" · 未檢查":""}</strong><p>{check.reason}</p><div className="consistency-values">{check.refs.map((r,i)=><button key={i} aria-pressed={references.includes(i)} title="查看引用原頁" onClick={()=>setReferences(v=>i===0?[0,v[1]]:[v[0],i])}>{report.documents.find(d=>d.slot===r.slot)?.label} p.{r.page}{r.value!==undefined?`：${r.value} ${r.unit_label??r.unit??""}`:""}</button>)}</div>{check.left_only&&<details><summary>候選數字差異</summary><p>左側獨有：{check.left_only.join('、')||'無'}</p><p>右側獨有：{check.right_only?.join('、')||'無'}</p></details>}
        {props.onAsk&&state!=="not_checked"&&state!=="candidate"&&<div className="consistency-ask"><input aria-label="追問此項" maxLength={600} placeholder="追問此項，或直接請 Cuby 建議改法" value={question} onChange={e=>setQuestion(e.target.value)}/><button disabled={asking||props.busy} onClick={()=>void ask()}>{asking?"送出中…":"請 Cuby 建議"}</button><small role="status">{askStatus}</small></div>}</div>
        <div className="consistency-papers">{check.refs.length?<ConsistencyPaper key={check.id+"left"+references[0]} report={report} request={props.request} checkId={check.id} highlight={state!=="not_checked"&&state!=="candidate"} initial={check.refs[references[0]]??check.refs[0]}/>:<p className="finance-empty">尚未取得可比較的原文。</p>}{check.refs.length>1?<ConsistencyPaper key={check.id+"right"+references[1]} report={report} request={props.request} checkId={check.id} highlight={state!=="not_checked"&&state!=="candidate"} initial={check.refs[references[1]]??check.refs[0]}/>:check.refs.length===1?<p className="finance-empty">另一份文件未取得可對應依據。</p>:null}</div></>}
      </section>
    </div>
    <p className="consistency-footer">黃色標示引用位置。</p>
  </div>;
}
function ConsistencyPaper(props:{report:ConsistencyReport;request:Request;checkId:string;highlight:boolean;initial?:ConsistencyReport['checks'][number]['refs'][number]}) {
  const [slot,setSlot]=useState<ConsistencySourceSlot>(props.initial?.slot??"esg_zh"),[page,setPage]=useState(props.initial?.page??1);
  const [image,setImage]=useState(""),[error,setError]=useState("");
  const doc=props.report.documents.find(d=>d.slot===slot)!;
  useEffect(()=>{let active=true;setImage("");setError("");void props.request({action:"consistency-page",run_id:props.report.run_id,slot,page,...(props.highlight?{check_id:props.checkId}:{})}).then((v)=>{if(active)setImage((v as {data_url:string}).data_url);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"未能載入原頁");});return()=>{active=false;};},[props.report.run_id,slot,page,props.checkId,props.highlight]);
  return <div className="consistency-paper-pane"><div className="consistency-paper-controls"><select aria-label="引用文件" value={slot} onChange={e=>{setSlot(e.target.value as ConsistencySourceSlot);setPage(1);}}>{props.report.documents.map(d=><option key={d.slot} value={d.slot}>{d.label}</option>)}</select><button aria-label="引用上一頁" disabled={page<=1} onClick={()=>setPage(page-1)}>‹</button><input aria-label="引用 PDF 頁碼" type="number" min={1} max={doc.page_count} value={page} onChange={e=>{const n=+e.target.value;if(Number.isInteger(n)&&n>=1&&n<=doc.page_count)setPage(n);}}/><span>/{doc.page_count}</span><button aria-label="引用下一頁" disabled={page>=doc.page_count} onClick={()=>setPage(page+1)}>›</button></div><div className="consistency-paper-scroll">{image?<img src={image} alt={`${doc.label} PDF ${page}`}/>:<p role="status">{error||"載入原頁…"}</p>}</div></div>;
}
