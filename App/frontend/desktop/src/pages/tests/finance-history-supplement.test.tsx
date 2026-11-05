// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
import type {FinanceProject,ConsistencyReport} from '@memmy/local-api-contracts';
import {FinanceHistorySupplement} from '../finance-history-supplement.js';
import {projectStatus,FinanceProjectPicture} from '../finance-review-navigation.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const run='20310101T000000-aabbccdd';
const project:FinanceProject={id:'a'.repeat(32),title:'TEST ONLY',external_id:null,revision:1,latest_run:run,created_at:'2031-01-01',updated_at:'2031-01-01',versions:[{id:'b'.repeat(32),fiscal_year:'2031/32',created_at:'2031-01-01',runs:[run],documents:[],reviews:[{run_id:run,kind:'consistency',status:'partial',history_status:'unavailable',history_year:'2030/31',restatement_status:'failed'}]}]};
const report={schema_version:'financebuddy-consistency-1',run_id:run,created_at:'2031-01-01',fiscal_year:'2031/32',comparisons:['restatement'],history:{status:'unavailable',fiscal_year:'2030/31',source:'WeKnora'},documents:[{slot:'esg_en',label:'ESG English',file_name:'current.pdf',sha256:'a'.repeat(64),page_count:1,identity_confirmed:true,cover_year_found:true,textless_pages:[]}],checks:[],coverage:{scanned_pages:1,page_pairs:0,same_numeric_inventory_pages:0,metric_checks:0,numeric_facts:0,matched:0,differences:0,pending:0,historical_pages:0,internal_checks:0,restatement_checks:0},all_numbers_confirmed:false,all_basis_confirmed:false,limits:[]} as ConsistencyReport;
describe('History recovery and project picture',()=>{
  it('shows the three workflows together and does not claim a missing C2 review is complete',()=>{
    expect(projectStatus(project.versions[0]!)).toEqual({consistency:'部分完成',c2:'未開始',history:'欠去年文件',missingHistory:true});
    const div=document.createElement('div'),root=createRoot(div);
    try{act(()=>root.render(<FinanceProjectPicture version={project.versions[0]!}/>));expect(div.textContent).toContain('一致性：部分完成');expect(div.textContent).toContain('C2：未開始');expect(div.textContent).toContain('跨年：欠去年文件');}finally{act(()=>root.unmount());}
  });
  it('saves uploaded historical sources to the existing review only after entity/year confirmation, then requests resume',async()=>{
    const upload=vi.fn(async()=>[{path:'uploaded/prior.pdf',kind:'file',mime:'application/pdf'}]);
    const request=vi.fn(async()=>({project,report})),complete=vi.fn(async()=>{}),div=document.createElement('div'),root=createRoot(div);
    try{
      await act(async()=>root.render(<FinanceHistorySupplement client={{uploadAgentMedia:upload} as any} project={project} report={report} request={request} onComplete={complete} onClose={()=>{}}/>));
      const submit=()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='補交並繼續核對')!;
      expect(submit().disabled).toBe(true);
      await act(async()=>{const input=div.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{value:[new File(['%PDF test'],'prior.pdf',{type:'application/pdf'})]});input.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(submit().disabled).toBe(true);
      await act(async()=>{const box=div.querySelector<HTMLInputElement>('input[type=checkbox]')!;box.click();});
      expect(submit().disabled).toBe(false);await act(async()=>submit().click());
      expect(request).toHaveBeenCalledWith({action:'project-supplement',project_id:project.id,run_id:run,confirmed:true,documents:[{slot:'esg_en',path:'uploaded/prior.pdf',file_name:'prior.pdf'}]});
      expect(complete).toHaveBeenCalledWith(report,project,true);
      expect(request.mock.calls.some(([input]:any)=>/build|decide/.test(input.action))).toBe(false);
    }finally{act(()=>root.unmount());}
  });
});
