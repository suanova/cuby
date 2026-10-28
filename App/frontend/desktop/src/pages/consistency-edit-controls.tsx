import { useEffect, useState } from "react";
import { ConsistencyEditorSchema, ConsistencyExportSchema, type ConsistencyEditor, type ConsistencyReport, type ConsistencySlot, type FinanceRequest } from "@memmy/local-api-contracts";
type Request=(input:FinanceRequest)=>Promise<unknown>;
function InlineChange({before,after}:{before:string;after:string}) {
  const a=before.replace(/\s+/g," "),b=after.replace(/\s+/g," ");let start=0,end=0;
  while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const prefix=a.slice(Math.max(0,start-70),start),suffix=a.slice(a.length-end,a.length-end+70);
  return <div className="consistency-inline-diff">{start>70?"…":""}{prefix}<del>{a.slice(start,a.length-end)}</del><ins>{b.slice(start,b.length-end)}</ins>{suffix}{end>70?"…":""}</div>;
}
export function useConsistencyEditor(run:string,request:Request) {
  const [editor,setEditor]=useState<ConsistencyEditor|null>(null),[error,setError]=useState("");
  async function refresh(){try{setEditor(ConsistencyEditorSchema.parse(await request({action:"consistency-editor",run_id:run})));setError("");}catch(e){setError(e instanceof Error?e.message:"修訂紀錄未能載入。");}}
  useEffect(()=>{void refresh();},[run]);
  const generating=Object.values(editor?.proposals??{}).some(p=>p.status==="generating");
  useEffect(()=>{if(!generating)return;const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[generating,run]);
  return {editor,setEditor,error,refresh};
}
export function ConsistencyEditCard(props:{report:ConsistencyReport;check:ConsistencyReport['checks'][number];editor:ConsistencyEditor|null;request:Request;onChange:(value:ConsistencyEditor)=>void}) {
  const {report,check,editor}=props;
  const proposal=editor?.proposals[check.id],decision=editor?.decisions[check.id];
  const [replacements,setReplacements]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{setReplacements(proposal?.edits?.map(e=>e.replacement)??[]);setConfirmed(false);setError("");},[check.id,proposal?.id,proposal?.status]);
  async function act(operation:"accept"|"dismiss"|"undo"|"suggest") {
    if(!editor)return;setBusy(true);setError("");
    try {
      const result=operation==="suggest"?await props.request({action:"consistency-suggest",run_id:report.run_id,check_id:check.id}):await props.request({action:"consistency-decide",run_id:report.run_id,check_id:check.id,expected_revision:editor.revision,operation,
        ...(operation==="accept"?{proposal_id:proposal?.id,facts_confirmed:confirmed,edits:proposal?.edits?.map((e,i)=>({...e,replacement:replacements[i]??e.replacement}))}:{})});
      props.onChange(ConsistencyEditorSchema.parse(result));
    }catch(e){setError(e instanceof Error?e.message:"未能儲存修改。");try{props.onChange(ConsistencyEditorSchema.parse(await props.request({action:"consistency-editor",run_id:report.run_id})));}catch{/* Keep last verified state. */}}
    finally{setBusy(false);}
  }
  return <section className="consistency-edit-card" aria-label="建議修改">
    {decision?<div className="consistency-edit-actions"><strong>{decision.status==="accepted"?"✓ 已加入修訂稿":"已忽略"}</strong><button disabled={busy} onClick={()=>void act("undo")}>撤回</button></div>:<>
      {proposal?.status==="generating"?<p role="status">正在產生建議寫法…</p>:proposal?.status==="ready"?<>
        <p>{proposal.summary}</p>{proposal.edits?.map((edit,i)=><div className="consistency-edit-diff" key={i}><small>{report.documents.find(d=>d.slot===edit.slot)?.label} · p.{edit.page}</small><InlineChange before={edit.original} after={replacements[i]??edit.replacement}/><details><summary>調整寫法</summary><textarea aria-label={`建議寫法 ${i+1}`} value={replacements[i]??edit.replacement} maxLength={3000} rows={3} onChange={e=>setReplacements(v=>v.map((s,n)=>n===i?e.target.value:s))}/></details></div>)}
        {proposal.requires_confirmation&&<><p className="consistency-confirmation-question">{proposal.confirmation_prompt}</p><label className="consistency-fact-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核實以上改寫涉及的事實，同意採用</label></>}
      </>:proposal?.status==="failed"?<p role="alert">{proposal.error}</p>:null}
      <div className="consistency-edit-actions">{proposal?.status==="ready"&&proposal.edits?.length?<button className="finance-primary" disabled={busy||proposal.requires_confirmation&&!confirmed} onClick={()=>void act("accept")}>接受修改</button>:<button className="finance-primary" disabled={busy||!editor||proposal?.status==="generating"} onClick={()=>void act("suggest")}>{proposal?.status==="failed"?"重試建議":"建議改寫"}</button>}<button disabled={busy||!editor} onClick={()=>void act("dismiss")}>忽略</button><small>接受後加入修訂稿</small></div>
    </>}{error&&<p role="alert" className="finance-error">{error}</p>}
  </section>;
}
export function ConsistencyDraftExport(props:{report:ConsistencyReport;editor:ConsistencyEditor|null;request:Request}) {
  const [slot,setSlot]=useState("all"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function exportDraft() {
    setBusy(true);setError("");
    try {
      const result=ConsistencyExportSchema.parse(await props.request({action:"consistency-draft-export",run_id:props.report.run_id,...(slot!=="all"?{slot:slot as ConsistencySlot}:{})}));
      const bytes=Uint8Array.from(atob(result.data_base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:result.mime}));
      const link=document.createElement("a");link.href=url;link.download=result.file_name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){setError(e instanceof Error?e.message:"匯出未完成。");}finally{setBusy(false);}
  }
  const accepted=Object.values(props.editor?.decisions??{}).filter(d=>d.status==="accepted").length;
  return <details className="consistency-export-menu"><summary>修訂稿 · 已接受{accepted}項 · 匯出</summary><div className="consistency-draft-export"><select aria-label="匯出修訂文件" value={slot} onChange={e=>setSlot(e.target.value)}><option value="all">全部四份 Word＋修改記錄</option>{props.report.documents.filter(d=>!d.slot.startsWith("prior_")).map(d=><option key={d.slot} value={d.slot}>{d.label} · Word</option>)}</select><button disabled={busy||!props.editor} onClick={()=>void exportDraft()}>{busy?"匯出中…":"匯出修訂稿"}</button><small>PDF文字重建，版面須另排。</small>{error&&<span role="alert">{error}</span>}</div></details>;
}
