// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { ConsistencyReport, ConsistencyEditor } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { ConsistencySetup, ConsistencyReader, buildConsistencyQuestion } from "../finance-consistency-view.js";
import { ConsistencyDraftExport, ConsistencyEditCard, ConsistencyEditDraftProvider } from "../consistency-edit-controls.js";
import { FinanceWorkspace } from "../finance-workspace.js";
import { overviewState } from "../consistency-overview.js";
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
  it.each(['energy','injury'] as const)("preserves every %s quote, focus and draft across all three source citations",async example=>{
    const report=fixture(),check=report.checks[1]!;
    report.documents.forEach(doc=>{doc.page_count=49;doc.label=doc.slot==='esg_zh'?'ESG · 繁中':doc.slot==='esg_en'?'ESG · English':doc.label;});
    check.semantic_kind='bilingual';
    if(example==='energy'){
      check.id='semantic-bilingual-66cd8b82a78fbb';
      check.refs=[{slot:'esg_zh',page:12,quote:'於本年度內，本集團透過以下措施節省了電力及天然氣\n            採購約5,007,546千瓦時'},{slot:'esg_en',page:12,quote:'During the Reporting Period, we saved approximately 5,007,546 kWh (FY2024/25: 1,203,951 kWh)\nin electricity consumption'},{slot:'esg_zh',page:13,quote:'2台天燃氣熱鍋爐利用收集空壓機熱能減少天然氣用量'}];
      check.reader_copy={title:'節能量有沒有包括天然氣？',problem:'同一節能數字，中文說包括電力及天然氣，英文只說電力。',next_step:'請確認這個節能總量包括哪些能源，以及計算的是採購量還是消耗量。',action_kind:'verify'};
    }else{
      check.id='semantic-bilingual-0e9a8e79274a12';
      check.refs=[{slot:'esg_zh',page:23,quote:'主要原因為員工上下班路上交通事故導致。針\n   對此情況，本集團已全面強化安全管理體系，對員工加強培訓及提供上下班安全教育。'},{slot:'esg_en',page:23,quote:'The main reasons were due to unqualified\n                  production materials and commuter-related accidents.'},{slot:'esg_en',page:23,quote:'including implementing safety acceptance procedures\n                     for production material and enhancing employee safety awareness on commuting.'}];
      check.reader_copy={title:'工傷原因：英文多了生產材料問題',problem:'中文只寫通勤交通事故；英文另寫生產材料不合格，並多了一項材料安全驗收措施。',next_step:'請確認是否有材料相關工傷，以及有否實施材料驗收，再補齊對應版本。',action_kind:'verify'};
    }
    const phrases=example==='energy'?['電力及天然氣','electricity consumption','減少天然氣用量']:['上下班路上交通事故','production materials','safety acceptance procedures'];
    report.source_focus={[check.id]:check.refs.map(({slot,page,quote},index)=>({slot,page,quote,phrases:[phrases[index]!]}))};
    const originalCheck=JSON.stringify(check),english=check.refs.find(ref=>ref.slot==='esg_en')!;
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:4,history:[],decisions:{},proposals:{[check.id]:{id:'three-source-proposal',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,summary:'Confirm the scoped facts first.',edits:[{slot:'esg_en',page:english.page,original:english.quote,replacement:'A proposed source sentence.'}]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      let dialog=div.querySelector('[role="dialog"]')!;
      expect(dialog.querySelectorAll('.consistency-source-panel')).toHaveLength(2);
      const expected=check.refs.map((ref,index)=>({ref,index})).sort((a,b)=>Number(a.ref.slot.endsWith('_en'))-Number(b.ref.slot.endsWith('_en')));
      expect(Array.from(dialog.querySelectorAll('blockquote')).map(quote=>quote.textContent)).toEqual(expected.map(source=>source.ref.quote));
      expect(Array.from(dialog.querySelectorAll('blockquote strong')).map(phrase=>phrase.textContent)).toEqual(expected.map(source=>phrases[source.index]));
      expect(dialog.textContent).toContain(check.reader_copy.problem);
      expect(dialog.querySelector('.consistency-edit-card')?.textContent).toContain(check.reader_copy.next_step);
      const textarea=dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="建議寫法 1"]')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Draft across every source fragment.');
        textarea.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await act(async()=>dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      for(const ref of check.refs){
        const fragment=Array.from(dialog.querySelectorAll('.consistency-source-fragment')).find(part=>part.querySelector('blockquote')?.textContent===ref.quote)!;
        request.mockClear();
        await act(async()=>fragment.querySelector<HTMLButtonElement>('button')!.click());
        expect(div.querySelector('[role="dialog"]')).toBeNull();
        expect(div.querySelector('.consistency-check.selected')?.textContent).toContain(check.reader_copy.title);
        expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:report.run_id,slot:ref.slot,page:ref.page,check_id:check.id});
        expect(div.querySelector(`img[alt="${report.documents.find(doc=>doc.slot===ref.slot)!.label} PDF ${ref.page}"]`)).not.toBeNull();
        expect(document.activeElement).toBe(open);
        await act(async()=>open.click());dialog=div.querySelector('[role="dialog"]')!;
        expect(dialog.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Draft across every source fragment.');
        expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
        expect(Array.from(dialog.querySelectorAll('blockquote')).map(quote=>quote.textContent)).toEqual(expected.map(source=>source.ref.quote));
        expect(request.mock.calls.some(([input])=>/build|start|prepare|suggest|decide|export/.test(input.action))).toBe(false);
      }
      expect(JSON.stringify(check)).toBe(originalCheck);expect(editor.revision).toBe(4);expect(editor.decisions).toEqual({});
    }finally{act(()=>root.unmount());div.remove();}
  });
  it.each([0,1])("opens comparison citation %s without losing the finding or unsaved edit",async citation=>{
    const report=fixture(),check=report.checks[1]!;
    report.documents.forEach(doc=>{doc.page_count=4;doc.label=doc.slot==='esg_zh'?'ESG · 繁中':doc.slot==='esg_en'?'ESG · English':doc.label;});
    check.semantic_kind='bilingual';
    check.reader_copy={title:'薪酬未包括哪些氣候指標？',problem:'中文只說薪酬未包括節能減排進度指標；英文卻說未包括任何氣候相關考量。',next_step:'請確認薪酬只未包括節能減排進度，還是所有氣候因素都未包括。',action_kind:'verify'};
    check.refs=[{slot:'esg_en',page:4,quote:'At present, climate-related considerations have not been included in the remuneration policies.'},{slot:'esg_zh',page:4,quote:'目前\n     未將節能減排目標進度指標納入薪酬政策。'}];
    report.source_focus={[check.id]:check.refs.map(ref=>({slot:ref.slot,page:ref.page,quote:ref.quote,phrases:[ref.slot==='esg_zh'?'節能減排目標進度指標':'climate-related considerations']}))};
    const originalCheck=JSON.stringify(check);
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:4,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,summary:'Confirm the policy scope.',edits:[{slot:'esg_en',page:4,original:check.refs[0]!.quote,replacement:'A proposed policy sentence.'}]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      const comparison=dialog.querySelector('[aria-label="原文對照"]');
      expect(comparison).not.toBeNull();
      expect(dialog.querySelector('.consistency-reason')?.firstElementChild).toBe(comparison);
      expect(Array.from(comparison!.querySelectorAll('blockquote')).map(quote=>quote.textContent)).toEqual([check.refs[1]!.quote,check.refs[0]!.quote]);
      expect(Array.from(comparison!.querySelectorAll('blockquote strong')).map(phrase=>phrase.textContent)).toEqual(['節能減排目標進度指標','climate-related considerations']);
      expect(dialog.textContent).toContain(check.reader_copy.problem);
      expect(dialog.querySelector('.consistency-edit-card')?.textContent).toContain(check.reader_copy.next_step);
      const textarea=dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="建議寫法 1"]')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'My unsaved policy wording.');
        textarea.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await act(async()=>dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      const refreshed={...report,source_focus:{[check.id]:report.source_focus[check.id]!.map(focus=>focus.slot==='esg_zh'?{...focus,phrases:['薪酬政策']}:focus)}};
      await act(async()=>root.render(<ConsistencyReader report={refreshed} request={request}/>));
      expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="建議寫法 1"]')!.value).toBe('My unsaved policy wording.');
      expect(div.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.checked).toBe(true);
      expect(Array.from(comparison!.querySelectorAll('blockquote strong')).map(phrase=>phrase.textContent)).toEqual(['薪酬政策','climate-related considerations']);
      expect(JSON.stringify(check)).toBe(originalCheck);
      request.mockClear();
      await act(async()=>comparison!.querySelectorAll<HTMLButtonElement>('button')[citation]!.click());
      const selectedRef=check.refs[citation===0?1:0]!;
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain(check.reader_copy.title);
      expect(div.querySelector(`img[alt="${report.documents.find(doc=>doc.slot===selectedRef.slot)!.label} PDF 4"]`)).not.toBeNull();
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:report.run_id,slot:selectedRef.slot,page:4,check_id:check.id});
      expect(document.activeElement).toBe(open);
      await act(async()=>open.click());
      const reopened=div.querySelector('[role="dialog"]')!;
      expect(reopened.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('My unsaved policy wording.');
      expect(reopened.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      expect(reopened.querySelector('[aria-label="原文對照"]')).not.toBeNull();
      expect(Array.from(reopened.querySelectorAll('blockquote')).map(quote=>quote.textContent)).toEqual([check.refs[1]!.quote,check.refs[0]!.quote]);
      expect(request.mock.calls.some(([input])=>/build|start|prepare|suggest|decide|export/.test(input.action))).toBe(false);
      expect(editor.revision).toBe(4);expect(editor.decisions).toEqual({});
    }finally{act(()=>root.unmount());div.remove();}
  });
  it.each(['missing quote','missing citation','unsupported sources'])("preserves original detail and citation fallback for %s",async failure=>{
    const report=fixture(),check=report.checks[1]!;
    check.semantic_kind='bilingual';
    if(failure==='missing quote')check.refs[0]!.quote='';
    if(failure==='missing citation')check.refs.pop();
    if(failure==='unsupported sources')check.refs[0]!.slot='annual_zh';
    const request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='})),div=document.createElement('div'),root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      await act(async()=>div.querySelector<HTMLButtonElement>('.consistency-open-issue')!.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      expect(dialog.querySelector('[aria-label="原文對照"]')).toBeNull();
      expect(dialog.textContent).toContain(check.reason);
      expect(dialog.querySelectorAll('.consistency-values button')).toHaveLength(check.refs.length);
    }finally{act(()=>root.unmount());}
  });
  it("accepts a visible safe suggestion once, advances to the next issue and keeps counts separate from check records",async()=>{
    const report=fixture(),base=report.checks[1]!;
    report.checks.push({...base,id:'duplicate'}, {...base,id:'conditional',title:'下一個問題'});
    let editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,proposals:{basis:{id:'safe',status:'ready',updated_at:'2031-01-01',summary:'修正索引章節。',requires_confirmation:false,confirmation_prompt:'',edits:[{slot:'esg_en',page:3,original:'The index points to Energy.',replacement:'The index points to Water.'}]},conditional:{id:'conditional',status:'ready',updated_at:'2031-01-01',summary:'統一年份。',requires_confirmation:true,confirmation_prompt:'請確認正確年份是2023。',edits:[{slot:'esg_en',page:3,original:'The factor year is 2003.',replacement:'The factor year is 2023.'}]}},decisions:{},history:[]};
    const request=vi.fn(async(input:any)=>{
      if(input.action==='consistency-editor')return editor;
      if(input.action==='consistency-decide'){
        editor={...editor,revision:editor.revision+1,decisions:{...editor.decisions,[input.check_id]:{status:input.operation==='accept'?'accepted':'dismissed',edits:input.edits??[],at:'2031-01-01'}}};return editor;
      }
      return {data_url:'data:image/png;base64,AA=='};
    });
    const div=document.createElement('div'),root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const suggestion=div.querySelector('.consistency-card-suggestion')!;
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      expect(suggestion.querySelector('del')?.textContent).toBe('Energy');expect(suggestion.querySelector('ins')?.textContent).toBe('Water');
      const accept=Array.from(suggestion.querySelectorAll('button')).find(b=>b.textContent==='接受修改')!;
      expect(accept.disabled).toBe(false);expect(suggestion.querySelector('input[type="checkbox"]')).toBeNull();
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('檢查紀錄 4筆');
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(2);
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain('合併2筆檢查');
      await act(async()=>accept.click());
      expect(request).toHaveBeenCalledWith(expect.objectContaining({action:'consistency-decide',check_id:'basis',expected_revision:0,operation:'accept',facts_confirmed:false,edits:editor.proposals.basis!.edits}));
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain('下一個問題');
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('全部待辦 1');
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('已接受 1');
      expect(div.textContent).toContain('匯出修訂PDF · 1項修改');
      const conditional=div.querySelector('.consistency-card-suggestion')!;
      expect(Array.from(conditional.querySelectorAll('button')).find(b=>b.textContent==='接受修改')!.disabled).toBe(true);
      expect(conditional.textContent).toContain('請確認正確年份是2023。');
      await act(async()=>Array.from(conditional.querySelectorAll('button')).find(b=>b.textContent==='忽略')!.click());
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('全部待辦 0');
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('已忽略 1');
      expect(request.mock.calls.filter(([input])=>input.action==='consistency-decide')).toHaveLength(2);
      expect(request.mock.calls.some(([input])=>/prepare|suggest|build|start/.test(input.action))).toBe(false);
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='已接受 1')!.click());
      expect(div.querySelector('.consistency-card-suggestion')?.textContent).toContain('已加入修訂稿');
      expect(div.querySelector('.consistency-card-suggestion')?.textContent).toContain('撤回');
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='records';select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(4);
      await act(async()=>Array.from(div.querySelectorAll<HTMLButtonElement>('.consistency-check')).filter(b=>b.title==='因子題名年份')[1]!.click());
      expect(div.querySelector('.consistency-card-suggestion')?.textContent).toContain('已加入修訂稿');
      expect(div.querySelector('.consistency-card-suggestion')?.textContent).not.toContain('接受修改');
    }finally{act(()=>root.unmount());}
  });
  it("keeps a failed accept on the same card without advancing or changing pending counts",async()=>{
    const report=fixture();report.checks.push({...report.checks[1]!,id:'next',title:'不能跳到這項'});
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,decisions:{},history:[],proposals:{basis:{id:'safe',status:'ready',updated_at:'2031-01-01',summary:'修改章節。',requires_confirmation:false,confirmation_prompt:'',edits:[{slot:'esg_en',page:3,original:'The index points to Energy.',replacement:'The index points to Water.'}]}}};
    const request=vi.fn(async(input:any)=>{if(input.action==='consistency-editor')return editor;if(input.action==='consistency-decide')throw new Error('修訂已在另一視窗更新。');return {data_url:'data:image/png;base64,AA=='};});
    const div=document.createElement('div'),root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='接受修改')!.click());
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain('因子題名年份');
      expect(div.textContent).toContain('修訂已在另一視窗更新');
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('全部待辦 2');
    }finally{act(()=>root.unmount());}
  });
  it("opens the complete overview, excludes numeric page scans from verdict counts, and jumps to a checked source",async()=>{
    const report=fixture(),div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    report.checks.push({...report.checks[1]!,id:'unstarted',status:'pending',review_state:'not_checked',title:'內文尚未核對',reason:'尚未逐句比較。'});
    report.checks.push({...report.checks[1]!,id:'blocked',category:'restatement',status:'pending',review_state:'not_checked',title:'欠缺上年度數值',reason:'未取得原件：[Errno 2] No such file or directory: D:/private/prior.pdf'});
    report.history={...report.history,status:'unavailable',reason:'[Errno 2] No such file or directory: D:/private/prior.pdf'};
    const editor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:1,proposals:{},history:[],decisions:{basis:{status:'dismissed',at:'2031-01-01',edits:[]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const opener=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='檢查總覽')!;
      await act(async()=>opener.click());
      const dialog=div.querySelector<HTMLElement>('[role="dialog"][aria-label="檢查總覽"]')!;
      expect(dialog).not.toBeNull();expect(dialog.contains(document.activeElement)).toBe(true);
      const counts=dialog.querySelector('[aria-label="檢查狀態總數"]')!;
      expect(counts.textContent).toContain('全部 4');expect(counts.textContent).toContain('有差異 1');
      expect(counts.textContent).toContain('未做 1');expect(counts.textContent).toContain('未能完成 1');
      expect(dialog.textContent).toContain('只作定位參考');expect(dialog.textContent).toContain('已忽略');
      expect(dialog.textContent).toContain('請補上去年原件');expect(dialog.textContent).not.toContain('D:/private');
      await act(async()=>Array.from(dialog.querySelectorAll('button')).find(b=>b.textContent?.includes('已核對 1'))!.click());
      expect(dialog.querySelectorAll('.consistency-overview-item')).toHaveLength(1);
      request.mockClear();await act(async()=>dialog.querySelector<HTMLButtonElement>('.consistency-overview-item')!.click());
      expect(div.querySelector('[role="dialog"][aria-label="檢查總覽"]')).toBeNull();
      expect(div.querySelector('[role="dialog"][aria-label="Scope 1"]')).not.toBeNull();
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:report.run_id,slot:'esg_zh',page:2,check_id:'value'});
      expect(request.mock.calls.some(([input])=>/build|start|decide/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());div.remove();}
  });
  it("distinguishes an unstarted check, an interrupted check and a completed result in the overview",()=>{
    const report=fixture(),check={...report.checks[1]!,status:'pending' as const,review_state:'not_checked' as const,reason:'尚未逐句比較。'};
    expect(overviewState(check,report)).toBe('not_started');
    report.semantic={status:'partial',job_id:'saved',model:'test',reasoning_effort:'xhigh',context_tokens:1000000,completed_tasks:0,total_tasks:1,updated_at:'2031-01-01',gaps:[],findings_count:0,matched_count:0,tasks:[{id:'bilingual',label:'中英意思',status:'failed',submitted_pages:12,error:'模型串流中斷。'}]};
    expect(overviewState(check,report)).toBe('blocked');
    expect(overviewState(report.checks[0]!,report)).toBe('checked');
    report.semantic.tasks[0]!.status='running';expect(overviewState(check,report)).toBe('running');
  });
  it("keeps the overview and reader mounted when project metadata arrives late or the same review binding is echoed",async()=>{
    const report=fixture(),binding={project_id:'a'.repeat(32),native_project_id:'native',run_id:report.run_id,session_key:'websocket:fin_'+'b'.repeat(32),chat_id:'fin_'+'b'.repeat(32)};
    let finishProject!:(v:unknown)=>void;
    const request=vi.fn((input:any)=>input.action==='project-list'?new Promise(resolve=>{finishProject=resolve;}):Promise.resolve(input.action==='consistency-read'?report:input.action==='consistency-editor'?{run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,proposals:{},decisions:{},history:[]}:{data_url:'data:image/png;base64,AA=='}));
    const client={financeReaderRequest:request,getFinanceCatalog:async()=>({reviews:[],unavailable:[],scope:'C2'})} as unknown as MemmyAgentClient;
    const div=document.createElement('div'),root=createRoot(div);
    const view=(initialReview:typeof binding)=><FinanceWorkspace visible client={client} initialPath={null} initialReview={initialReview} workflow={null} busy={false} onChoose={()=>{}} onLaunch={async()=>{}} onClose={()=>{}}/>;
    try{
      await act(async()=>root.render(view(binding)));
      const reader=div.querySelector('.consistency-reader');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='檢查總覽')!.click());
      const overview=div.querySelector('[aria-label="檢查總覽"]');
      await act(async()=>finishProject({projects:[{id:binding.project_id,title:'Late project',external_id:'native',revision:1,latest_run:report.run_id,created_at:'2031-01-01',updated_at:'2031-01-01',versions:[{id:'c'.repeat(32),fiscal_year:'2031/32',created_at:'2031-01-01',runs:[report.run_id],documents:[],reviews:[{run_id:report.run_id,kind:'consistency',status:'partial'}]}]}]}));
      expect(div.querySelector('.consistency-reader')).toBe(reader);expect(div.querySelector('[aria-label="檢查總覽"]')).toBe(overview);
      await act(async()=>root.render(view({...binding,session_key:'websocket:fin_'+'d'.repeat(32),chat_id:'fin_'+'d'.repeat(32)})));
      expect(div.querySelector('[aria-label="檢查總覽"]')).toBe(overview);
      expect(request.mock.calls.filter(([input])=>input.action==='consistency-read')).toHaveLength(1);
    }finally{act(()=>root.unmount());}
  });
  it("allows a follow-up while the chat is running and explains actual connection/model blockers",async()=>{
    const report=fixture(),request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='})),ask=vi.fn(async()=>{}),div=document.createElement('div'),root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request} onAsk={ask} busy askQueued/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      const queued=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='加入待答')!;
      expect(queued.disabled).toBe(false);expect(div.textContent).toContain('追問會排入此對話');
      await act(async()=>queued.click());expect(ask).toHaveBeenCalledOnce();
      await act(async()=>root.render(<ConsistencyReader report={report} request={request} onAsk={ask} askBlockedReason="對話尚未連線，連線恢復後即可送出。"/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      const send=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='送出')!;
      expect(send.disabled).toBe(true);expect(div.querySelector('.consistency-ask [role=status]')?.textContent).toContain('對話尚未連線');
      const recover=vi.fn();
      await act(async()=>root.render(<ConsistencyReader report={report} request={request} onAsk={ask} askBlockedReason="此對話的模型不可用。" askRecovery={{label:'重新選用 gpt-6.1-sol',onClick:recover}}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='重新選用 gpt-6.1-sol')!.click());
      expect(recover).toHaveBeenCalledOnce();expect(ask).toHaveBeenCalledOnce();
    }finally{act(()=>root.unmount());}
  });
  it("groups pending issues by the user's next action and keeps handled items separate",async()=>{
    const report=fixture(),base=report.checks[1]!;
    report.checks=[report.checks[0]!,...([['edit','修改索引'],['verify','確認年份'],['supplement','補充公式'],['edit','已處理問題']] as const).map(([action,title],i)=>({...base,id:'action-'+i,title,reader_copy:{title,problem:'具體問題。',next_step:'具體下一步。',action_kind:action}})),report.checks[2]!];
    const editor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:1,proposals:{},history:[],decisions:{'action-3':{status:'dismissed',at:'2031-01-01',edits:[]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div'),root=createRoot(div);
    const choose=async(value:string)=>{await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});};
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;
      expect(Array.from(select.options).map(option=>option.text)).toEqual(['全部待辦','修改文字','核實資料','補充說明','已處理','檢查記錄']);
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(3);
      expect(div.querySelector('[aria-label="按處理方式分類"]')?.textContent).toContain('全部待辦 3');
      for(const [value,title] of [['action-edit','修改索引'],['action-verify','確認年份'],['action-supplement','補充公式']]){
        await choose(value!);expect(div.querySelectorAll('.consistency-check')).toHaveLength(1);
        expect(div.querySelector('.consistency-check')?.textContent).toContain(title);
      }
      await choose('resolved');expect(div.querySelector('.consistency-check')?.textContent).toContain('已忽略');
      expect(request.mock.calls.some(([input])=>/decide|build|start/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());}
  });
  it("shows the quoted text when the PDF renderer cannot place its highlight",async()=>{
    const report=fixture(),div=document.createElement('div'),root=createRoot(div);
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?{run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,proposals:{},decisions:{},history:[]}:{data_url:'data:image/png;base64,AA==',highlight_status:'unlocated',unlocated_quotes:['Exact source sentence to verify.']});
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(div.querySelector('.consistency-highlight-notice')?.textContent).toContain('引用未能標示');
      expect(div.querySelector('.consistency-highlight-notice blockquote')?.textContent).toBe('Exact source sentence to verify.');
    }finally{act(()=>root.unmount());}
  });
  it("pairs Chinese and English sources when several citations share one language, and restores them on card navigation",async()=>{
    const report=fixture();
    report.checks[1]!.semantic_kind="bilingual";
    report.checks[1]!.refs=[{slot:"annual_zh",page:2,quote:"中文甲"},{slot:"annual_zh",page:3,quote:"中文乙"},{slot:"annual_en",page:2,quote:"English A"},{slot:"annual_en",page:3,quote:"English B"}];
    const div=document.createElement("div"),root=createRoot(div),request=vi.fn(async()=>({data_url:"data:image/png;base64,AA=="}));
    const sources=()=>Array.from(div.querySelectorAll<HTMLSelectElement>('[aria-label="引用文件"]')).map(e=>e.value);
    try {
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(sources()).toEqual(["annual_zh","annual_en"]);
      await act(async()=>{const right=div.querySelectorAll<HTMLSelectElement>('[aria-label="引用文件"]')[1]!;right.value="annual_zh";right.dispatchEvent(new Event("change",{bubbles:true}));});
      expect(sources()).toEqual(["annual_zh","annual_zh"]);
      await act(async()=>div.querySelector<HTMLButtonElement>('.consistency-check')!.click());
      expect(sources()).toEqual(["annual_zh","annual_en"]);
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      await act(async()=>div.querySelector('.consistency-source-panel--zh')!.querySelectorAll<HTMLButtonElement>('button')[1]!.click());
      expect(sources()).toEqual(["annual_zh","annual_en"]);
      expect(Array.from(div.querySelectorAll<HTMLInputElement>('[aria-label="引用 PDF 頁碼"]')).map(e=>e.value)).toEqual(["3","2"]);
      expect(request.mock.calls.some(([input]:any)=>input.action==='consistency-build'||input.action==='consistency-semantic-start')).toBe(false);
    }finally{act(()=>root.unmount());}
  });
  it.each(["bilingual","cross_report","restatement","internal"] as const)("selects the intended %s source pair independently of citation ordering",async kind=>{
    const report=fixture();
    report.documents.push({...report.documents[0]!,slot:"prior_esg_zh",label:"去年 ESG 繁中"});
    const refs:Record<typeof kind,ConsistencyReport['checks'][number]['refs']>={
      bilingual:[{slot:"esg_en",page:2,quote:"English"},{slot:"esg_en",page:3,quote:"English 2"},{slot:"esg_zh",page:3,quote:"中文"}],
      cross_report:[{slot:"annual_en",page:3,quote:"annual"},{slot:"annual_en",page:2,quote:"annual 2"},{slot:"esg_en",page:2,quote:"ESG"}],
      restatement:[{slot:"esg_zh",page:2,quote:"今年"},{slot:"esg_zh",page:3,quote:"今年2"},{slot:"prior_esg_zh",page:3,quote:"去年"}],
      internal:[{slot:"annual_zh",page:2,quote:"內文"},{slot:"annual_zh",page:3,quote:"附註"}],
    };
    const expected={bilingual:["esg_zh","esg_en"],cross_report:["esg_en","annual_en"],restatement:["esg_zh","prior_esg_zh"],internal:["annual_zh","annual_zh"]};
    report.checks[1]!.semantic_kind=kind;report.checks[1]!.refs=refs[kind];
    const div=document.createElement("div"),root=createRoot(div),request=vi.fn(async()=>({data_url:"data:image/png;base64,AA=="}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(Array.from(div.querySelectorAll<HTMLSelectElement>('[aria-label="引用文件"]')).map(e=>e.value)).toEqual(expected[kind]);
      if(kind==="internal")expect(Array.from(div.querySelectorAll<HTMLInputElement>('[aria-label="引用 PDF 頁碼"]')).map(e=>e.value)).toEqual(["2","3"]);
    }finally{act(()=>root.unmount());}
  });
  it("fits an entire page to the available reader height and returns independently to page width",async()=>{
    const div=document.createElement("div"),root=createRoot(div),request=vi.fn(async()=>({data_url:"data:image/png;base64,AA=="}));
    try {
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request}/>));
      const scroll=div.querySelector('.consistency-paper-scroll')!,img=div.querySelector('img')!;
      Object.defineProperties(scroll,{clientWidth:{value:416},clientHeight:{value:416}});
      Object.defineProperties(img,{naturalWidth:{value:600},naturalHeight:{value:1000}});
      await act(async()=>div.querySelector<HTMLButtonElement>('[aria-label="整頁顯示報告"]')!.click());
      expect(img.style.width).toBe('60%');expect(div.querySelectorAll('img')[1]!.style.width).toBe('100%');
      await act(async()=>div.querySelector<HTMLButtonElement>('[aria-label="報告適合寬度"]')!.click());
      expect(img.style.width).toBe('100%');
      expect(div.querySelectorAll('.consistency-paper-scroll[tabindex="0"]')).toHaveLength(2);
      expect(div.querySelector('[aria-label="本次檢查範圍"]')).toBeNull();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='檢查詳情')!.click());
      expect(div.querySelector('[aria-label="本次檢查範圍"]')).not.toBeNull();
    }finally{act(()=>root.unmount());}
  });
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
      expect(div.textContent).toContain("全部已上載PDF");expect(div.textContent).not.toContain("Word");
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
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='records';select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(div.querySelectorAll('.consistency-check')).toHaveLength(2);
      expect(div.querySelector('.consistency-check.candidate')).toBeNull();
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="檢查記錄分類"]')!;select.value='page_numbers';select.dispatchEvent(new Event('change',{bubbles:true}));});
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
  it.each([2,3])("reveals report citation %s from finding details and lets the user return to the selected finding",async citation=>{
    const report=fixture(),check=report.checks[1]!;
    check.semantic_kind='bilingual';
    check.refs=[{slot:'annual_zh',page:2,quote:'中文甲'},{slot:'annual_en',page:2,quote:'English A'},{slot:'annual_zh',page:3,quote:'中文乙'},{slot:'annual_en',page:3,quote:'English B'}];
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,proposals:{},decisions:{},history:[]};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      expect(dialog.getAttribute('aria-label')).toBe(check.title);
      request.mockClear();
      expect(dialog.querySelectorAll('.consistency-source-fragment')).toHaveLength(4);
      await act(async()=>dialog.querySelector(citation===2?'.consistency-source-panel--zh':'.consistency-source-panel--en')!.querySelectorAll<HTMLButtonElement>('button')[1]!.click());
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain(check.title);
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:report.run_id,slot:check.refs[citation]!.slot,page:3,check_id:check.id});
      expect(Array.from(div.querySelectorAll<HTMLInputElement>('[aria-label="引用 PDF 頁碼"]')).map(input=>input.value)).toEqual(citation===2?['3','2']:['2','3']);
      expect(div.querySelector(`img[alt="${check.refs[citation]!.slot} PDF 3"]`)).not.toBeNull();
      expect(document.activeElement).toBe(open);
      await act(async()=>open.click());
      expect(div.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(check.title);
      expect(request.mock.calls.some(([input])=>/build|start|decide|export/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());div.remove();}
  });
  it("keeps an unsaved replacement and confirmation when following a report citation and reopening details",async()=>{
    const report=fixture(),check=report.checks[1]!;
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,summary:'Confirm the proposed wording.',edits:[{slot:'esg_en',page:3,original:'The original report sentence.',replacement:'The suggested report sentence.'}]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:input.action==='consistency-decide'?{...editor,revision:1,decisions:{[check.id]:{status:'accepted',edits:input.edits,at:'2031-01-01'}}}:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      await act(async()=>dialog.querySelector('summary')!.click());
      const textarea=dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="建議寫法 1"]')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'My unsaved report wording.');
        textarea.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await act(async()=>dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(textarea.value).toBe('My unsaved report wording.');
      expect(Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent==='接受修改')!.disabled).toBe(false);
      await act(async()=>dialog.querySelector<HTMLButtonElement>('.consistency-values button')!.click());
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      await act(async()=>open.click());
      const reopened=div.querySelector('[role="dialog"]')!;
      expect(reopened.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('My unsaved report wording.');
      expect(reopened.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      expect(request.mock.calls.some(([input])=>input.action==='consistency-decide')).toBe(false);
      await act(async()=>Array.from(reopened.querySelectorAll('button')).find(button=>button.textContent==='接受修改')!.click());
      expect(request).toHaveBeenCalledWith({action:'consistency-decide',run_id:report.run_id,check_id:check.id,expected_revision:0,operation:'accept',proposal_id:'editable',facts_confirmed:true,edits:[{...editor.proposals[check.id]!.edits![0]!,replacement:'My unsaved report wording.'}]});
    }finally{act(()=>root.unmount());div.remove();}
  });
  it.each(['proposal identity','proposal content','source document','source snapshot','run','accept then undo','polled accept/undo history'])("does not revive a stale draft or confirmation after %s changes",async change=>{
    const report=fixture(),check=report.checks[1]!;
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,edits:[{slot:'esg_en',page:3,original:'The original report sentence.',replacement:'The suggested report sentence.'}]}}};
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn();
    const render=(r:ConsistencyReport,e:ConsistencyEditor,shown:boolean)=><ConsistencyEditDraftProvider key={r.run_id} report={r} editor={e}>{shown&&<ConsistencyEditCard report={r} check={r.checks[1]!} editor={e} request={request} onChange={()=>{}}/>}</ConsistencyEditDraftProvider>;
    try{
      await act(async()=>root.render(render(report,editor,true)));
      const textarea=div.querySelector<HTMLTextAreaElement>('textarea')!;
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Private unsaved wording.');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(textarea.value).toBe('Private unsaved wording.');
      await act(async()=>root.render(render(report,editor,false)));
      const changedReport=structuredClone(report),changedEditor=structuredClone(editor);
      if(change==='proposal identity')changedEditor.proposals[check.id]!.id='new-template';
      if(change==='proposal content')changedEditor.proposals[check.id]!.edits![0]!.replacement='A changed server suggestion.';
      if(change==='source document')changedReport.documents[0]!.sha256='b'.repeat(64);
      if(change==='source snapshot')changedEditor.base_sha256='b'.repeat(64);
      if(change==='run'){changedReport.run_id='20310102T000000-aabbccdd';changedEditor.run_id=changedReport.run_id;}
      if(change==='accept then undo'){
        changedEditor.revision=1;changedEditor.decisions[check.id]={status:'accepted',edits:[],at:'2031-01-01'};
      }
      if(change==='polled accept/undo history'){
        changedEditor.revision=2;changedEditor.history=[{check_id:check.id,revision:1,operation:'accept'},{check_id:check.id,revision:2,operation:'undo'}];
      }
      await act(async()=>root.render(render(changedReport,changedEditor,false)));
      const finalEditor=change==='accept then undo'?{...editor,revision:2,history:[{check_id:check.id,revision:2,operation:'undo'}]}:change==='polled accept/undo history'?changedEditor:editor;
      await act(async()=>root.render(render(report,finalEditor,true)));
      expect(div.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('The suggested report sentence.');
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
      expect(request).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());}
  });
  it.each(['report check','derived edit check'])("invalidates an old fact confirmation when displayed context changes in the %s",async kind=>{
    const report=fixture(),check=report.checks[1]!;
    check.reader_copy={title:check.title,problem:check.reason,next_step:'Confirm the original reporting boundary.'};
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,edits:[{slot:'esg_en',page:3,original:'The original report sentence.',replacement:'Suggested.'}]}}};
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn();
    const render=(r:ConsistencyReport,c:ConsistencyReport['checks'][number],shown:boolean)=><ConsistencyEditDraftProvider report={r} editor={editor}>{shown&&<ConsistencyEditCard report={r} check={c} editor={editor} request={request} onChange={()=>{}}/>}</ConsistencyEditDraftProvider>;
    try{
      await act(async()=>root.render(render(report,check,true)));
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      await act(async()=>root.render(render(report,check,false)));
      const changedReport=structuredClone(report),changedCheck=structuredClone(check);
      changedCheck.reader_copy!.next_step='Confirm the revised reporting boundary.';
      if(kind==='report check')changedReport.checks[1]=changedCheck;
      await act(async()=>root.render(render(changedReport,changedCheck,true)));
      expect(div.textContent).toContain('Confirm the revised reporting boundary.');
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
      await act(async()=>root.render(render(report,check,true)));
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
      expect(request).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());}
  });
  it("does not let an old decision completion erase a newer post-undo draft",async()=>{
    const report=fixture(),check=report.checks[1]!;
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,edits:[{slot:'esg_en',page:3,original:'The original report sentence.',replacement:'Suggested.'}]}}};
    let complete!:(value:ConsistencyEditor)=>void;
    const request=vi.fn(()=>new Promise<ConsistencyEditor>(resolve=>{complete=resolve;})),onChange=vi.fn();
    const div=document.createElement('div'),root=createRoot(div);
    const render=(e:ConsistencyEditor,shown:boolean)=><ConsistencyEditDraftProvider report={report} editor={e}>{shown&&<ConsistencyEditCard report={report} check={check} editor={e} request={request} onChange={onChange}/>}</ConsistencyEditDraftProvider>;
    const type=async(text:string)=>{await act(async()=>{const textarea=div.querySelector<HTMLTextAreaElement>('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,text);textarea.dispatchEvent(new Event('input',{bubbles:true}));});};
    try{
      await act(async()=>root.render(render(editor,true)));
      await type('An older submitted replacement.');
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      await act(async()=>Array.from(div.querySelectorAll('button')).find(button=>button.textContent==='接受修改')!.click());
      expect(request).toHaveBeenCalledTimes(1);
      await act(async()=>root.render(render(editor,false)));
      const undone={...editor,revision:2,history:[{check_id:check.id,revision:1,operation:'accept'},{check_id:check.id,revision:2,operation:'undo'}]};
      await act(async()=>root.render(render(undone,true)));
      await type('A newer unsaved replacement after undo.');
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      await act(async()=>complete({...editor,revision:1,decisions:{[check.id]:{status:'accepted',edits:[],at:'2031-01-01'}}}));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({revision:1}));
      expect(div.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('A newer unsaved replacement after undo.');
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    }finally{act(()=>root.unmount());}
  });
  it("keeps a draft when an unrelated finding's decision changes",async()=>{
    const report=fixture(),check=report.checks[1]!;
    const editor:ConsistencyEditor={run_id:report.run_id,base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,edits:[{slot:'esg_en',page:3,original:'The original report sentence.',replacement:'The suggested report sentence.'}]}}};
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn();
    const render=(e:ConsistencyEditor,shown:boolean)=><ConsistencyEditDraftProvider report={report} editor={e}>{shown&&<ConsistencyEditCard report={report} check={check} editor={e} request={request} onChange={()=>{}}/>}</ConsistencyEditDraftProvider>;
    try{
      await act(async()=>root.render(render(editor,true)));
      const textarea=div.querySelector<HTMLTextAreaElement>('textarea')!;
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Keep this unsaved wording.');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
      await act(async()=>div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      await act(async()=>root.render(render(editor,false)));
      const other={...editor,revision:1,history:[{check_id:'another-finding',revision:1,operation:'dismiss'}]};
      await act(async()=>root.render(render(other,true)));
      expect(div.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this unsaved wording.');
      expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      expect(request).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());}
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
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="一致性項目分類"]')!;select.value='records';select.dispatchEvent(new Event('change',{bubbles:true}));});
      await act(async()=>{const select=div.querySelector<HTMLSelectElement>('[aria-label="檢查記錄分類"]')!;select.value='not_checked';select.dispatchEvent(new Event('change',{bubbles:true}));});
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
      expect(div.textContent).toContain('內文核對完成');expect(div.textContent).not.toContain('1項需處理');
      expect(div.querySelector('progress')).toBeNull();
      expect(div.textContent).toContain('核對已結束 · 2/2步成功');
    } finally{act(()=>root.unmount());vi.useRealTimers();}
  });
  it("continues a failed final verification at 4/5 without rebuilding the report or resetting progress",async()=>{
    vi.useFakeTimers();const div=document.createElement('div'),root=createRoot(div);
    const failed={...fixture(),semantic:{status:'failed' as const,job_id:'saved-job',model:'test-model',reasoning_effort:'xhigh',context_tokens:1000000,
      completed_tasks:4,total_tasks:5,updated_at:'2031-01-01',phase:'覆核差異及反證',error:'模型串流中斷，未收到完成結果。',gaps:[],findings_count:0,matched_count:0,
      tasks:(["bilingual","cross_report","internal","restatement"] as const).map(id=>({id,label:id,status:'completed' as const,submitted_pages:12}))}};
    const running={...failed,semantic:{...failed.semantic,status:'running' as const,job_id:'resumed-job',error:undefined,phase:'繼續最後覆核'}};
    const editor={run_id:failed.run_id,base_sha256:'a'.repeat(64),revision:3,proposals:{},decisions:{basis:{status:'accepted',edits:[],at:'2031-01-01'}},history:[]};
    const request=vi.fn(async(input:any)=>input.action==='consistency-semantic-start'?running:input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    try {
      await act(async()=>root.render(<ConsistencyReader report={failed} request={request}/>));
      expect(div.textContent).toContain('最後覆核中斷，前面結果已保留');
      expect(div.textContent).toContain('已保存 4/5 步，毋須重新上載');
      expect(div.textContent).toContain('已接受 1');
      expect(div.querySelector('[aria-label="覆核差異：未完成"]')).not.toBeNull();
      expect(div.querySelector('[aria-label="覆核差異：核對中"]')).toBeNull();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='繼續最後覆核')!.click());
      expect(request).toHaveBeenCalledWith({action:'consistency-semantic-start',run_id:failed.run_id});
      expect(request.mock.calls.some(([input])=>input.action==='consistency-build')).toBe(false);
      expect(div.textContent).toContain('步驟進度 80%');expect(div.querySelector('progress')?.value).toBe(4);
      expect(div.textContent).toContain(`${failed.coverage.metric_checks}組中英指標`);
      expect(div.textContent).toContain('已接受 1');
      expect(request.mock.calls.some(([input])=>input.action==='consistency-decide')).toBe(false);
      expect(Array.from(div.querySelectorAll('button')).some(b=>b.textContent==='繼續最後覆核')).toBe(false);
    }finally{act(()=>root.unmount());vi.useRealTimers();}
  });
  it("offers continue for an unfinished comparison rather than claiming only final verification remains",async()=>{
    const div=document.createElement('div'),root=createRoot(div);
    const report={...fixture(),semantic:{status:'partial' as const,job_id:'saved-job',model:'test-model',reasoning_effort:'xhigh',context_tokens:1000000,
      completed_tasks:1,total_tasks:2,updated_at:'2031-01-01',gaps:[],findings_count:0,matched_count:0,
      tasks:[{id:'bilingual' as const,label:'中英文意思',status:'failed' as const,submitted_pages:12}]}};
    try {
      await act(async()=>root.render(<ConsistencyReader report={report} request={vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}))}/>));
      expect(Array.from(div.querySelectorAll('button')).some(b=>b.textContent==='繼續核對')).toBe(true);
      expect(Array.from(div.querySelectorAll('button')).some(b=>b.textContent==='繼續最後覆核')).toBe(false);
    }finally{act(()=>root.unmount());}
  });
  it("distinguishes a finished review with an unresolved diagram from a stopped job",async()=>{
    const div=document.createElement('div'),root=createRoot(div);
    const report={...fixture(),semantic:{status:'partial' as const,job_id:'saved-job',model:'test-model',reasoning_effort:'xhigh',context_tokens:1000000,
      completed_tasks:2,total_tasks:2,updated_at:'2031-01-01',gaps:['第6頁圖中點位未能核實。'],findings_count:1,matched_count:3,
      tasks:[{id:'internal' as const,label:'內文前後',status:'completed' as const,submitted_pages:12}]}};
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}))}/>));
      expect(div.textContent).toContain('核對已結束 · 1項未能核實');
      expect(div.textContent).toContain('未核實範圍（1）');expect(div.textContent).toContain('第6頁圖中點位未能核實。');
      expect(Array.from(div.querySelectorAll('button')).some(b=>b.textContent==='繼續核對')).toBe(false);
    }finally{act(()=>root.unmount());}
  });
});
