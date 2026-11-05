// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {describe,it,expect,vi} from "vitest";
import {ConsistencyReader} from "../finance-consistency-view.js";
import {C2StatusPanel} from "../c2-review-controls.js";
import {FinanceProjectSetup} from "../finance-project-setup.js";
import {FinanceWorkspace} from "../finance-workspace.js";
import type {ConsistencyReport,FinanceProject} from "@memmy/local-api-contracts";
import type {MemmyAgentClient} from "../../api/memmy-agent-client.js";
import {overviewState} from "../consistency-overview.js";
import {c2Progress} from "../c2-progress.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const run='20310101T000000-aabbccdd',hash='a'.repeat(64),pid='b'.repeat(32),vid='c'.repeat(32);
// Mock input-preview contract; live KB and PDF recognition are checked separately.
const inputKnowledge={entity_id:'yeebo',entity_name:'億都',observed_at:'2031-01-01',catalog_revision:'mock',documents:[{source_id:'mock-prior',file_name:'2030-31-esg-en.pdf',sha256:hash,fiscal_year:'2030/31',kind:'esg',language:'en',original_status:'verified',indexed_status:'verified'}]};
function fixture():ConsistencyReport{
  const check=(id:string,outcome:'not_located'|'disclosed'|'external_evidence_needed')=>({id,category:'regulatory' as const,status:outcome==='disclosed'?'matched' as const:'pending' as const,review_state:outcome==='disclosed'?'matched' as const:outcome==='not_located'?'needs_confirmation' as const:'not_checked' as const,title:id,reason:'請補董事會的監督角色。',refs:[],regulatory:{id,clause:'13(i)',part:'B' as const,label:id,rule_page:5,rule_quote:'a disclosure of the board oversight',criteria:'董事會監督',kind:'disclosure',condition:'always',obligation:'mandatory',outcome,action:'請加入董事會監督聲明。',missing_elements:outcome==='not_located'?['監督角色']:[]}});
  return {schema_version:'financebuddy-consistency-1',run_id:run,fiscal_year:'2031/32',created_at:'2031-01-01',documents:[{slot:'esg_en',label:'ESG English',file_name:'current.pdf',sha256:hash,page_count:3,cover_year_found:true,identity_confirmed:true,textless_pages:[]}],comparisons:['internal'],history:{status:'not_requested',fiscal_year:'2030/31',source:'WeKnora'},checks:[check('欠董事會監督','not_located'),check('已有目標','disclosed'),check('待補年報','external_evidence_needed')],coverage:{scanned_pages:3,page_pairs:0,same_numeric_inventory_pages:0,metric_checks:0,numeric_facts:0,matched:0,differences:0,pending:0,historical_pages:0,internal_checks:0,restatement_checks:0},all_numbers_confirmed:false,all_basis_confirmed:false,limits:[],
   compliance:{status:'completed',profile:{period_start:'2031-04-01',period_end:'2032-03-31',part_d_mandatory:'unknown',primary_esg_slot:'esg_en'},model:'gpt-6.1-sol',reasoning_effort:'xhigh',context_tokens:1000000,started_at:'2031-01-01',updated_at:'2031-01-01',completed_tasks:3,total_tasks:3,gaps:[],tasks:[{id:'general',label:'董事會',status:'completed',phase:'已完成',completed_passes:2}],rule_freshness:{status:'full_text_matches',checked_at:'2031-01-01',url:'https://example.test/rules.pdf'},catalog_revision:'fixture',rulebook:{file_name:'rules.pdf',sha256:hash,text_sha256:hash,page_count:27,url:'https://example.test/rules',pdf_url:'https://example.test/rules.pdf'},coverage:{inventory_units:3,checks_total:3,checks_reviewed:3,outcomes:{not_located:1,disclosed:1,external_evidence_needed:1},parts:[{part:'B',total:3,reviewed:3}]},scope_note:'fixture'}};
}
describe('Full C2 project workflow',()=>{
  it('shows a concise fact-check action for external evidence, folds the full analysis and deduplicates page citations',async()=>{
    const report=fixture(),div=document.createElement('div'),root=createRoot(div);
    const check={...report.checks[2]!,id:'publication',title:'年度發布及兩個網站刊載',reason:'年報只載將上傳至聯交所及公司網站，未提供正式刊載日期或本年度報告連結。待刊計劃不能證明已完成刊載，也不能據此判定已違規。',reader_copy:{title:'確認報告是否已刊載',problem:'年報只寫計劃上載，未能確認實際刊載情況。',next_step:'已刊載：提供日期及兩個網站連結；未刊載：確認發布安排。',action_kind:'verify' as const},refs:[{slot:'esg_en' as const,page:1,quote:'The report will be uploaded.'},{slot:'esg_en' as const,page:1,quote:'The company and Exchange websites.'}],regulatory:{...report.checks[2]!.regulatory!,clause:'4(1)-publication',missing_elements:['核對正式刊載日期','提供兩個網站連結','尚未刊載則確認安排']}};
    report.checks=[check];
    const editor={run_id:run,base_sha256:hash,revision:0,decisions:{},history:[],proposals:{publication:{id:'advice',status:'ready',updated_at:'2031-01-01',summary:'Long old action.',requires_confirmation:true,confirmation_prompt:'Old long question.',edits:[]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(div.querySelector('.consistency-check strong')!.textContent).toBe('確認報告是否已刊載');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      expect(dialog.querySelector('.c2-brief-problem p')!.textContent).toBe(check.reader_copy.problem);
      expect(dialog.querySelector('.consistency-edit-card p')!.textContent).toBe(check.reader_copy.next_step);
      expect(dialog.querySelector('.consistency-edit-card')!.textContent).toContain('只需核實');
      expect(dialog.querySelector('.consistency-edit-card')!.textContent).not.toContain('接受修改');
      expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
      const details=dialog.querySelector<HTMLDetailsElement>('.c2-full-analysis')!;
      expect(details.open).toBe(false);expect(details.textContent).toContain(check.reason);
      expect(details.querySelectorAll('li')).toHaveLength(3);
      expect(dialog.querySelector('.c2-rule-citation ul')).toBeNull();
      expect(dialog.querySelectorAll('.c2-brief-sources .consistency-values button')).toHaveLength(1);
      expect(request.mock.calls.some(([input])=>/build|start|decide/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());}
  });
  it('updates an open overview from active and queued checks to published results without marking the second pass as done early',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2031-01-01T00:04:00Z'));
    const report=fixture(),div=document.createElement('div'),root=createRoot(div);
    report.checks=report.checks.map(c=>({...c,status:'pending',review_state:'not_checked',reason:'尚未有核對結果。',regulatory:{...c.regulatory!,outcome:'not_reviewed'}}));
    const [a,b,c]=report.checks.map(c=>c.id);
    report.compliance={...report.compliance!,status:'running',completed_tasks:1,total_tasks:7,started_at:'2031-01-01T00:00:00Z',updated_at:'2031-01-01T00:04:00Z',coverage:{...report.compliance!.coverage,checks_reviewed:0},tasks:[
      {id:'general',label:'報告原則',status:'running',phase:'逐項核對',completed_passes:0,check_ids:[a!]},{id:'environment',label:'環境',status:'pending',phase:'待核對',completed_passes:0,check_ids:[b!]},{id:'social',label:'社會',status:'pending',phase:'待核對',completed_passes:0,check_ids:[c!]}]};
    const next=structuredClone(report);next.compliance!.tasks[0]!.status='completed';next.compliance!.tasks[0]!.completed_passes=2;
    next.compliance!.tasks[1]!.status='running';next.compliance!.tasks[1]!.completed_passes=1;next.compliance!.tasks[1]!.phase='覆核證據及反證';
    next.compliance!.coverage.checks_reviewed=1;next.checks[0]!.regulatory!.outcome='disclosed';next.checks[0]!.status='matched';next.checks[0]!.review_state='matched';
    const editor={run_id:run,base_sha256:hash,revision:0,proposals:{},decisions:{},history:[]};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:input.action==='consistency-read'?next:{data_url:'data:image/png;base64,AA=='});
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(overviewState(report.checks[0]!,report)).toBe('running');expect(overviewState(report.checks[1]!,report)).toBe('not_started');
      const live=()=>div.querySelector('[aria-label="即時項目進度"]')!.textContent;
      expect(live()).toContain('初核中 1');expect(live()).toContain('排隊 2');expect(live()).toContain('已出結果 0');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='檢查總覽')!.click());
      const overview=div.querySelector('[aria-label="檢查總覽"]')!;
      expect(overview.querySelector('[aria-label="檢查狀態總數"]')!.textContent).toContain('檢查中 1');
      expect(overview.querySelector('[aria-label="檢查狀態總數"]')!.textContent).toContain('排隊 2');
      await act(async()=>vi.advanceTimersByTimeAsync(5000));
      expect(request).toHaveBeenCalledWith({action:'consistency-read',run_id:run});
      expect(div.querySelector('[aria-label="檢查總覽"]')).toBe(overview);
      expect(live()).toContain('已出結果 1');expect(live()).toContain('覆核中 1');expect(live()).toContain('排隊 1');
      expect(overview.querySelector('[aria-label="檢查狀態總數"]')!.textContent).toContain('有披露證據 1');
      expect(overview.querySelector('[aria-label="總覽即時進度"]')!.textContent).toContain('已出結果 1/3');
      expect(overviewState(next.checks[1]!,next)).toBe('running');expect(next.checks[1]!.regulatory!.outcome).toBe('not_reviewed');
      expect(request.mock.calls.some(([input])=>/start|build|decide/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());vi.useRealTimers();}
  });
  it('keeps percentages tied to real completed passes while elapsed and activity age update',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2031-01-01T00:04:00Z'));
    const report=fixture(),div=document.createElement('div'),root=createRoot(div);
    report.checks=report.checks.map(c=>({...c,regulatory:{...c.regulatory!,outcome:'not_reviewed'}}));
    report.compliance={...report.compliance!,status:'running',started_at:'2031-01-01T00:00:00Z',updated_at:'2031-01-01T00:04:00Z',coverage:{...report.compliance!.coverage,checks_reviewed:0},tasks:[{id:'general',label:'董事會',status:'running',phase:'逐項核對',completed_passes:0,check_ids:report.checks.map(c=>c.id),activity:{stage:'receiving',updated_at:'2031-01-01T00:04:00Z',received_chars:2000}}]};
    try{
      await act(async()=>root.render(<C2StatusPanel report={report} request={vi.fn()} onChange={vi.fn()}/>));
      expect(c2Progress(report).percent).toBe(0);expect(div.textContent).toContain('正在接收結果 · 2,000字元');
      await act(async()=>vi.advanceTimersByTimeAsync(60000));
      expect(div.querySelector('progress')!.value).toBe(0);expect(div.textContent).toContain('最近回傳 1分0秒前');
      expect(div.textContent).toContain('本次用時 5分0秒');
    }finally{act(()=>root.unmount());vi.useRealTimers();}
  });
  it('shows C2 evidence, missing disclosures, external-data blockers and unreviewed clauses separately in the overview',async()=>{
    const report=fixture(),div=document.createElement('div'),root=createRoot(div);
    const unreviewed={...report.checks[0]!,id:'尚未審閱',title:'尚未審閱',reason:'尚未開始核對。',regulatory:{...report.checks[0]!.regulatory!,outcome:'not_reviewed' as const}};
    const notApplicable={...unreviewed,id:'不適用',title:'不適用',regulatory:{...unreviewed.regulatory,outcome:'not_applicable' as const}};
    report.checks.push(unreviewed,notApplicable);
    expect(report.checks.map(c=>overviewState(c,report))).toEqual(['verify','checked','blocked','not_started','not_applicable']);
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?{run_id:run,base_sha256:hash,revision:0,proposals:{},decisions:{},history:[]}:{data_url:'data:image/png;base64,AA=='});
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='檢查總覽')!.click());
      const overview=div.querySelector('[aria-label="檢查總覽"]')!;
      expect(overview.querySelector('[aria-label="檢查狀態總數"]')?.textContent).toContain('全部 5');
      expect(overview.textContent).toContain('C2 D · 氣候披露');expect(overview.textContent).toContain('有披露證據不代表已核實底稿');
      expect(overview.textContent).not.toContain('全部合規');
    }finally{act(()=>root.unmount());}
  });
  const c2run='20310201T000000-11223344',newvid='d'.repeat(32);
  function mixedProject():FinanceProject {
    const version={id:vid,fiscal_year:'2031/32',created_at:'2031-01-01',runs:[run,c2run],reviews:[{run_id:run,kind:'consistency' as const,status:'completed' as const},{run_id:c2run,kind:'c2' as const,status:'partial' as const}],documents:[{slot:'esg_en' as const,file_name:'current.pdf',sha256:hash,bytes:1000}]};
    return {id:pid,title:'億都',external_id:null,revision:1,active_version:newvid,latest_run:c2run,created_at:'2031-01-01',updated_at:'2031-01-01',versions:[version,{...version,id:newvid,runs:[],reviews:[]}]};
  }
  it.each(['consistency','c2'] as const)('opens only the saved %s result for the selected older document version, without a model call',async(kind)=>{
    localStorage.clear();const div=document.createElement('div'),root=createRoot(div),complete=vi.fn(),project=mixedProject(),report=fixture();
    report.run_id=kind==='c2'?c2run:run;if(kind==='consistency')delete report.compliance;
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?inputKnowledge:input.action==='project-list'?{projects:[project]}:report);
    try{
      await act(async()=>root.render(<FinanceProjectSetup initialMode={kind} initialSelection={{project_id:pid,version_id:vid}} client={{} as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(div.querySelector<HTMLSelectElement>('[aria-label="項目報告版本"]')!.value).toBe(vid);
      expect(div.querySelector('.finance-review-mode')).toBeNull();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent===`開啟${kind==='c2'?'C2 披露檢查':'一致性審閱'}結果`)!.click());
      expect(request.mock.calls.map(c=>c[0])).toEqual([{action:'input-knowledge'},{action:'project-list'},{action:'input-knowledge',fiscal_year:'2031/32',slots:['esg_en']},{action:'consistency-read',run_id:kind==='c2'?c2run:run}]);
      expect(complete).toHaveBeenCalledWith(report,project);
    }finally{act(()=>root.unmount());}
  });
  it('keeps a C2-only run out of consistency history and carries the same version to the other setup',async()=>{
    const div=document.createElement('div'),root=createRoot(div),project=mixedProject(),switchTask=vi.fn();
    project.versions[0]!.reviews=project.versions[0]!.reviews!.filter(r=>r.kind==='c2');
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?inputKnowledge:{projects:[project]});
    try{
      await act(async()=>root.render(<FinanceProjectSetup initialMode="consistency" initialSelection={{project_id:pid,version_id:vid}} client={{} as MemmyAgentClient} request={request} onSwitch={switchTask} onComplete={vi.fn()}/>));
      expect(div.textContent).not.toContain('開啟一致性審閱結果');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent?.includes('前往C2 披露檢查'))!.click());
      expect(switchTask).toHaveBeenCalledWith('c2',project,vid);expect(request.mock.calls.map(([input])=>input.action)).toEqual(['input-knowledge','project-list','input-knowledge']);
    }finally{act(()=>root.unmount());}
  });
  it('navigates between saved results without rebuilding or combining result lists',async()=>{
    const div=document.createElement('div'),root=createRoot(div),project=mixedProject(),review=fixture(),consistency=fixture();
    review.run_id=c2run;delete consistency.compliance;consistency.checks=[];
    const binding={project_id:pid,native_project_id:'native',run_id:run,session_key:'websocket:fin_'+'a'.repeat(32),chat_id:'fin_'+'a'.repeat(32)};
    const opened=vi.fn(),launch=vi.fn();
    const request=vi.fn(async(input:any)=>input.action==='project-list'?{projects:[project]}:input.action==='consistency-read'?input.run_id===c2run?review:consistency:input.action==='project-open'?{binding:{...binding,run_id:c2run}}:input.action==='consistency-editor'?{run_id:input.run_id,base_sha256:hash,revision:0,proposals:{},decisions:{},history:[]}:{data_url:'data:image/png;base64,AA=='});
    const client={financeReaderRequest:request,getFinanceCatalog:async()=>({reviews:[],unavailable:[],scope:'C2'})} as unknown as MemmyAgentClient;
    try{
      await act(async()=>root.render(<FinanceWorkspace visible client={client} initialPath={null} initialReview={binding} workflow={null} busy={false} onChoose={vi.fn()} onReviewOpened={opened} onLaunch={launch} onClose={vi.fn()}/>));
      const nav=div.querySelector('[aria-label="此版本的檢查工作"]')!;
      expect(nav.textContent).toContain('文件版本 1');
      await act(async()=>Array.from(nav.querySelectorAll('button')).find(b=>b.textContent?.includes('C2 披露檢查'))!.click());
      expect(div.querySelector('.finance-header h2')?.textContent).toContain('C2 披露檢查');
      expect(div.querySelector('[aria-label="C2核對項目"]')).not.toBeNull();expect(div.querySelector('[aria-label="一致性核對項目"]')).toBeNull();
      expect(request).toHaveBeenCalledWith({action:'consistency-read',run_id:c2run});
      expect(request.mock.calls.some(c=>/build|start/.test(c[0].action))).toBe(false);expect(launch).not.toHaveBeenCalled();expect(opened).toHaveBeenCalledOnce();
    }finally{act(()=>root.unmount());}
  });
  it('starts the full C2 workflow using one saved English ESG without another upload',async()=>{
    localStorage.clear();const div=document.createElement('div'),root=createRoot(div),upload=vi.fn(),complete=vi.fn(),report=fixture();
    const project:FinanceProject={id:pid,title:'億都',external_id:null,revision:1,active_version:vid,latest_run:null,created_at:'2031-01-01',updated_at:'2031-01-01',versions:[{id:vid,fiscal_year:'2031/32',created_at:'2031-01-01',runs:[],documents:[{slot:'esg_en',file_name:'current.pdf',sha256:hash,bytes:1000}]}]};
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?inputKnowledge:input.action==='project-list'?{projects:[project]}:input.action==='project-build'?{project,report}:{...report});
    try{
      await act(async()=>root.render(<FinanceProjectSetup initialMode="c2" initialSelection={{project_id:pid,version_id:vid}} client={{uploadAgentMedia:upload} as unknown as MemmyAgentClient} request={request} onComplete={complete}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='開始 C2 披露檢查')!.click());
      expect(request).toHaveBeenCalledWith({action:'project-build',project_id:pid,version_id:vid,kind:'c2',comparisons:['internal','restatement']});
      expect(request).toHaveBeenCalledWith({action:'c2-start',run_id:run,profile:{period_start:'2031-04-01',period_end:'2032-03-31',part_d_mandatory:'unknown',primary_esg_slot:'esg_en'}});
      expect(request).not.toHaveBeenCalledWith(expect.objectContaining({action:'consistency-semantic-start'}));
      expect(upload).not.toHaveBeenCalled();expect(complete).toHaveBeenCalledOnce();
    }finally{act(()=>root.unmount());}
  });
  it('starts saved C2 with current-only sources when exact previous originals are unavailable',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture(),complete=vi.fn();
    const project:FinanceProject={id:pid,title:'億都',external_id:null,revision:1,active_version:vid,latest_run:null,created_at:'2031-01-01',updated_at:'2031-01-01',versions:[{id:vid,fiscal_year:'2031/32',created_at:'2031-01-01',runs:[],documents:[{slot:'esg_en',file_name:'current.pdf',sha256:hash,bytes:1000}]}]};
    const request=vi.fn(async(input:any)=>input.action==='input-knowledge'?{...inputKnowledge,documents:[]}:input.action==='project-list'?{projects:[project]}:input.action==='project-build'?{project,report}:report);
    try{
      await act(async()=>root.render(<FinanceProjectSetup initialMode="c2" initialSelection={{project_id:pid,version_id:vid}} client={{} as MemmyAgentClient} request={request} onComplete={complete}/>));
      expect(div.querySelector('.finance-input-plan')?.textContent).toContain('缺少 FY2030/31');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='開始 C2 披露檢查')!.click());
      expect(request).toHaveBeenCalledWith({action:'project-build',project_id:pid,version_id:vid,kind:'c2',comparisons:['internal']});
      expect(complete).toHaveBeenCalledOnce();
    }finally{act(()=>root.unmount());}
  });
  it('shows missing disclosures separately from evidence and opens the rule PDF in the reader',async()=>{
    const div=document.createElement('div'),root=createRoot(div),request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try{
      await act(async()=>root.render(<ConsistencyReader report={fixture()} request={request}/>));
      expect(div.querySelector('.consistency-check-list')?.textContent).toContain('欠董事會監督');
      expect(div.querySelector('.consistency-check-list')?.textContent).not.toContain('已有目標');
      expect(div.textContent).toContain('官方全文版本已核對');expect(div.textContent).not.toContain('本次未執行');
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='詳細／建議')!.click());
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='C2 13(i) · 規則 p.5')!.click());
      expect(request).toHaveBeenCalledWith({action:'c2-rule-page',run_id:run,page:5});
      expect(document.body.querySelector('.c2-rule-backdrop img[alt="HKEX C2 規則 PDF 5"]')).not.toBeNull();
      expect(div.querySelector('.c2-rule-backdrop')).toBeNull();
      expect(div.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('欠董事會監督');
      await act(async()=>document.body.querySelector<HTMLButtonElement>('.c2-rule-backdrop [aria-label="關閉規則原文"]')!.click());
      expect(div.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('欠董事會監督');
      expect(div.textContent).toContain('強制披露');expect(div.textContent).not.toContain('全部合規');
    }finally{act(()=>root.unmount());}
  });
  it('uses one full-width report for C2 and switches between cited pages instead of duplicating the document',async()=>{
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div),report=fixture();
    report.checks[0]!.refs=[{slot:'esg_en',page:1,quote:'Board oversight'},{slot:'esg_en',page:2,quote:'Review procedure'}];
    const request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(div.querySelectorAll('.consistency-paper-pane')).toHaveLength(1);
      const evidence=div.querySelector<HTMLSelectElement>('[aria-label="C2引用原文"]')!;
      expect(evidence.options[1]!.text).toContain('p.2');
      await act(async()=>{evidence.value='1';evidence.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:run,slot:'esg_en',page:2,check_id:report.checks[0]!.id});
      expect(div.querySelectorAll('.consistency-paper-pane')).toHaveLength(1);
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent?.includes('ESG English p.1'))!.click());
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain('欠董事會監督');
      expect(document.activeElement).toBe(open);
      expect(div.querySelector<HTMLInputElement>('[aria-label="引用 PDF 頁碼"]')?.value).toBe('1');
      await act(async()=>open.click());
      expect(div.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('欠董事會監督');
      request.mockClear();
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent?.includes('ESG English p.2'))!.click());
      expect(request).toHaveBeenCalledWith({action:'consistency-page',run_id:run,slot:'esg_en',page:2,check_id:report.checks[0]!.id});
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      expect(div.querySelector('.consistency-check.selected')?.textContent).toContain('欠董事會監督');
      expect(request.mock.calls.some(([input])=>/build|start|decide|export/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());div.remove();}
  });
  it('keeps an unsaved C2 replacement and confirmation across report-citation navigation',async()=>{
    const report=fixture(),check=report.checks[0]!;
    check.refs=[{slot:'esg_en',page:1,quote:'Board oversight'}];
    const editor={run_id:run,base_sha256:hash,revision:0,history:[],decisions:{},proposals:{[check.id]:{id:'editable-c2',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,summary:'Confirm oversight wording.',edits:[{slot:'esg_en',page:1,original:'The original oversight sentence.',replacement:'The suggested oversight sentence.'}]}}};
    const request=vi.fn(async(input:any)=>input.action==='consistency-editor'?editor:{data_url:'data:image/png;base64,AA=='});
    const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      const open=div.querySelector<HTMLButtonElement>('.consistency-open-issue')!;
      open.focus();await act(async()=>open.click());
      const dialog=div.querySelector('[role="dialog"]')!;
      const textarea=dialog.querySelector<HTMLTextAreaElement>('textarea')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'My unsaved oversight wording.');
        textarea.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await act(async()=>dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(textarea.value).toBe('My unsaved oversight wording.');
      await act(async()=>dialog.querySelector<HTMLButtonElement>('.c2-brief-sources .consistency-values button')!.click());
      expect(div.querySelector('[role="dialog"]')).toBeNull();
      await act(async()=>open.click());
      const reopened=div.querySelector('[role="dialog"]')!;
      expect(reopened.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('My unsaved oversight wording.');
      expect(reopened.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
      expect(request.mock.calls.some(([input])=>input.action==='consistency-decide')).toBe(false);
    }finally{act(()=>root.unmount());div.remove();}
  });
  it('resumes the saved C2 run with its original applicability profile and no rebuild',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture(),change=vi.fn();
    report.compliance!.status='failed';report.compliance!.tasks[0]!.status='failed';
    const request=vi.fn(async()=>fixture());
    try{
      await act(async()=>root.render(<C2StatusPanel report={report} request={request} onChange={change}/>));
      await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='繼續未完成部分')!.click());
      expect(request).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledWith({action:'c2-start',run_id:run,profile:report.compliance!.profile});expect(change).toHaveBeenCalledOnce();
    }finally{act(()=>root.unmount());}
  });
  it('explains a citation failure separately from report findings and retains the reviewed count',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture();
    report.compliance!.status='partial';report.compliance!.tasks[0]!.status='failed';
    report.compliance!.tasks[0]!.error='C2引用未能在指定原頁定位。';report.compliance!.coverage.checks_reviewed=2;
    try{
      await act(async()=>root.render(<C2StatusPanel report={report} request={vi.fn()} onChange={vi.fn()}/>));
      expect(div.textContent).toContain('1項未完成，已完成結果保留');
      expect(div.textContent).toContain('模型引文未能對上報告原頁，相關項目尚未有結論。');
      expect(div.textContent).toContain('已核對 2/3 項');
    }finally{act(()=>root.unmount());}
  });
  it('distinguishes completed text review from unresolved chart-layout limitations',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture();
    report.compliance!.status='partial';report.compliance!.gaps=['矩陣坐標需確認'];
    try{
      await act(async()=>root.render(<C2StatusPanel report={report} request={vi.fn()} onChange={vi.fn()}/>));
      expect(div.textContent).toContain('文字核對完成，部分圖表需確認');
      expect(div.textContent).not.toContain('繼續未完成部分');
      report.compliance!.gaps=['未確認官方最新全文'];
      await act(async()=>root.render(<C2StatusPanel report={report} request={vi.fn()} onChange={vi.fn()}/>));
      expect(div.textContent).toContain('文字核對完成，部分範圍待確認');
      expect(div.textContent).not.toContain('部分圖表需確認');
    }finally{act(()=>root.unmount());}
  });
  it('explains oversized input as an unfinished read, ahead of the old citation-error wrapper',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture();
    report.compliance!.status='partial';report.compliance!.tasks[0]!.status='failed';
    report.compliance!.tasks[0]!.error='C2結果或引用仍未通過驗證，本批未發布。完整C2及報告超出模型context預算；未截斷原文。';
    try{
      await act(async()=>root.render(<C2StatusPanel report={report} request={vi.fn()} onChange={vi.fn()}/>));
      expect(div.textContent).toContain('單次讀取的內容過多，本批尚未開始核對。');
      expect(div.textContent).not.toContain('模型引文未能對上報告原頁');
      expect(div.textContent).not.toContain('完整C2及報告超出模型context預算');
      expect(div.textContent).toContain('繼續未完成部分');
    }finally{act(()=>root.unmount());}
  });
  it('labels actual full-text source scope rather than all uploaded translations as reviewed',async()=>{
    const div=document.createElement('div'),root=createRoot(div),report=fixture();
    report.compliance!.source_plan={mode:'compact_pdf_blocks_v3',full_text:true,documents:[{slot:'esg_en',pages:3}],historical_documents:[],policy:'所選語言全文，其他版本另做一致性審閱。'};
    const request=vi.fn(async()=>({data_url:'data:image/png;base64,AA=='}));
    try{
      await act(async()=>root.render(<ConsistencyReader report={report} request={request}/>));
      expect(div.textContent).toContain('主審1份文件');expect(div.textContent).toContain('3頁全文');
      expect(div.querySelector('[aria-label="本次全文核對範圍"]')?.textContent).toContain('ESG English 3頁');
    }finally{act(()=>root.unmount());}
  });
});
