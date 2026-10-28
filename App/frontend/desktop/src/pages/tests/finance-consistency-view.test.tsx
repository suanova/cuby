// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { ConsistencyReport } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { ConsistencySetup, ConsistencyReader, buildConsistencyQuestion } from "../finance-consistency-view.js";
import { ConsistencyDraftExport } from "../consistency-edit-controls.js";
import { FinanceWorkspace } from "../finance-workspace.js";
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
  it("previews the actual revised PDF rather than rebuilding it as plain text",async()=>{
    const div=document.createElement("div"),root=createRoot(div);
    const state={run_id:fixture().run_id,base_sha256:"a".repeat(64),revision:2,proposals:{},decisions:{},history:[]};
    const request=vi.fn(async(input:any)=>input.action==="consistency-editor"?state:{data_url:input.action==="consistency-draft-page"?"data:image/png;base64,REVISED":"data:image/png;base64,ORIGINAL",layout_notice:"保留原PDF樣式。"});
    try {
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request}/>));
      await act(async()=>Array.from(div.querySelectorAll("button")).find(b=>b.textContent==="修訂PDF預覽")!.click());
      expect(request).toHaveBeenCalledWith({action:"consistency-draft-page",run_id:fixture().run_id,slot:"esg_zh",page:3});
      expect(div.querySelector('img[alt="esg_zh 修訂PDF 3"]')?.getAttribute("src")).toBe("data:image/png;base64,REVISED");
      expect(div.querySelector("pre")).toBeNull();expect(div.textContent).toContain("保留原PDF樣式");
    }finally{act(()=>root.unmount());}
  });
  it("exports PDF through the authenticated download client and keeps layout failures visible",async()=>{
    const div=document.createElement("div"),root=createRoot(div),id="1b49956c-2a04-4e4a-998f-aaf3846d9f76";
    const request=vi.fn(async()=>({file_name:"esg_en-revised.pdf",mime:"application/pdf",download_id:id,bytes:100,sha256:"a".repeat(64),revision:1,accepted:1,layout_notice:"保留原PDF樣式。"}));
    const download=vi.fn(async()=>new Blob(["%PDF-1.7"],{type:"application/pdf"}));
    const create=vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:revised-pdf"),click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
    try {
      await act(async()=>root.render(<ConsistencyDraftExport report={fixture()} editor={{run_id:fixture().run_id,base_sha256:"a".repeat(64),revision:1,proposals:{},decisions:{},history:[]}} request={request} download={download}/>));
      expect(div.textContent).toContain("全部四份PDF");expect(div.textContent).not.toContain("Word");
      await act(async()=>div.querySelector("button")!.click());
      expect(download).toHaveBeenCalledWith(id);expect(create).toHaveBeenCalledWith(expect.any(Blob));expect(click).toHaveBeenCalledOnce();
      request.mockRejectedValueOnce(new Error("ESG英文第12頁：新增文字放不進同一頁。"));
      await act(async()=>div.querySelector("button")!.click());
      expect(div.querySelector('[role="alert"]')?.textContent).toContain("第12頁");expect(download).toHaveBeenCalledTimes(1);
    }finally{act(()=>root.unmount());create.mockRestore();click.mockRestore();}
  });
  it("starts with four existing documents without asking for a prompt or exposing an unfinished reader",async()=>{
    localStorage.clear();const div=document.createElement("div"),root=createRoot(div);let finish!:(v:unknown)=>void;
    const request=vi.fn((input:any)=>input.action==="consistency-semantic-start"?Promise.resolve(fixture()):new Promise(resolve=>{finish=resolve;})),complete=vi.fn();
    try {
      await act(async()=>root.render(<ConsistencySetup client={{} as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(Array.from(div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).every(c=>c.checked)).toBe(true);
      await act(async()=>{const select=div.querySelector('select')!;select.value='existing';select.dispatchEvent(new Event('change',{bubbles:true}));});
      await act(async()=>Array.from(div.querySelectorAll("button")).find(b=>b.textContent==="開始一致性核對")!.click());
      expect(request).toHaveBeenCalledWith({action:"consistency-build",fiscal_year:"2025/26",comparisons:["bilingual","cross_report","internal","restatement"]});
      expect(complete).not.toHaveBeenCalled();expect(div.querySelector(".consistency-reader")).toBeNull();
      await act(async()=>finish(fixture()));expect(complete).toHaveBeenCalledWith(fixture());
      expect(request).toHaveBeenCalledWith({action:"consistency-semantic-start",run_id:fixture().run_id});
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
      await act(async()=>div.querySelectorAll<HTMLButtonElement>('[aria-label="放大報告"]')[0]!.click());
      expect(div.querySelectorAll('img')[0]!.style.width).toBe('125%');
      expect(div.querySelectorAll('img')[1]!.style.width).toBe('100%');
      expect(request).toHaveBeenCalledWith({action:"consistency-page",run_id:"20310101T000000-aabbccdd",slot:"esg_zh",page:3,check_id:"basis"});
      expect(div.textContent).toContain("黃色標示引用位置");
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='專注閱讀')!.click());
      expect(div.querySelector('.consistency-reader--reading')).not.toBeNull();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='返回審閱')!.click());
      expect(div.querySelector('.consistency-reader--reading')).toBeNull();
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(2);
      expect(div.querySelector('.consistency-check.candidate')).toBeNull();
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='page_numbers';select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(1);
      expect(div.textContent).toContain('初篩紀錄不算報告問題');
    } finally{act(()=>root.unmount());}
  });
  it("reopens a history session and sends its follow-up to the same bound review chat",async()=>{
    const report=fixture(),binding={project_id:'a'.repeat(32),native_project_id:'native-project',run_id:report.run_id,session_key:'websocket:fin_'+'c'.repeat(32),chat_id:'fin_'+'c'.repeat(32)};
    const div=document.createElement('div'),root=createRoot(div),launch=vi.fn(async()=>{});
    const request=vi.fn(async(input:any)=>input.action==='consistency-read'?report:input.action==='consistency-editor'?{run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,proposals:{},decisions:{},history:[]}:{data_url:'data:image/png;base64,AA=='});
    const client={financeReaderRequest:request,getFinanceCatalog:async()=>({reviews:[],unavailable:[],scope:'C2'})} as unknown as MemmyAgentClient;
    try {
      await act(async()=>root.render(<FinanceWorkspace visible client={client} initialPath={null} initialReview={binding} workflow={null} busy={false} onChoose={()=>{}} onLaunch={launch} onClose={()=>{}}/>));
      expect(request).toHaveBeenCalledWith({action:'consistency-read',run_id:report.run_id});
      expect(div.querySelectorAll('img')).toHaveLength(2);
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      await act(async()=>Array.from(div.querySelectorAll('summary')).find(b=>b.textContent==='追問 Cuby')!.click());
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='送出')!.click());
      expect(launch).toHaveBeenCalledWith(expect.stringContaining(report.run_id),binding);
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      // Switching to a chat with no review must not retain the previous project's PDF.
      await act(async()=>root.render(<FinanceWorkspace visible client={client} initialPath={null} initialReview={null} workflow={null} busy={false} onChoose={()=>{}} onLaunch={launch} onClose={()=>{}}/>));
      expect(div.querySelector('.consistency-reader')).toBeNull();
    }finally{act(()=>root.unmount());}
  });
  it("does not reveal a previous report if its load finishes after switching to an unrelated chat",async()=>{
    const report=fixture(),binding={project_id:'a'.repeat(32),native_project_id:'native-project',run_id:report.run_id,session_key:'websocket:fin_'+'c'.repeat(32),chat_id:'fin_'+'c'.repeat(32)};
    let resolveReport!:(value:unknown)=>void;
    const request=vi.fn((input:any)=>input.action==='consistency-read'?new Promise(resolve=>{resolveReport=resolve;}):Promise.resolve({}));
    const client={financeReaderRequest:request,getFinanceCatalog:async()=>({reviews:[],unavailable:[],scope:'C2'})} as unknown as MemmyAgentClient;
    const div=document.createElement('div'),root=createRoot(div);
    const render=(review:typeof binding|null)=><FinanceWorkspace visible client={client} initialPath={null} initialReview={review} workflow={null} busy={false} onChoose={()=>{}} onLaunch={async()=>{}} onClose={()=>{}}/>;
    try {
      await act(async()=>root.render(render(binding)));
      expect(div.textContent).toContain('正在驗證');
      await act(async()=>root.render(render(null)));
      await act(async()=>resolveReport(report));
      expect(div.querySelector('.consistency-reader')).toBeNull();
      expect(div.textContent).not.toContain('正在驗證');
    }finally{act(()=>root.unmount());}
  });
  it("keeps issue details in a dismissible dialog while the full list and both reports remain mounted",async()=>{
    const report=fixture();
    for(let i=0;i<8;i++)report.checks.push({...report.checks[1]!,id:`extra-${i}`,title:`問題 ${i}`});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div),request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(9);
      expect(div.querySelector('.consistency-reason')).toBeNull();
      const open=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!;
      open.focus();await act(async()=>open.click());
      const dialog=div.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog).not.toBeNull();expect(div.querySelectorAll('img')).toHaveLength(2);
      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
      expect(div.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(open);
    }finally{act(()=>root.unmount());div.remove();}
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
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      await act(async()=>Array.from(div.querySelectorAll('summary')).find(b=>b.textContent==='追問 Cuby')!.click());
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='送出')!.click());
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
  it("runs narrative checks in the background and updates the reader without a chat prompt",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2031-01-01T00:03:00Z'));const div=document.createElement('div'),root=createRoot(div);
    const running={...fixture(),semantic:{status:'running' as const,job_id:'job',model:'test-model',reasoning_effort:'xhigh',context_tokens:1000000,completed_tasks:0,total_tasks:2,started_at:'2031-01-01T00:00:00Z',updated_at:'2031-01-01',gaps:[],findings_count:0,matched_count:0,tasks:[{id:'bilingual' as const,label:'中英文意思',status:'running' as const,submitted_pages:12}]}};
    const done={...running,semantic:{...running.semantic,status:'completed' as const,completed_tasks:2,matched_count:1}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-semantic-start'?running:input.action==='consistency-read'?done:{data_url:'data:image/png;base64,AA=='});
    try {
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request}/>));
      expect(div.textContent).toContain('內文意思尚未核對');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='核對內文')!.click());
      expect(div.textContent).toContain('正在核對內文');
      expect(div.textContent).toContain('步驟進度 0%');expect(div.textContent).toContain('已用 3分鐘');
      expect(div.querySelector('progress')?.value).toBe(0);
      expect(div.querySelector('progress')?.max).toBe(2);
      expect(div.querySelector('[aria-label="中英意思：核對中"]')).not.toBeNull();
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(request).toHaveBeenCalledWith({action:'consistency-read',run_id:fixture().run_id});
      expect(div.textContent).toContain('內文核對完成');expect(div.textContent).toContain('1項一致');
      expect(div.querySelector('progress')).toBeNull();
      expect(div.textContent).toContain('核對已結束 · 2/2步成功');
    } finally{act(()=>root.unmount());vi.useRealTimers();}
  });
});
