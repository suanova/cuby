// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe,it,expect,vi } from "vitest";
import { FinanceProjectSetup } from "../finance-project-setup.js";
import { ConsistencyEditCard } from "../consistency-edit-controls.js";
import type { ConsistencyEditor,ConsistencyReport,FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const pid="a".repeat(32),vid="b".repeat(32),run="20310101T000000-aabbccdd";
const project:FinanceProject={id:pid,title:"Finance project",external_id:null,revision:1,created_at:"2031-01-01",updated_at:"2031-01-01",latest_run:run,active_version:vid,
  versions:[{id:vid,fiscal_year:"2031/32",created_at:"2031-01-01",runs:[run],documents:(["esg_zh","esg_en","annual_zh","annual_en"] as const).map(slot=>({slot,file_name:slot+".pdf",sha256:"a".repeat(64),bytes:1000}))}]};
const check={id:"issue",category:"basis" as const,status:"difference" as const,title:"Regions differ",reason:"Confirm regions",refs:[]};
const editor:ConsistencyEditor={run_id:run,base_sha256:"a".repeat(64),revision:0,decisions:{},history:[],proposals:{issue:{id:"proposal",status:"ready",updated_at:"2031-01-01",summary:"統一兩版地區。",requires_confirmation:true,confirmation_prompt:"我已確認包括中國內地",edits:[{slot:"esg_en",page:1,original:"Report covers Hong Kong only.",replacement:"Report covers Hong Kong and Mainland China."}]}}};
describe("Project report editing",()=>{
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
  it("labels a new request as advice until an actual rewrite is returned",async()=>{
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn(async()=>editor);
    try{
      await act(async()=>root.render(<ConsistencyEditCard report={{run_id:run,documents:[]} as unknown as ConsistencyReport} check={check} editor={{...editor,proposals:{}}} request={request} onChange={()=>{}}/>));
      expect(div.textContent).not.toContain("接受後加入修訂稿");
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="取得建議")!.click());
      expect(request).toHaveBeenCalledWith({action:"consistency-suggest",run_id:run,check_id:"issue"});
    }finally{act(()=>root.unmount());}
  });
  it("reopens saved project documents without requesting another upload",async()=>{
    localStorage.clear();const div=document.createElement("div"),root=createRoot(div),upload=vi.fn(),complete=vi.fn();
    const request=vi.fn(async(input:any)=>input.action==="project-list"?{projects:[project]}:{});
    try{
      await act(async()=>root.render(<FinanceProjectSetup client={{uploadAgentMedia:upload} as unknown as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(div.textContent).toContain("esg_en.pdf");expect(div.querySelector('details')?.open).toBe(false);
      expect(Array.from(div.querySelectorAll('button')).find(b=>b.textContent==="繼續上次審閱")).toBeTruthy();
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
