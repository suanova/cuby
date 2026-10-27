// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { ConsistencyReport } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { ConsistencySetup, ConsistencyReader, buildConsistencyQuestion } from "../finance-consistency-view.js";
import { financeWorkflowDisplayText } from "@memmy/local-api-contracts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
function fixture():ConsistencyReport {
  const slots=["esg_zh","esg_en","annual_zh","annual_en"] as const;
  return {schema_version:"financebuddy-consistency-1",run_id:"20310101T000000-aabbccdd",created_at:"2031-01-01",fiscal_year:"2031/32",
    comparisons:["bilingual","cross_report","internal","restatement"],history:{status:"not_requested",fiscal_year:"2030/31",source:"WeKnora"},
    documents:slots.map(s=>({slot:s,label:s,file_name:s+".pdf",sha256:"a".repeat(64),page_count:3,cover_year_found:true,identity_confirmed:true,textless_pages:[]})),
    checks:[{id:"value",category:"metric",status:"matched",title:"Scope 1",reason:"列報數值相同；口徑仍待核。",refs:[{slot:"esg_zh",page:2,quote:"Scope 1",value:"12",unit:"tCO2e"},{slot:"esg_en",page:2,quote:"Scope 1",value:"12",unit:"tCO2e"}]},
      {id:"basis",category:"basis",status:"difference",title:"因子題名年份",reason:"題名不同，不代表計算用錯。",refs:[{slot:"esg_zh",page:3,quote:"2018",value:"2018"},{slot:"esg_en",page:3,quote:"2019",value:"2019"}]},
      {id:"page",category:"page_numbers",status:"pending",title:"頁面候選",reason:"待對齊",refs:[]}],
    coverage:{scanned_pages:12,page_pairs:6,same_numeric_inventory_pages:5,metric_checks:1,numeric_facts:2,matched:1,differences:1,pending:1,historical_pages:0,internal_checks:0,restatement_checks:0},
    all_numbers_confirmed:false,all_basis_confirmed:false,limits:["只覆蓋指定表格；全文語義待核。"]};
}
describe("Four report consistency",()=>{
  it("starts with four existing documents without asking for a prompt or exposing an unfinished reader",async()=>{
    localStorage.clear();const div=document.createElement("div"),root=createRoot(div);let finish!:(v:unknown)=>void;
    const request=vi.fn(()=>new Promise(resolve=>{finish=resolve;})),complete=vi.fn();
    try {
      await act(async()=>root.render(<ConsistencySetup client={{} as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(Array.from(div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).every(c=>c.checked)).toBe(true);
      await act(async()=>{const select=div.querySelector('select')!;select.value='existing';select.dispatchEvent(new Event('change',{bubbles:true}));});
      await act(async()=>Array.from(div.querySelectorAll("button")).find(b=>b.textContent==="開始一致性核對")!.click());
      expect(request).toHaveBeenCalledWith({action:"consistency-build",fiscal_year:"2025/26",comparisons:["bilingual","cross_report","internal","restatement"]});
      expect(complete).not.toHaveBeenCalled();expect(div.querySelector(".consistency-reader")).toBeNull();
      await act(async()=>finish(fixture()));expect(complete).toHaveBeenCalledWith(fixture());
    } finally{act(()=>root.unmount());}
  });
  it("requires all four role assignments and uploads only files selected for this workflow",async()=>{
    localStorage.clear();const div=document.createElement("div"),root=createRoot(div);
    const upload=vi.fn(async(files:any[])=>files.map((f,i)=>({path:`/uploaded/${i}.pdf`,name:f.name,kind:"file",mime:"application/pdf"})));
    const request=vi.fn(async()=>fixture());
    try {
      await act(async()=>root.render(<ConsistencySetup client={{uploadAgentMedia:upload} as unknown as MemmyAgentClient} request={request} onComplete={()=>{}}/>));
      await act(async()=>{const select=div.querySelector("select")!;select.value="upload";select.dispatchEvent(new Event("change",{bubbles:true}));});
      const start=()=>Array.from(div.querySelectorAll("button")).find(b=>b.textContent==="開始一致性核對")!;
      expect(start().disabled).toBe(true);expect(div.querySelectorAll('input[type="file"]')).toHaveLength(4);
      await act(async()=>Array.from(div.querySelectorAll<HTMLInputElement>('input[type="file"]')).forEach((input,i)=>{Object.defineProperty(input,"files",{value:[new File(["%PDF fixture"],`report-${i}.pdf`,{type:"application/pdf"})]});input.dispatchEvent(new Event("change",{bubbles:true}));}));
      expect(start().disabled).toBe(false);await act(async()=>start().click());
      expect(upload.mock.calls[0]![0].map(f=>f.name)).toEqual(["esg_zh-report-0.pdf","esg_en-report-1.pdf","annual_zh-report-2.pdf","annual_en-report-3.pdf"]);
      expect(request).toHaveBeenCalledWith({action:"consistency-build",fiscal_year:"2025/26",comparisons:["bilingual","cross_report","internal","restatement"],documents:[{slot:"esg_zh",path:"/uploaded/0.pdf"},{slot:"esg_en",path:"/uploaded/1.pdf"},{slot:"annual_zh",path:"/uploaded/2.pdf"},{slot:"annual_en",path:"/uploaded/3.pdf"}]});
    } finally{act(()=>root.unmount());}
  });
  it("shows a source pair for confirmed differences and keeps page candidates out of the default issue list",async()=>{
    const div=document.createElement("div"),root=createRoot(div),request=vi.fn(async()=>({data_url:"data:image/png;base64,AA=="}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request}/>));
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(1);
      expect(div.querySelector('.consistency-check')?.textContent).toContain("因子題名年份");
      expect(div.querySelectorAll('img')).toHaveLength(2);
      expect(request).toHaveBeenCalledWith({action:"consistency-page",run_id:"20310101T000000-aabbccdd",slot:"esg_zh",page:3,check_id:"basis"});
      expect(div.textContent).toContain("黃色標示引用位置");
    } finally{act(()=>root.unmount());}
  });
  it("hands one selected issue to Cuby with source priority and bounded context instructions",async()=>{
    const prompt=buildConsistencyQuestion("20310101T000000-aabbccdd","basis","可以怎樣改？");
    expect(prompt).toContain('read_consistency_issue');expect(prompt).toContain('check_id="basis"');
    expect(prompt).toContain('不得查找本年乾淨版');expect(prompt).toContain('不能猜今年數字');
    expect(financeWorkflowDisplayText(prompt)).toBe('就選中的一致性項目：可以怎樣改？');
    expect(financeWorkflowDisplayText(prompt+'\n額外指示不可隱藏')).toBeNull();
    const div=document.createElement('div'),root=createRoot(div),ask=vi.fn(async()=>{}),request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request} onAsk={ask}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='請 Cuby 建議')!.click());
      expect(ask).toHaveBeenCalledWith(expect.stringContaining('check_id="basis"'));
    } finally {act(()=>root.unmount());}
  });
  it("keeps unfinished checks out of findings and opens them without evidence highlighting or a rewrite action",async()=>{
    const report=fixture();
    report.checks.push({id:'basis-esg_zh',category:'basis',status:'pending',title:'涵蓋業務尚未比較',reason:'尚未比較。',refs:[{slot:'esg_en',page:2,quote:'A whole paragraph of context.'}]});
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={report} request={request} onAsk={async()=>{}}/>));
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(1);
      expect(div.querySelector('.consistency-check-list')?.textContent).not.toContain('涵蓋業務');
      request.mockClear();
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='not_checked';select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(div.querySelector('.consistency-check-list')?.textContent).toContain('未檢查');
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:report.run_id,slot:'esg_en',page:2});
      expect(Array.from(div.querySelectorAll('button')).some(b=>b.textContent==='請 Cuby 建議')).toBe(false);
    } finally {act(()=>root.unmount());}
  });
});
