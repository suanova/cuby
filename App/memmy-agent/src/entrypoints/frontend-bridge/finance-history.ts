import crypto from "node:crypto";
import { FinanceReviewBindingSchema, type FinanceProject, type FinanceReviewBinding } from "@memmy/local-api-contracts";
import { type SessionManager, readWebuiSessionBinding } from "../../core/session/manager.js";
import { ProjectStore } from "./projects.js";

/** Uses native projects and sessions, so reports and follow-up chats share one history. */
export class FinanceHistory {
  constructor(private projects:ProjectStore, private sessions:SessionManager,
    private append:(chatId:string,record:Record<string,unknown>)=>void=()=>{}) {}

  project(project:FinanceProject, root:string):string {
    if(project.external_id) {
      if(!this.projects.getActive(project.external_id) || this.projects.isDeleting(project.external_id))
        throw new Error("此 Cuby 項目已移除，請重新選擇項目。");
      return project.external_id;
    }
    return this.projects.add(root,"existing",project.title).id;
  }

  review(project:FinanceProject, runId:string):FinanceReviewBinding {
    const version=project.versions.find(v=>v.runs.includes(runId));
    if(!version || !project.external_id) throw new Error("此審閱不屬於所選項目。");
    const native=this.projects.getActive(project.external_id);
    if(!native || this.projects.isDeleting(native.id)) throw new Error("Cuby 項目已移除。");
    const chatId="fin_"+crypto.createHash("sha256").update(project.id+":"+runId).digest("hex").slice(0,32);
    const binding=FinanceReviewBindingSchema.parse({project_id:project.id,native_project_id:native.id,run_id:runId,session_key:`websocket:${chatId}`,chat_id:chatId});
    const existing=this.sessions.get(binding.session_key);
    if(existing) {
      const saved=FinanceReviewBindingSchema.parse(existing.metadata.financeBuddyReview);
      if(JSON.stringify(saved)!==JSON.stringify(binding) || readWebuiSessionBinding(existing).projectId!==native.id)
        throw new Error("審閱對話連結不符。");
      return binding;
    }
    // A deleted chat must not be recreated by background history synchronization.
    const {session}=this.sessions.getOrCreateWithInfo(binding.session_key);
    session.metadata.webui=true;
    session.metadata.webuiProjectId=native.id;
    session.metadata.webuiWorkspaceCwd=native.rootPath;
    session.metadata.financeBuddyReview=binding;
    const instant=new Date(`${runId.slice(0,4)}-${runId.slice(4,6)}-${runId.slice(6,8)}T${runId.slice(9,11)}:${runId.slice(11,13)}:${runId.slice(13,15)}Z`);
    const date=new Intl.DateTimeFormat("zh-HK",{timeZone:"Asia/Hong_Kong",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(instant);
    session.metadata.title=`報告核對 · FY${version.fiscal_year} · ${date}`;
    session.metadata.titleUserEdited=true;
    const text=`此對話連結 FY${version.fiscal_year} 的報告核對（${runId}）。可在這裡追問 Cuby；點選左邊此紀錄可重開同一份工作台。`;
    session.addMessage("assistant",text);
    this.sessions.save(session,{fsync:true});
    this.append(chatId,{event:"message",chat_id:chatId,text,content:text});
    this.append(chatId,{event:"turn_end",chat_id:chatId});
    return binding;
  }

  lookup(sessionKey:string):FinanceReviewBinding|null {
    const session=this.sessions.get(sessionKey);
    if(!session || session.metadata.webui!==true || !session.metadata.financeBuddyReview) return null;
    const parsed=FinanceReviewBindingSchema.safeParse(session.metadata.financeBuddyReview);
    if(!parsed.success || parsed.data.session_key!==sessionKey) return null;
    const native=this.projects.getActive(parsed.data.native_project_id);
    if(!native || this.projects.isDeleting(native.id) || readWebuiSessionBinding(session).projectId!==native.id) return null;
    return parsed.data;
  }
}
