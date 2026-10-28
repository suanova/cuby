import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,it,expect,vi} from "vitest";
import {FinanceReaderApi} from "../../../src/entrypoints/frontend-bridge/finance-reader-api.js";

const run="20310101T000000-aabbccdd",dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(size=64) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"finance-pdf-")));dirs.push(root);
  const file=path.join(root,"outputs","consistency",run,"exports","r2","esg_en-revised.pdf");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const data=Buffer.alloc(size,32);data.write("%PDF-1.7");fs.writeFileSync(file,data);
  const receipt={status:"ready",file_name:path.basename(file),file_path:file,mime:"application/pdf",bytes:data.length,
    sha256:crypto.createHash("sha256").update(data).digest("hex"),revision:2,accepted:1,layout_notice:"保留原PDF樣式。"};
  const tool=vi.fn(async()=>receipt);
  return {root,file,data,receipt,tool,api:new FinanceReaderApi(tool,fetch,undefined,undefined,root)};
}
describe("Original-layout PDF export",()=>{
  it("downloads large reports through an opaque grant rather than inline base64",async()=>{
    const {api,data}=fixture(9*1024*1024);
    const receipt=await api.request({action:"consistency-draft-export",run_id:run,slot:"esg_en"}) as any;
    expect(receipt.download_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(receipt).not.toHaveProperty("file_path");expect(receipt).not.toHaveProperty("data_base64");
    expect(api.download(receipt.download_id).data.equals(data)).toBe(true);
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+11*60_000);
    expect(()=>api.download(receipt.download_id)).toThrow("過期");
  });
  it("refuses another path, substituted bytes, and invalid PDF headers",async()=>{
    const {api,receipt,tool,file}=fixture();
    tool.mockResolvedValueOnce({...receipt,file_path:path.join(path.dirname(file),"other.pdf")});
    await expect(api.request({action:"consistency-draft-export",run_id:run})).rejects.toThrow("位置");
    const granted=await api.request({action:"consistency-draft-export",run_id:run}) as any;
    fs.writeFileSync(file,Buffer.alloc(receipt.bytes,65));
    expect(()=>api.download(granted.download_id)).toThrow("已變更");
    const bad=Buffer.alloc(receipt.bytes,65);receipt.sha256=crypto.createHash("sha256").update(bad).digest("hex");
    await expect(api.request({action:"consistency-draft-export",run_id:run})).rejects.toThrow("已變更");
  });
  it("rejects a symlinked export folder that escapes its workspace",async()=>{
    const {root,file,api}=fixture();
    const outside=fs.mkdtempSync(path.join(os.tmpdir(),"outside-pdf-"));dirs.push(outside);
    const folder=path.dirname(file),target=path.join(outside,"r2");fs.renameSync(folder,target);
    fs.symlinkSync(target,folder,process.platform==="win32"?"junction":"dir");
    await expect(api.request({action:"consistency-draft-export",run_id:run})).rejects.toThrow("已變更");
    fs.unlinkSync(folder);
    expect(root).toBeTruthy();
  });
  it("reports the blocked document/page and uses real revised PNG previews",async()=>{
    const tool=vi.fn(async()=>({status:"blocked",issues:[{slot:"esg_en",page:12,reason:"新增文字放不進同一頁。"}]}));
    const api=new FinanceReaderApi(tool);
    await expect(api.request({action:"consistency-draft-export",run_id:run})).rejects.toMatchObject({status:409,message:"ESG英文第12頁：新增文字放不進同一頁。"});
    await expect(api.request({action:"consistency-draft-page",run_id:run,slot:"esg_en",page:12})).rejects.toMatchObject({status:409});
    expect(tool).toHaveBeenLastCalledWith("mcp_financebuddy_reports_edit_consistency_draft",{operation:"render",run_id:run,slot:"esg_en",page:12});
    tool.mockResolvedValueOnce({data_url:"https://example.com/fake.png"} as any);
    await expect(api.request({action:"consistency-draft-page",run_id:run,slot:"esg_en",page:12})).rejects.toThrow("無效");
  });
});
