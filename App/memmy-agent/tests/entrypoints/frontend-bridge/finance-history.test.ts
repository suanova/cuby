import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach,describe,it,expect,vi } from "vitest";
import { SessionManager, Session } from "../../../src/core/session/manager.js";
import { ProjectStore } from "../../../src/entrypoints/frontend-bridge/projects.js";
import { FinanceHistory } from "../../../src/entrypoints/frontend-bridge/finance-history.js";
import { FinanceReaderApi } from "../../../src/entrypoints/frontend-bridge/finance-reader-api.js";
import type { FinanceProject } from "@memmy/local-api-contracts";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"finance-history-"));roots.push(root);
  const projects=new ProjectStore({filePath:path.join(root,"projects.json")});
  const sessions=new SessionManager(path.join(root,"sessions")),append=vi.fn();
  const history=new FinanceHistory(projects,sessions,append);
  const run="20310101T000000-aabbccdd",later="20310201T000000-11223344";
  const project:FinanceProject={id:"a".repeat(32),title:"億都報告",external_id:null,revision:0,latest_run:later,created_at:"2031-01-01",updated_at:"2031-02-01",versions:[{id:"b".repeat(32),fiscal_year:"2031/32",created_at:"2031-01-01",runs:[run,later],documents:[]}]};
  return {root,projects,sessions,history,append,run,later,project};
}
describe("Finance project review history",()=>{
  it("keeps each run and its follow-up messages in one native folder across restarts",()=>{
    const {root,projects,sessions,history,append,project,run,later}=setup();
    project.external_id=history.project(project,root);
    expect(history.project(project,root)).toBe(project.external_id);
    const first=history.review(project,run),second=history.review(project,later);
    expect(first.chat_id).not.toBe(second.chat_id);
    expect(projects.listActive()).toHaveLength(1);
    const saved=sessions.get(first.session_key)!;
    saved.addMessage("user","請問這項應該怎樣修改？");sessions.save(saved);
    expect(history.review(project,run)).toEqual(first);
    expect(append).toHaveBeenCalledTimes(4);
    const restarted=new FinanceHistory(projects,new SessionManager(path.join(root,"sessions")));
    expect(restarted.lookup(first.session_key)).toEqual(first);
    expect(restarted.lookup(second.session_key)?.run_id).toBe(later);
    expect(sessions.get(first.session_key)?.messages.at(-1)?.content).toContain("怎樣修改");
    expect(sessions.webuiSessionSummary(saved).projectId).toBe(project.external_id);
  });
  it("does not claim an unrelated chat or permit a run from another project",()=>{
    const {history,project,root,sessions,run}=setup();project.external_id=history.project(project,root);
    const plain=new Session({key:"websocket:unrelated"});plain.metadata.webui=true;plain.metadata.webuiProjectId=null;plain.metadata.webuiWorkspaceCwd=root;sessions.save(plain);
    expect(history.lookup(plain.key)).toBeNull();
    expect(()=>history.review(project,"20310101T000000-ffffffff")).toThrow("不屬於");
    const binding=history.review(project,run);
    const saved=sessions.get(binding.session_key)!;saved.metadata.webuiProjectId="another-project";sessions.save(saved);
    expect(history.lookup(binding.session_key)).toBeNull();
    expect(()=>history.review(project,run)).toThrow("連結不符");
  });
  it("registers existing runs idempotently and restores the selected run through the authenticated adapter",async()=>{
    const {history,project,root,run,later}=setup();
    const tool=vi.fn(async(_name:string,args:Record<string,unknown>)=>{
      if(args.operation==="list")return {projects:[project]};
      if(args.operation==="workspace")return {project,root_path:root};
      if(args.operation==="bind"){project.external_id=String(args.external_id);project.revision++;}
      return project;
    });
    const api=new FinanceReaderApi(tool,fetch,undefined,history);
    await api.request({action:"project-list"});await api.request({action:"project-list"});
    expect(tool.mock.calls.filter(c=>c[1].operation==="bind")).toHaveLength(1);
    const opened=await api.request({action:"project-open",project_id:project.id,run_id:run}) as any;
    expect((await api.request({action:"project-session",session_key:opened.binding.session_key}) as any).binding.run_id).toBe(run);
    expect(opened.binding.run_id).not.toBe(later);
    expect(await api.request({action:"project-session",session_key:"websocket:unrelated"})).toEqual({binding:null});
    await expect(api.request({action:"project-open",project_id:project.id,run_id:run,root_path:"C:/private"})).rejects.toThrow("Invalid report reader request");
  });
});
