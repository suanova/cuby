import { useState } from "react";
import { FinanceProjectBuildSchema, type ConsistencyReport, type ConsistencySlot, type FinanceProject, type FinanceRequest } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";

const LABELS: Record<ConsistencySlot,string> = {esg_zh:"ESG · 中文",esg_en:"ESG · English",annual_zh:"年報 · 中文",annual_en:"年報 · English"};
export function FinanceHistorySupplement(props:{client:MemmyAgentClient;project:FinanceProject;report:ConsistencyReport;request:(input:FinanceRequest)=>Promise<unknown>;onComplete:(report:ConsistencyReport,project:FinanceProject,resume:boolean)=>Promise<void>;onClose:()=>void}) {
  const [uploads,setUploads]=useState<{file:File;slot:ConsistencySlot|""}[]>([]),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const year=props.report.history.fiscal_year;
  const slots=props.report.documents.filter(d=>!d.slot.startsWith('prior_')&&!props.report.documents.some(p=>p.slot==='prior_'+d.slot)).map(d=>d.slot as ConsistencySlot);
  const valid=confirmed&&uploads.length>0&&uploads.length<=4&&uploads.every(u=>u.slot&&u.file.size<=30*1024*1024)&&new Set(uploads.map(u=>u.slot)).size===uploads.length;
  async function save(resume:boolean) {
    setBusy(true);setError("");
    try {
      if(!valid)throw Error("請選擇文件種類及語言，並確認項目與年份。");
      const media=await props.client.uploadAgentMedia(uploads.map(u=>({blob:u.file,name:u.file.name,mime:'application/pdf',kind:'file'})));
      if(media.length!==uploads.length||media.some(m=>m.kind!=='file'||m.mime!=='application/pdf'))throw Error('上載未完成，請重試。');
      const result=FinanceProjectBuildSchema.parse(await props.request({action:'project-supplement',project_id:props.project.id,run_id:props.report.run_id,confirmed:true,
        documents:uploads.map((u,i)=>({slot:u.slot as ConsistencySlot,path:media[i]!.path,file_name:u.file.name}))}));
      await props.onComplete(result.report,result.project,resume);
    }catch(e){setError(e instanceof Error?e.message:'未能補交文件。');}finally{setBusy(false);}
  }
  return <div className="finance-history-backdrop" onMouseDown={e=>{if(!busy&&e.target===e.currentTarget)props.onClose();}}>
    <section className="finance-history-dialog" role="dialog" aria-modal="true" aria-label="補上去年報告" onKeyDown={e=>{
      if(e.key==='Escape'){e.stopPropagation();if(!busy)props.onClose();}
      if(e.key==='Tab'){const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)'));if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus();}}
    }}><header><h3>補上 FY{year} 報告</h3><button autoFocus aria-label="關閉補交文件" disabled={busy} onClick={props.onClose}>✕</button></header>
      <div className="finance-history-form"><p>補交同一公司的去年原件，繼續這份審閱。已完成結果、接受修改及忽略紀錄保留。</p>
      <label className="finance-file-picker">選擇去年 PDF（可多選）<input type="file" multiple accept="application/pdf,.pdf" aria-label="補交去年報告 PDF" disabled={busy} onChange={e=>{const files=Array.from(e.target.files??[]);setUploads(v=>[...v,...files.map(file=>({file,slot:slots.length===1?slots[0]!:'' as const}))]);setConfirmed(false);e.target.value='';}}/></label>
      {uploads.map((u,i)=><div className="finance-upload-row" key={i}><span title={u.file.name}>{u.file.name}</span><select aria-label={`去年文件${i+1}種類及語言`} disabled={busy} value={u.slot} onChange={e=>{setUploads(v=>v.map((f,n)=>n===i?{...f,slot:e.target.value as ConsistencySlot}:f));setConfirmed(false);}}><option value="">選擇種類及語言</option>{slots.map(s=><option key={s} value={s}>{LABELS[s]}</option>)}</select><button aria-label={`移除去年文件${i+1}`} disabled={busy} onClick={()=>setUploads(v=>v.filter((_,n)=>n!==i))}>移除</button></div>)}
      {uploads.length>4&&<p role="alert">最多四份；請移除多餘文件。</p>}
      {uploads.some(u=>u.file.size>30*1024*1024)&&<p role="alert">每份 PDF 上限30 MB。</p>}
      {!!uploads.length&&<label className="finance-history-confirm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我確認以上文件屬於「{props.project.title}」的 FY{year} 報告。</label>}
      <small>可以先補部分文件；未補齊的種類／語言會繼續標示欠件。只保存於本項目，不會寫入共享知識庫。</small>
      {error&&<p className="finance-error" role="alert">{error}</p>}
      </div><footer><button className="finance-primary" disabled={busy||!valid} onClick={()=>void save(true)}>{busy?'正在保存…':'補交並繼續核對'}</button><button disabled={busy||!valid} onClick={()=>void save(false)}>只儲存文件</button></footer>
    </section>
  </div>;
}
