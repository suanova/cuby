import { describe, expect, it } from "vitest";
import type { ConsistencyEditor, ConsistencyReport } from "@memmy/local-api-contracts";
import { reviewAction } from "../consistency-actions.js";

const issue: ConsistencyReport["checks"][number] = {id:"issue",category:"basis",status:"difference",title:"Year differs",reason:"Confirm which year is correct",refs:[]};
const ready: ConsistencyEditor["proposals"][string] = {id:"proposal",status:"ready",updated_at:"2031-01-01",summary:"Fix spelling",requires_confirmation:false,confirmation_prompt:"",edits:[{slot:"esg_en",page:1,original:"Original wording here.",replacement:"Corrected wording here."}]};

describe("review actions",()=>{
  it("does not equate a detected difference with a safe rewrite",()=>{
    expect(reviewAction(issue)).toBe("verify");
    expect(reviewAction(issue,ready)).toBe("edit");
    expect(reviewAction({...issue,reader_copy:{title:"Year",problem:"Years differ",next_step:"Change year",action_kind:"edit"}}, {...ready,requires_confirmation:true})).toBe("verify");
  });
  it("keeps requests for calculations separate from deciding which fact is correct",()=>{
    expect(reviewAction({...issue,reader_copy:{title:"Units",problem:"Units differ",next_step:"請補充換算系數及來源。",action_kind:"supplement"}})).toBe("supplement");
    expect(reviewAction({...issue,reader_copy:{title:"Year",problem:"Years differ",next_step:"請確認正確年份。",action_kind:"verify"}})).toBe("verify");
  });
  it("keeps unperformed and matched checks out of the to-do list",()=>{
    expect(reviewAction({...issue,status:"matched"})).toBeNull();
    expect(reviewAction({...issue,review_state:"not_checked"})).toBeNull();
    expect(reviewAction({...issue,category:"page_numbers",status:"pending"})).toBeNull();
  });
});
