import { describe, expect, it } from "vitest";
import type { ConsistencyEditor, ConsistencyReport } from "@memmy/local-api-contracts";
import { consistencyWorkItems } from "../consistency-work-items.js";

const check: ConsistencyReport['checks'][number] = {id:'table',category:'basis',status:'difference',title:'Original title',reason:'Original reason',reader_copy:{title:'年份不同',problem:'中文2023，英文2003。',next_step:'請確認年份。'},refs:[{slot:'esg_zh',page:41,quote:'Full Chinese context: 2023省級電力平均二氧化碳排放因數。'},{slot:'esg_en',page:41,quote:'The emission factors are based on the Provincial Electricity Average Carbon Emission Factors 2003 for Shanghai.'}]};
const editor: ConsistencyEditor = {run_id:'20310101T000000-aabbccdd',base_sha256:'a'.repeat(64),revision:0,history:[],decisions:{},proposals:{table:{id:'proposal',status:'ready',updated_at:'2031-01-01',requires_confirmation:true,edits:[{slot:'esg_en',page:41,original:'The reference year is 2003.',replacement:'The reference year is 2023.'}]}}};
describe('Review work items',()=>{
  it('merges identical issue copy at the same sources, preferring the ready replacement without mutating records',()=>{
    const duplicate={...check,id:'semantic',refs:[{...check.refs[1]!,quote:'Provincial Electricity Average Carbon Emission Factors 2003'},{...check.refs[0]!,quote:'2023省級電力平均二氧化碳排放因數'}]};
    const result=consistencyWorkItems([duplicate,check],editor);
    expect(result).toHaveLength(1);expect(result[0]!.check.id).toBe('table');expect(result[0]!.members).toHaveLength(2);
    expect(duplicate.id).toBe('semantic');expect(editor.decisions).toEqual({});
  });
  it('keeps different problems, source pages, quotations and unchecked records separate',()=>{
    const variants=[check,{...check,id:'different',reader_copy:{...check.reader_copy!,problem:'另一個年份問題。'}},{...check,id:'page',refs:[{...check.refs[0]!,page:42},check.refs[1]!]},{...check,id:'unreviewed',status:'pending' as const,review_state:'not_checked' as const}];
    variants.push({...check,id:'unrelated-quotes',refs:check.refs.map(r=>({...r,quote:'An unrelated passage on the same page.'}))});
    expect(consistencyWorkItems(variants,editor)).toHaveLength(5);
  });
  it('uses the actual accepted or dismissed check as owner so undo is possible without applying overlapping edits',()=>{
    const duplicate={...check,id:'semantic'};
    const resolved={...editor,decisions:{semantic:{status:'accepted' as const,edits:editor.proposals.table!.edits!,at:'2031-01-01'}}};
    expect(consistencyWorkItems([check,duplicate],resolved)[0]!.check.id).toBe('semantic');
    expect(consistencyWorkItems([check,duplicate],{...resolved,decisions:{semantic:{...resolved.decisions.semantic!,status:'dismissed'}}})[0]!.check.id).toBe('semantic');
  });
});
