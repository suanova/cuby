import { useEffect, useState } from "react";
import { FinanceProjectSchema, FinanceProjectListSchema, FinanceProjectBuildSchema, ConsistencyReportSchema, type FinanceProject, type ConsistencyReport, type ConsistencySlot, type ConsistencyComparison, type FinanceRequest } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";

const SLOTS:[ConsistencySlot,string][]=[["esg_zh","ESG 中文"],["esg_en","ESG English"],["annual_zh","年報 中文"],["annual_en","年報 English"]];
const COMPARISONS:[ConsistencyComparison,string][]=[["bilingual","中英文"],["cross_report","ESG／年報"],["internal","內文前後"],["restatement","跨年重述"]];
type Request=(input:FinanceRequest)=>Promise<unknown>;
export function FinanceProjectSetup(props:{client:MemmyAgentClient;request:Request;context?:{id:string;name:string}|null;onComplete:(report:ConsistencyReport,project:FinanceProject)=>void|Promise<void>}) {
  const [projects,setProjects]=useState<FinanceProject[]>([]),[id,setId]=useState("");
  const [title,setTitle]=useState(props.context?.name??"億都報告"),[year,setYear]=useState("2025/26");
  const [files,setFiles]=useState<Partial<Record<ConsistencySlot,File>>>({});
  const [source,setSource]=useState("upload"),[versionId,setVersionId]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [comparisons,setComparisons]=useState<ConsistencyComparison[]>(COMPARISONS.map(([s])=>s));
  const project=projects.find(p=>p.id===id);
  const version=project?.versions.find(v=>v.id===versionId)??project?.versions.find(v=>v.id===project.active_version)??project?.versions.at(-1);
  const lastRun=version?.runs.at(-1);
  const previous=localStorage.getItem("financebuddy.consistency.lastRun");
  function remember(p:FinanceProject) {
    setProjects(v=>[p,...v.filter(x=>x.id!==p.id)]);setId(p.id);setVersionId(p.active_version??"");localStorage.setItem("financebuddy.project",p.id);
  }
  async function refresh() {
    const value=FinanceProjectListSchema.parse(await props.request({action:"project-list"}));setProjects(value.projects);
    const preferred=(props.context?value.projects.find(p=>p.external_id===props.context!.id):undefined)??value.projects.find(p=>p.id===localStorage.getItem("financebuddy.project"))??value.projects[0];
    if(preferred){setId(preferred.id);setVersionId(preferred.active_version??"");}
  }
  useEffect(()=>{void refresh().catch(e=>setError(String(e.message??e)));},[props.context?.id]);
  async function save() {
    setBusy(true);setError("");
    try {
      let target=project;
      if(!target)target=FinanceProjectSchema.parse(await props.request({action:"project-create",title,...(props.context?{external_id:props.context.id}:{})}));
      // Remember even an empty project if an upload is interrupted, so retry reuses it.
      remember(target);
      let documents:{slot:ConsistencySlot;path:string;file_name:string}[]|undefined;
      if(source==="upload") {
        if(!SLOTS.every(([s])=>files[s]))throw Error("請選四份 PDF。");
        if(SLOTS.some(([s])=>files[s]!.size>30*1024*1024))throw Error("每份 PDF 上限30 MB。");
        const uploaded=await props.client.uploadAgentMedia(SLOTS.map(([s])=>({blob:files[s]!,name:files[s]!.name,mime:"application/pdf",kind:"file"})));
        if(uploaded.length!==4||uploaded.some(f=>f.kind!=="file"||f.mime!=="application/pdf"))throw Error("上載未完成，請重試。");
        documents=SLOTS.map(([s],i)=>({slot:s,path:uploaded[i]!.path,file_name:files[s]!.name}));
      }
      remember(FinanceProjectSchema.parse(await props.request({action:"project-save",project_id:target.id,expected_revision:target.revision,fiscal_year:year,
        ...(source==="previous"&&previous?{run_id:previous}:documents?{documents}:{})})));
      setFiles({});
    }catch(e){setError(e instanceof Error?e.message:"未能儲存報告。");}finally{setBusy(false);}
  }
  async function run(previousRun=false) {
    if(!project||!version)return;setBusy(true);setError("");
    try {
      let report:ConsistencyReport;
      if(previousRun&&lastRun)report=ConsistencyReportSchema.parse(await props.request({action:"consistency-read",run_id:lastRun}));
      else {
        const result=FinanceProjectBuildSchema.parse(await props.request({action:"project-build",project_id:project.id,version_id:version.id,comparisons}));
        remember(result.project);report=result.report;
        try{report=ConsistencyReportSchema.parse(await props.request({action:"consistency-semantic-start",run_id:report.run_id}));}catch{/* Reader keeps numeric results and exposes retry. */}
      }
      await props.onComplete(report,project);
    }catch(e){setError(e instanceof Error?e.message:"未能開始核對。");}finally{setBusy(false);}
  }
  return <div className="finance-setup finance-project-setup">
    <div className="finance-project-heading"><h3>項目報告</h3><span>上載一次，各項工作沿用</span></div>
    <label>項目<select aria-label="報告項目" disabled={busy} value={id} onChange={e=>{setId(e.target.value);setVersionId("");if(e.target.value)localStorage.setItem("financebuddy.project",e.target.value);}}><option value="">＋ 新項目{props.context?` · ${props.context.name}`:""}</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
    {!project&&<label>名稱<input aria-label="新項目名稱" value={title} onChange={e=>setTitle(e.target.value)} maxLength={100}/></label>}
    {version&&<section className="finance-project-files"><label>報告版本<select aria-label="項目報告版本" value={version.id} disabled={busy} onChange={e=>setVersionId(e.target.value)}>{project!.versions.map((v,i)=><option key={v.id} value={v.id}>FY{v.fiscal_year} · 版本{i+1}</option>)}</select></label>
      {version.documents.map(d=><div key={d.slot}><strong>{SLOTS.find(([s])=>s===d.slot)?.[1]}</strong><span title={d.file_name}>{d.file_name}</span><small>{(d.bytes/1024/1024).toFixed(1)} MB</small></div>)}
      <fieldset className="consistency-comparison-choices"><legend>一致性核對</legend>{COMPARISONS.map(([s,label])=><label key={s}><input type="checkbox" disabled={busy} checked={comparisons.includes(s)} onChange={e=>setComparisons(v=>e.target.checked?[...v,s]:v.filter(x=>x!==s))}/>{label}</label>)}</fieldset>
      <div className="finance-project-actions"><button className="finance-primary" disabled={busy||!comparisons.length} onClick={()=>void run()}>{busy?"正在處理…":"開始核對"}</button>{lastRun&&<button disabled={busy} onClick={()=>void run(true)}>繼續上次審閱</button>}</div>
    </section>}
    <details open={!version} className="finance-project-upload"><summary>{version?"新增報告版本":"加入報告"}</summary>
      <label>來源<select aria-label="項目報告來源" value={source} onChange={e=>setSource(e.target.value)} disabled={busy}><option value="upload">上載 PDF</option>{previous&&<option value="previous">沿用上次核對的四份報告</option>}<option value="example">本機 FY2025/26 範例</option></select></label>
      <label>財年<input value={year} aria-label="項目財年" onChange={e=>setYear(e.target.value)} disabled={busy}/></label>
      {source==="upload"&&<div className="consistency-upload-grid">{SLOTS.map(([s,label])=><label key={s}>{label}<input type="file" accept="application/pdf,.pdf" aria-label={`保存 ${label}`} disabled={busy} onChange={e=>setFiles(v=>({...v,[s]:e.target.files?.[0]}))}/></label>)}</div>}
      <button disabled={busy||!title.trim()||!/^20\d{2}\/\d{2}$/.test(year)||source==="upload"&&!SLOTS.every(([s])=>files[s])} onClick={()=>void save()}>{busy?"儲存中…":"儲存至項目"}</button>
      <p className="finance-muted">文件及修訂保存在此電腦。新版本會另存，已完成的審閱仍可保留。</p>
    </details>
    {error&&<div className="finance-error" role="alert">{error}<button onClick={()=>void refresh().catch(()=>{})}>重新載入</button></div>}
  </div>;
}
