import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ConsistencyEditorSchema, ConsistencyExportSchema, type ConsistencyEditor, type ConsistencyReport, type ConsistencySlot, type FinanceRequest } from "@memmy/local-api-contracts";
import { reviewAction } from "./consistency-actions.js";
type Request=(input:FinanceRequest)=>Promise<unknown>;
function InlineChange({before,after}:{before:string;after:string}) {
  const a=before.replace(/\s+/g," "),b=after.replace(/\s+/g," ");let start=0,end=0;
  while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const prefix=a.slice(Math.max(0,start-70),start),suffix=a.slice(a.length-end,a.length-end+70);
  return <div className="consistency-inline-diff">{start>70?"…":""}{prefix}<del>{a.slice(start,a.length-end)}</del><ins>{b.slice(start,b.length-end)}</ins>{suffix}{end>70?"…":""}</div>;
}
export function useConsistencyEditor(run:string,request:Request,checkSignature="") {
  type Snapshot={run:string;editor:ConsistencyEditor|null;error:string};
  const [snapshot,setSnapshot]=useState<Snapshot>({run,editor:null,error:""});
  const owner=useMemo<{run:string;active:boolean;pending:Promise<void>|null}>(()=>({run,active:false,pending:null}),[run,checkSignature]);
  const activeOwner=useRef(owner),requestRef=useRef(request);
  useEffect(()=>{requestRef.current=request;});
  const setEditor=useCallback<Dispatch<SetStateAction<ConsistencyEditor|null>>>(update=>{
    const currentOwner=owner;
    if(!currentOwner.active||activeOwner.current!==currentOwner)return;
    setSnapshot(current=>{
      if(!currentOwner.active||activeOwner.current!==currentOwner)return current;
      const previous=current.run===run?current.editor:null;
      const next=typeof update==="function"?update(previous):update;
      if(next&&(next.run_id!==run||previous&&next.revision<previous.revision))return current;
      return {run,editor:next,error:""};
    });
  },[owner,run]);
  const refresh=useCallback(()=>{
    const currentOwner=owner;
    if(!currentOwner.active||activeOwner.current!==currentOwner)return Promise.resolve();
    if(currentOwner.pending)return currentOwner.pending;
    const ownsRequest=()=>currentOwner.active&&activeOwner.current===currentOwner;
    currentOwner.pending=Promise.resolve().then(async()=>{
      try{
        if(!ownsRequest())return;
        const result=await requestRef.current({action:"consistency-editor",run_id:run});
        if(!ownsRequest())return;
        const next=ConsistencyEditorSchema.parse(result);
        if(next.run_id!==run)throw new Error("修訂紀錄與目前報告不符。");
        setSnapshot(current=>{
          if(!ownsRequest())return current;
          const previous=current.run===run?current.editor:null;
          if(previous&&next.revision<previous.revision)return current;
          return {run,editor:next,error:""};
        });
      }catch(e){
        const message=e instanceof Error?e.message:"修訂紀錄未能載入。";
        if(ownsRequest())setSnapshot(current=>ownsRequest()?{...current,error:message}:current);
      }
    }).finally(()=>{currentOwner.pending=null;});
    return currentOwner.pending;
  },[owner,run]);
  useEffect(()=>{
    owner.active=true;activeOwner.current=owner;
    setSnapshot(current=>({run,editor:current.run===run?current.editor:null,error:""}));
    void refresh();
    return()=>{owner.active=false;};
  },[owner,refresh,run]);
  const editor=snapshot.run===run?snapshot.editor:null,error=snapshot.run===run?snapshot.error:"";
  const generating=editor?.preparation?editor.preparation.status==="running":Object.entries(editor?.proposals??{}).some(([id,p])=>!editor?.decisions[id]&&p.status==="generating");
  useEffect(()=>{if(!generating)return;const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[generating,owner,refresh]);
  return {editor,setEditor,error,refresh};
}
export function ConsistencySuggestionStatus(props:{editor:ConsistencyEditor|null;request:Request;onChange:(value:ConsistencyEditor)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const prep=props.editor?.preparation;
  if(!prep?.total)return null;
  async function retry(){if(!props.editor)return;setBusy(true);setError("");try{props.onChange(ConsistencyEditorSchema.parse(await props.request({action:"consistency-prepare",run_id:props.editor.run_id})));}catch(e){setError(e instanceof Error?e.message:"未能重試建議。");}finally{setBusy(false);}}
  return <div className="consistency-suggestion-status" aria-label="自動建議進度"><span role="status">{prep.status==="running"?`自動準備建議 · ${prep.ready}/${prep.total} 項已備妥`:prep.status==="partial"?`建議已備妥 ${prep.ready}/${prep.total} 項 · ${prep.failed} 項未完成`:`建議已備妥 · ${prep.ready} 項`}</span>{prep.status==="running"&&<small>可先查看已有建議</small>}{prep.failed>0&&<button disabled={busy||prep.status==="running"} onClick={()=>void retry()}>{busy?"正在重試…":"重試未完成建議"}</button>}{error&&<span role="alert">{error}</span>}</div>;
}
type EditDraft={replacements:string[];confirmed:boolean};
type EditDraftEntry={identity:string;sourceIdentity:string;value:EditDraft};
type EditDraftStore=Map<string,EditDraftEntry>;
const EditDraftContext=createContext<{drafts:EditDraftStore;setDrafts:Dispatch<SetStateAction<EditDraftStore>>}|null>(null);

function editDraftIdentity(report:ConsistencyReport,editor:ConsistencyEditor|null,checkId:string) {
  const history=editor?.history.slice().reverse().find(value=>typeof value==="object"&&value!==null&&"check_id" in value&&value.check_id===checkId);
  return JSON.stringify([report.run_id,report.fiscal_year,editor?.base_sha256,report.documents.map(doc=>[doc.slot,doc.sha256]),
    report.checks.find(check=>check.id===checkId),editor?.proposals[checkId],editor?.decisions[checkId],history]);
}

export function ConsistencyEditDraftProvider(props:{report:ConsistencyReport;editor:ConsistencyEditor|null;children:ReactNode}) {
  const [drafts,setDrafts]=useState<EditDraftStore>(()=>new Map());
  useEffect(()=>{
    setDrafts(current=>{
      const next=new Map([...current].filter(([id,draft])=>draft.sourceIdentity===editDraftIdentity(props.report,props.editor,id)));
      return next.size===current.size?current:next;
    });
  },[props.report,props.editor]);
  return <EditDraftContext.Provider value={{drafts,setDrafts}}>{props.children}</EditDraftContext.Provider>;
}

export function ConsistencyEditCard(props:{report:ConsistencyReport;check:ConsistencyReport['checks'][number];editor:ConsistencyEditor|null;request:Request;onChange:(value:ConsistencyEditor)=>void;compact?:boolean;onDecided?:(operation:"accept"|"dismiss")=>void}) {
  const {report,check,editor}=props;
  const proposal=editor?.proposals[check.id],decision=editor?.decisions[check.id];
  const hasRewrite=proposal?.status==="ready"&&!!proposal.edits?.length;
  const adviceOnly=proposal?.status==="ready"&&!proposal.edits?.length;
  const action=check.reader_copy?.next_step||proposal?.confirmation_prompt?.trim()||proposal?.summary||check.recommendation?.confirmation_prompt||check.recommendation?.summary||check.regulatory?.action||check.reason;
  const actionKind=reviewAction(check,proposal);
  const adviceLabel=actionKind==="edit"?"修改建議":actionKind==="supplement"?"請補充說明":"只需核實";
  const [localReplacements,setLocalReplacements]=useState<string[]>([]),[localConfirmed,setLocalConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{setLocalReplacements(proposal?.edits?.map(e=>e.replacement)??[]);setLocalConfirmed(false);setError("");},[check.id,proposal?.id,proposal?.status]);
  const draftStore=useContext(EditDraftContext),sourceIdentity=draftStore?editDraftIdentity(report,editor,check.id):"";
  // Derived work items can display different facts from the raw report check.
  const identity=JSON.stringify([sourceIdentity,check]),setDrafts=draftStore?.setDrafts;
  const cachedDraft=draftStore?.drafts.get(check.id);
  useEffect(()=>{
    if(!cachedDraft||cachedDraft.identity===identity)return;
    setDrafts?.(current=>{if(current.get(check.id)!==cachedDraft)return current;const next=new Map(current);next.delete(check.id);return next;});
  },[cachedDraft,check.id,identity,setDrafts]);
  const freshDraft=():EditDraft=>({replacements:proposal?.edits?.map(edit=>edit.replacement)??[],confirmed:false});
  const draft=draftStore?(cachedDraft?.identity===identity?cachedDraft.value:freshDraft()):{replacements:localReplacements,confirmed:localConfirmed};
  const {replacements,confirmed}=draft;
  function updateDraft(update:(previous:EditDraft)=>EditDraft) {
    draftStore?.setDrafts(current=>{
      const saved=current.get(check.id),previous=saved?.identity===identity?saved.value:freshDraft();
      const next=new Map(current);next.set(check.id,{identity,sourceIdentity,value:update(previous)});return next;
    });
  }
  function setReplacements(update:SetStateAction<string[]>) {
    if(draftStore)updateDraft(previous=>({...previous,replacements:typeof update==="function"?update(previous.replacements):update}));
    else setLocalReplacements(update);
  }
  function setConfirmed(value:boolean) {
    if(draftStore)updateDraft(previous=>({...previous,confirmed:value}));
    else setLocalConfirmed(value);
  }
  async function act(operation:"accept"|"dismiss"|"undo") {
    if(!editor)return;
    const submittedDraft=cachedDraft?.identity===identity?cachedDraft:undefined;
    setBusy(true);setError("");
    try {
      const result=await props.request({action:"consistency-decide",run_id:report.run_id,check_id:check.id,expected_revision:editor.revision,operation,
        ...(operation==="accept"?{proposal_id:proposal?.id,facts_confirmed:confirmed,edits:proposal?.edits?.map((e,i)=>({...e,replacement:replacements[i]??e.replacement}))}:{})});
      const next=ConsistencyEditorSchema.parse(result);
      draftStore?.setDrafts(current=>{if(!submittedDraft||current.get(check.id)!==submittedDraft)return current;const drafts=new Map(current);drafts.delete(check.id);return drafts;});
      props.onChange(next);
      if(operation!=="undo")props.onDecided?.(operation);
    }catch(e){setError(e instanceof Error?e.message:"未能儲存修改。");try{props.onChange(ConsistencyEditorSchema.parse(await props.request({action:"consistency-editor",run_id:report.run_id})));}catch{/* Keep last verified state. */}}
    finally{setBusy(false);}
  }
  return <section className={`consistency-edit-card${props.compact?" consistency-edit-card--compact":""}`} aria-label={adviceOnly?"核實建議":"建議修改"}>
    {decision?<div className="consistency-edit-actions"><strong>{decision.status==="accepted"?"✓ 已加入修訂稿":"已忽略"}</strong><button disabled={busy} onClick={()=>void act("undo")}>撤回</button></div>:<>
      {proposal?.status==="ready"?<>
        {adviceOnly?<><strong>{adviceLabel}</strong><p>{action}</p></>:<>
          <strong>{proposal.requires_confirmation?"先確認，再修改":"可直接修改"}</strong><p>{check.reader_copy?.next_step||(proposal.requires_confirmation?action:proposal.summary)}</p>{proposal.edits?.map((edit,i)=><div className="consistency-edit-diff" key={i}><small>{report.documents.find(d=>d.slot===edit.slot)?.label} · p.{edit.page}</small><InlineChange before={edit.original} after={replacements[i]??edit.replacement}/>{!props.compact&&<details><summary>調整寫法</summary><textarea aria-label={`建議寫法 ${i+1}`} value={replacements[i]??edit.replacement} maxLength={3000} rows={3} onChange={e=>setReplacements(v=>v.map((s,n)=>n===i?e.target.value:s))}/></details>}</div>)}
          {proposal.requires_confirmation&&<label className="consistency-fact-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已確認，採用此修改</label>}
        </>}
      </>:<><strong>{actionKind==="verify"?"請先核實":adviceLabel}</strong><p>{action}</p>{proposal?.status==="generating"&&<small role="status">正在準備可套用的改法…</small>}{proposal?.status==="failed"&&<small>暫無可套用改寫；可在工作台重試建議。</small>}</>}
      <div className="consistency-edit-actions">{hasRewrite&&<button className="finance-primary" disabled={busy||proposal.requires_confirmation&&!confirmed} onClick={()=>void act("accept")}>{busy?"儲存中…":"接受修改"}</button>}<button disabled={busy||!editor} onClick={()=>void act("dismiss")}>忽略</button>{hasRewrite&&!props.compact&&<small>接受後加入修訂稿</small>}</div>
    </>}{error&&<p role="alert" className="finance-error">{error}</p>}
  </section>;
}
export function ConsistencyDraftExport(props:{report:ConsistencyReport;editor:ConsistencyEditor|null;request:Request;download?:(id:string)=>Promise<Blob>}) {
  const [slot,setSlot]=useState("all"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function exportDraft() {
    if(!props.editor||props.editor.run_id!==props.report.run_id)return;
    const run=props.report.run_id,revision=props.editor.revision;
    setBusy(true);setError("");
    try {
      const result=ConsistencyExportSchema.parse(await props.request({action:"consistency-draft-export",run_id:run,expected_revision:revision,...(slot!=="all"?{slot:slot as ConsistencySlot}:{})}));
      if(result.revision!==revision)throw new Error("修訂版本已變更，請重新載入後再匯出。");
      if(!props.download)throw new Error("請更新Cuby以啟用PDF下載。");
      const blob=await props.download(result.download_id),url=URL.createObjectURL(blob);
      const link=document.createElement("a");link.href=url;link.download=result.file_name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){setError(e instanceof Error?e.message:"匯出未完成。");}finally{setBusy(false);}
  }
  const accepted=Object.values(props.editor?.decisions??{}).filter(d=>d.status==="accepted").length;
  return <details className="consistency-export-menu"><summary>匯出修訂PDF · {accepted}項修改</summary><div className="consistency-draft-export"><select aria-label="匯出修訂文件" value={slot} onChange={e=>setSlot(e.target.value)}><option value="all">全部已上載PDF＋修改記錄</option>{props.report.documents.filter(d=>!d.slot.startsWith("prior_")).map(d=><option key={d.slot} value={d.slot}>{d.label} · PDF</option>)}</select><button disabled={busy||!props.editor||props.editor.run_id!==props.report.run_id} onClick={()=>void exportDraft()}>{busy?"正在核對版面…":"匯出PDF"}</button><small>保留原PDF樣式；只套用已接受修改。</small>{!accepted&&<small>尚未接受修改；匯出內容與原件相同。</small>}{error&&<span role="alert">{error}</span>}</div></details>;
}
