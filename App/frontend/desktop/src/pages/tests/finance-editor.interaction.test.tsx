// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe,it,expect,vi } from "vitest";
import { FinanceProjectSetup } from "../finance-project-setup.js";
import { ConsistencyEditCard, ConsistencySuggestionStatus } from "../consistency-edit-controls.js";
import type { ConsistencyEditor,ConsistencyReport,FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const pid="a".repeat(32),vid="b".repeat(32),run="20310101T000000-aabbccdd";
const inputKnowledge=(year='2024/25')=>({entity_id:'yeebo',entity_name:'億都',observed_at:'2031-01-01',catalog_revision:'mock',documents:[{source_id:'mock-prior',file_name:'prior-esg-en.pdf',sha256:'c'.repeat(64),fiscal_year:year,kind:'esg',language:'en',original_status:'verified',indexed_status:'verified'}]});
const inputInspection={file_name:'latest-English.pdf',sha256:'c'.repeat(64),bytes:4,pages:1,fields:Object.fromEntries(Object.entries({issuer:'yeebo',fiscal_year:'2025/26',kind:'esg',language:'en'}).map(([field,value])=>[field,{status:'identified',value,evidence:[{page:1,quote:'TEST ONLY mock original identity'}]}])),supported:true,test_only:true,scan_pages:[1],limits:[],inspection_id:'00000000-0000-4000-8000-000000000001'};
const project:FinanceProject={id:pid,title:"Finance project",external_id:null,revision:1,created_at:"2031-01-01",updated_at:"2031-01-01",latest_run:run,active_version:vid,
  versions:[{id:vid,fiscal_year:"2031/32",created_at:"2031-01-01",runs:[run],reviews:[{run_id:run,kind:"consistency",status:"completed"}],documents:(["esg_zh","esg_en","annual_zh","annual_en"] as const).map(slot=>({slot,file_name:slot+".pdf",sha256:"a".repeat(64),bytes:1000}))}]};
const check={id:"issue",category:"basis" as const,status:"difference" as const,title:"Regions differ",reason:"Confirm regions",refs:[]};
const editor:ConsistencyEditor={run_id:run,base_sha256:"a".repeat(64),revision:0,decisions:{},history:[],proposals:{issue:{id:"proposal",status:"ready",updated_at:"2031-01-01",summary:"統一兩版地區。",requires_confirmation:true,confirmation_prompt:"我已確認包括中國內地",edits:[{slot:"esg_en",page:1,original:"Report covers Hong Kong only.",replacement:"Report covers Hong Kong and Mainland China."}]}}};
describe("Project report editing",()=>{
  it("saves one English PDF and enables only the checks supported by that document",async()=>{
    localStorage.clear();const div=document.createElement('div'),root=createRoot(div),upload=vi.fn(async()=>[{kind:'file',mime:'application/pdf',path:'/media/one.pdf',url:'http://127.0.0.1/mock/one.pdf'}]);
    const created={...project,versions:[],active_version:undefined,latest_run:null,revision:0};
    const saved={...project,versions:[{...project.versions[0]!,fiscal_year:'2025/26',runs:[],documents:[project.versions[0]!.documents[1]!]}]};
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?inputKnowledge():input.action==='input-inspect'?inputInspection:input.action==='project-list'?{projects:[]}:input.action==='project-create'?created:saved);
    try{
      await act(async()=>root.render(<FinanceProjectSetup client={{uploadAgentMedia:upload} as unknown as MemmyAgentClient} request={request} onComplete={()=>{}}/>));
      const picker=div.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker,'files',{configurable:true,value:[new File(['%PDF'],'latest-English.pdf',{type:'application/pdf'})]});
      await act(async()=>picker.dispatchEvent(new Event('change',{bubbles:true})));
      expect(div.querySelector('[aria-label="文件1種類及語言"]')).toBeNull();
      expect(div.querySelector('.finance-input-identity')?.textContent).toContain('FY2025/26');
      const checks=Array.from(div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
      expect(checks.map(c=>[c.checked,c.disabled])).toEqual([[true,false],[false,true],[false,true],[true,false]]);
      expect(div.textContent).toContain('未有對應中英兩版，今次不做');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='只儲存文件')!.click());
      expect(upload).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(expect.objectContaining({action:'project-save',documents:[{slot:'esg_en',path:'/media/one.pdf',file_name:'latest-English.pdf',inspection_id:inputInspection.inspection_id}]}));
      expect(request).not.toHaveBeenCalledWith(expect.objectContaining({action:'project-build'}));
    }finally{act(()=>root.unmount());}
  });
  it.each([[],undefined])("shows advice without rewrite controls when no replacement is available (%s)",async(edits)=>{
    const div=document.createElement('div'),root=createRoot(div),change=vi.fn();
    const advice:ConsistencyEditor={...editor,proposals:{issue:{...editor.proposals.issue!,edits,summary:"需先核實換算依據。",confirmation_prompt:"請提供升轉 kWh 的換算系數及來源。"}}};
    const request=vi.fn(async()=>({...advice,revision:1,decisions:{issue:{status:"dismissed",edits:[],at:"2031-01-01"}}}));
    const report={run_id:run,documents:[{slot:"esg_en",label:"ESG English"}]} as ConsistencyReport;
    try{
      await act(async()=>root.render(<ConsistencyEditCard report={report} check={check} editor={advice} request={request} onChange={change}/>));
      expect(div.querySelector('[aria-label="核實建議"]')).not.toBeNull();
      expect(div.textContent).toContain("請提供升轉 kWh 的換算系數及來源。");
      expect(div.textContent).not.toContain("需先核實換算依據。");
      expect(div.querySelector('input[type="checkbox"]')).toBeNull();
      expect(div.querySelector('textarea')).toBeNull();
      expect(div.textContent).not.toMatch(/接受修改|接受後加入修訂稿|我已核實|建議改寫|取得建議/);
      expect(request).not.toHaveBeenCalled();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="忽略")!.click());
      expect(request).toHaveBeenCalledWith({action:"consistency-decide",run_id:run,check_id:"issue",expected_revision:0,operation:"dismiss"});
    }finally{act(()=>root.unmount());}
  });
  it("shows actionable advice while automatic preparation runs, without a per-card request",async()=>{
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn(async()=>editor);
    try{
      await act(async()=>root.render(<ConsistencyEditCard report={{run_id:run,documents:[]} as unknown as ConsistencyReport} check={check} editor={{...editor,proposals:{issue:{id:'preparing',status:'generating',updated_at:'2031-01-01'}}}} request={request} onChange={()=>{}}/>));
      expect(div.textContent).not.toContain("接受後加入修訂稿");
      expect(div.textContent).toContain("Confirm regions");
      expect(div.textContent).toContain("正在準備可套用的改法");
      expect(div.textContent).not.toMatch(/取得建議|重試建議|接受修改/);
      expect(request).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());}
  });
  it("separates a short fact question from a conditional rewrite without repeating the finding",async()=>{
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn();
    const shortCheck={...check,reader_copy:{title:'提供資源：酌情還是必須？',problem:'中文說酌情，英文說必須。',next_step:'請確認資源是否必須提供。'}};
    const report={run_id:run,documents:[{slot:'esg_en',label:'ESG English'}]} as ConsistencyReport;
    try{
      await act(async()=>root.render(<ConsistencyEditCard report={report} check={shortCheck} editor={editor} request={request} onChange={()=>{}}/>));
      expect(div.textContent).toContain('先確認，再修改');
      expect(div.textContent).toContain('請確認資源是否必須提供。');
      expect(div.textContent).not.toContain(editor.proposals.issue!.summary);
      expect(div.textContent).not.toContain(editor.proposals.issue!.confirmation_prompt);
      expect(Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='接受修改')!.disabled).toBe(true);
      expect(request).not.toHaveBeenCalled();
      await act(async()=>root.render(<ConsistencyEditCard report={report} check={shortCheck} editor={{...editor,proposals:{issue:{...editor.proposals.issue!,requires_confirmation:false}}}} request={request} onChange={()=>{}}/>));
      expect(div.textContent).toContain('可直接修改');expect(div.querySelector('input[type="checkbox"]')).toBeNull();
    }finally{act(()=>root.unmount());}
  });
  it("shows aggregate readiness and retries only unfinished suggestions in one action",async()=>{
    const div=document.createElement('div'),root=createRoot(div),change=vi.fn(),request=vi.fn(async()=>editor);
    try{
      const preparing={...editor,preparation:{id:'batch',status:'running' as const,updated_at:'2031-01-01',total:10,ready:7,failed:0}};
      await act(async()=>root.render(<ConsistencySuggestionStatus editor={preparing} request={request} onChange={change}/>));
      expect(div.textContent).toContain('7/10 項已備妥');expect(request).not.toHaveBeenCalled();
      await act(async()=>root.render(<ConsistencySuggestionStatus editor={{...preparing,preparation:{...preparing.preparation,status:'partial',failed:3}}} request={request} onChange={change}/>));
      await act(async()=>div.querySelector('button')!.click());
      expect(request).toHaveBeenCalledExactlyOnceWith({action:'consistency-prepare',run_id:run});
      expect(change).toHaveBeenCalledWith(editor);
    }finally{act(()=>root.unmount());}
  });
  it("reopens saved project documents without requesting another upload",async()=>{
    localStorage.clear();const div=document.createElement("div"),root=createRoot(div),upload=vi.fn(),complete=vi.fn();
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?inputKnowledge('2030/31'):input.action==="project-list"?{projects:[project]}:{});
    try{
      await act(async()=>root.render(<FinanceProjectSetup initialSelection={{project_id:pid,version_id:vid}} client={{uploadAgentMedia:upload} as unknown as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(div.textContent).toContain("esg_en.pdf");expect(div.querySelector('details')?.open).toBe(false);
      expect(Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="開啟一致性審閱結果")).toBeTruthy();
      expect(upload).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());}
  });
  it("requires fact confirmation, sends exact replacements and persists accept dismiss undo actions",async()=>{
    const div=document.createElement('div'),root=createRoot(div),change=vi.fn();
    const request=vi.fn(async()=>({...editor,revision:1,decisions:{issue:{status:"accepted",edits:editor.proposals.issue!.edits!,at:"2031-01-01"}}}));
    const report={run_id:run,documents:[{slot:"esg_en",label:"ESG English"}]} as ConsistencyReport;
    try{
      await act(async()=>root.render(<ConsistencyEditCard report={report} check={check} editor={editor} request={request} onChange={change}/>));
      const accept=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="接受修改")!;
      expect(accept.disabled).toBe(true);
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(accept.disabled).toBe(false);
      await act(async()=>accept.click());
      expect(request).toHaveBeenCalledWith(expect.objectContaining({action:"consistency-decide",operation:"accept",proposal_id:"proposal",facts_confirmed:true,edits:editor.proposals.issue!.edits}));
      expect(change).toHaveBeenCalledWith(expect.objectContaining({revision:1}));
      await act(async()=>root.render(<ConsistencyEditCard report={report} check={check} editor={change.mock.calls[0]![0]} request={request} onChange={change}/>));
      expect(div.textContent).toContain("已加入修訂稿");
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="撤回")!.click());
      expect(request).toHaveBeenLastCalledWith(expect.objectContaining({operation:"undo",expected_revision:1}));
    }finally{act(()=>root.unmount());}
  });
});
