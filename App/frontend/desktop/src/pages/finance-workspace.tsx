import { NativeFinanceReader } from "./finance-reader-view.js";
import { ConsistencyReader } from "./finance-consistency-view.js";
import { FinanceProjectSetup } from "./finance-project-setup.js";
import { FinancePeerSetup } from "./finance-peer-setup.js";
import { FinanceHistorySupplement } from "./finance-history-supplement.js";
import { FinanceReviewNavigation, latestReview, REVIEW_NAMES, type ReviewKind } from "./finance-review-navigation.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  FileCheck2,
  Files,
  Maximize2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  FinanceOpenSchema,
  ConsistencyReportSchema, FinanceSessionReviewSchema, FinanceProjectListSchema, type FinanceProject, type FinanceReviewBinding,
  type FinanceCatalog,
  type FinanceOpen,
  type FinanceNoteWrite,
  type FinanceRequest,
  type ConsistencyReport,
} from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import {
  FINANCE_WORKFLOWS,
  type FinanceWorkflowId,
} from "./finance-workflows.js";
import "./finance-workspace.css";
import type { SavedFinanceSelection } from "./use-saved-finance-projects.js";

export const FINANCE_REVIEW_LINK =
  /^outputs\/c2-reviews\/[A-Za-z0-9_-]+\/review\.(?:json|html)$/;


export function FinanceWorkflowCards(props: {
  onChoose: (id: FinanceWorkflowId) => void;
}) {
  return (
    <section className="finance-shortcuts" aria-label="FinanceBuddy 工作">
      <div className="finance-shortcuts-heading">
        <span>FinanceBuddy</span>
        <small>選擇工作，唔使寫 prompt</small>
      </div>
      <div className="finance-shortcut-grid">
        {["consistency","peers","review"].map(id => FINANCE_WORKFLOWS.find(item=>item.id===id)!).map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => props.onChoose(item.id)}
          >
            <strong>{item.title}</strong>
            <small>{item.stage}</small>
          </button>
        ))}
      </div>
      <details className="finance-upcoming"><summary>資料整合與報告生成 · 準備中</summary><div className="finance-shortcut-grid">{FINANCE_WORKFLOWS.filter(item=>["sources","report"].includes(item.id)).map(item=><button key={item.id} onClick={()=>props.onChoose(item.id)}><strong>{item.title}</strong><small>{item.stage}</small></button>)}</div></details>
    </section>
  );
}

type Drafts = Record<
  string,
  { decision: FinanceNoteWrite["decision"]; note: string }
>;
function uniqueReviewVersion(project: FinanceProject | null | undefined, run: string) {
  const versions = project?.versions.filter(version => version.runs.includes(run)) ?? [];
  return versions.length === 1 ? versions[0] : undefined;
}
export function FinanceWorkspace(props: {
  visible: boolean;
  projectContext?: {id:string;name:string}|null;
  client: MemmyAgentClient;
  initialPath: string | null;
  initialReview?:FinanceReviewBinding|null;
  initialSetupSelection?: SavedFinanceSelection | null;
  onReviewOpened?:(binding:FinanceReviewBinding)=>void;
  artifactPath?: string | null;
  workflow: FinanceWorkflowId | null;
  busy: boolean;
  askBlockedReason?:string;
  askQueued?:boolean;
  askRecovery?:{label:string;onClick:()=>void};
  onChoose: (id: FinanceWorkflowId | null) => void;
  onLaunch: (prompt: string, review?:FinanceReviewBinding, projectId?:string) => Promise<void>;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<FinanceCatalog | null>(null);
  const [opened, setOpened] = useState<FinanceOpen | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [reviewBinding,setReviewBinding]=useState<FinanceReviewBinding|null>(null);
  const [reviewProject,setReviewProject]=useState<FinanceProject|null>(null);
  const [supplementOpen,setSupplementOpen]=useState(false);
  const loadedReview=useRef<{client:MemmyAgentClient;run_id:string}|null>(null);
  const currentReport=useRef<ConsistencyReport|null>(null);
  currentReport.current=consistency;
  const [setupTarget,setSetupTarget]=useState<{kind:ReviewKind;project_id:string;version_id:string;returnToReader?:boolean}|null>(null);
  const [openedPath, setOpenedPath] = useState("");
  const draftStore = useRef<Record<string, Drafts>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const openSequence = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const filesButtonRef = useRef<HTMLButtonElement | null>(null);
  const client = props.client;
  const bindingProject = reviewBinding?.run_id === consistency?.run_id ? reviewBinding?.project_id : undefined;
  const initialProject = props.initialReview?.run_id === consistency?.run_id ? props.initialReview?.project_id : undefined;
  const projectBindingConflict = !!bindingProject && !!initialProject && bindingProject !== initialProject;
  const boundProjectId = projectBindingConflict ? undefined : bindingProject ?? initialProject;
  useEffect(()=>{setSetupTarget(null);},[props.projectContext?.id]);
  const request=useCallback(async(input: FinanceRequest) => {
    if (!client.financeReaderRequest)
      throw new Error("此版本 Cuby 未支援內置 Reader，請更新 Cuby。");
    return client.financeReaderRequest(input);
  },[client]);
  const updateReport=useCallback((report:ConsistencyReport)=>setConsistency(report),[]);
  async function openResult(report:ConsistencyReport,project:FinanceProject) {
    const result=FinanceSessionReviewSchema.parse(await request({action:"project-open",project_id:project.id,run_id:report.run_id}));
    if(!result.binding)throw new Error("未能建立審閱紀錄。");
    loadedReview.current={client,run_id:report.run_id};currentReport.current=report;
    setReviewBinding(result.binding);setReviewProject(project);setConsistency(report);setOpened(null);setExpanded(true);props.onChoose(null);props.onReviewOpened?.(result.binding);
  }
  function configure(kind:ReviewKind,project:FinanceProject,version_id:string,returnToReader=false) {
    setSetupTarget({kind,project_id:project.id,version_id,...(returnToReader?{returnToReader:true}:{})});
    props.onChoose(kind==="c2"?"review":"consistency");
  }
  async function openRelated(kind:ReviewKind,history=false) {
    if(!consistency||!reviewProject||projectBindingConflict||boundProjectId&&reviewProject.id!==boundProjectId)return;
    setLoading(true);setError("");
    try {
      // Refresh state before navigating: a background review may have finished.
      const {projects}=FinanceProjectListSchema.parse(await request({action:"project-list"}));
      const project=projects.find(p=>p.id===reviewProject.id);
      const version=uniqueReviewVersion(project,consistency.run_id);
      if(!project||!version)throw new Error("找不到此報告版本，請重新開啟項目。");
      const previous=latestReview(version,kind);
      if(previous && previous.status!=="not_started") {
        const report=ConsistencyReportSchema.parse(await request({action:"consistency-read",run_id:previous.run_id}));
        await openResult(report,project);
        if(history&&!report.compliance&&(report.history.status==='unavailable'||report.history.missing_slots?.length))setSupplementOpen(true);
      } else configure(kind,project,version.id);
    }catch(e){setError(errorText(e));}finally{setLoading(false);}
  }
  async function refresh() {
    try {
      setError("");
      if (!client.getFinanceCatalog)
        throw new Error("請更新 Cuby 的 FinanceBuddy 支援。");
      setCatalog(await client.getFinanceCatalog());
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function open(path: string, artifact?: string | null) {
    const sequence = ++openSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = FinanceOpenSchema.parse(
        await request({
          action: "open",
          review_path: path,
          ...(artifact ? { artifact_path: artifact } : {}),
        }),
      );
      if (sequence === openSequence.current) {
        setConsistency(null);
        setOpened(result);
        setOpenedPath(path);
        props.onChoose(null);
      }
    } catch (e) {
      if (sequence === openSequence.current) setError(errorText(e));
    } finally {
      if (sequence === openSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [client]);
  useEffect(() => {
    if (props.initialPath) void open(props.initialPath, props.artifactPath);
  }, [props.initialPath, props.artifactPath, client]);
  useEffect(()=>{
    const binding=props.initialReview;
    if(!binding){loadedReview.current=null;setConsistency(null);setReviewBinding(null);setSupplementOpen(false);setLoading(false);return;}
    // Echoing an already-open binding or filling in project metadata must not
    // unmount the reader and reset its overview, scroll positions or filters.
    if(loadedReview.current?.client===client&&loadedReview.current.run_id===binding.run_id&&currentReport.current?.run_id===binding.run_id){setReviewBinding(binding);return;}
    let active=true;
    setLoading(true);setError("");setReviewBinding(binding);setOpened(null);setConsistency(null);setSupplementOpen(false);
    void request({action:"consistency-read",run_id:binding.run_id}).then(raw=>{
      if(active){const report=ConsistencyReportSchema.parse(raw);loadedReview.current={client,run_id:binding.run_id};currentReport.current=report;setConsistency(report);setExpanded(true);}
    }).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[props.initialReview?.session_key,props.initialReview?.run_id,props.initialReview?.project_id,client]);
  useEffect(()=>{
    if(!consistency||projectBindingConflict){setReviewProject(null);return;}
    let active=true;
    void request({action:"project-list"}).then(raw=>{
      if(!active)return;
      const projects=FinanceProjectListSchema.parse(raw).projects;
      const candidates=boundProjectId?projects.filter(project=>project.id===boundProjectId):projects.filter(project=>project.versions.some(version=>version.runs.includes(consistency.run_id)));
      const project=candidates.length===1&&uniqueReviewVersion(candidates[0],consistency.run_id)?candidates[0]:undefined;
      setReviewProject(project??null);
      const version=uniqueReviewVersion(project,consistency.run_id);
      // A saved C2 setup whose model never started must not look like a
      // completed consistency review when reopened from history.
      if(!props.initialSetupSelection&&project&&version&&!consistency.compliance&&version.reviews?.some(r=>r.run_id===consistency.run_id&&r.kind==="c2"))configure("c2",project,version.id);
    }).catch(()=>{/* Existing reader remains usable during a project-list outage. */});
    return()=>{active=false;};
  },[consistency?.run_id,client,boundProjectId,projectBindingConflict,props.initialSetupSelection?.project_id,props.initialSetupSelection?.version_id]);
  const selected = FINANCE_WORKFLOWS.find((x) => x.id === props.workflow);
  const reviewKind:ReviewKind=consistency?.compliance?"c2":"consistency";
  const reviewVersion=!projectBindingConflict&&(!boundProjectId||reviewProject?.id===boundProjectId)?uniqueReviewVersion(reviewProject,consistency?.run_id??""):undefined;
  const target=selected?.id==="consistency"&&props.initialSetupSelection?props.initialSetupSelection:setupTarget&&(selected?.id==="review"?setupTarget.kind==="c2":selected?.id==="consistency"&&setupTarget.kind==="consistency")?setupTarget:undefined;
  const localFilesDetour=!!selected&&!props.initialSetupSelection&&!!setupTarget?.returnToReader&&target===setupTarget&&reviewProject?.id===target.project_id&&reviewVersion?.id===target.version_id;
  function closeWorkspace() {
    if(localFilesDetour){setSetupTarget(null);props.onChoose(null);}
    else props.onClose();
  }
  // Saved setup and this version's files are temporary detours from the reader.
  // Retain its unsent question, drafts and source/page until the detour closes.
  const preserveSavedReader = useRef(false);
  if (!selected) preserveSavedReader.current = false;
  else if (props.initialSetupSelection || target && reviewProject?.id === target.project_id && reviewVersion?.id === target.version_id) preserveSavedReader.current = true;
  async function supplemented(report:ConsistencyReport,project:FinanceProject,resume:boolean) {
    setConsistency(report);setReviewProject(project);setSupplementOpen(false);setError("");
    if(resume)try{setConsistency(ConsistencyReportSchema.parse(await request({action:'consistency-semantic-start',run_id:report.run_id})));}
    catch(e){setError('文件已保存；核對尚未啟動。'+errorText(e)+' 可按「繼續核對」重試。');}
  }
  useEffect(() => {
    if (!props.visible || !selected) return;
    const previous = localFilesDetour ? filesButtonRef.current : document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-label="關閉工作台"]')
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [props.visible, selected?.id, localFilesDetour]);
  return (
    <div
      hidden={!props.visible}
      className={
        selected ? "finance-dialog-backdrop" : "finance-workspace-host"
      }
      onMouseDown={(event) => {
        if (selected && event.target === event.currentTarget) closeWorkspace();
      }}
    >
      <aside
        ref={dialogRef}
        role={selected ? "dialog" : undefined}
        aria-modal={selected ? true : undefined}
        className={
          selected
            ? "finance-config-dialog"
            : `finance-workspace${expanded ? " finance-workspace--expanded" : ""}`
        }
        aria-label="FinanceBuddy 內置工作台"
        onKeyDown={(event) => {
          if (!selected) return;
          if (event.key === "Escape") {
            event.preventDefault();
            closeWorkspace();
          }
          if (event.key === "Tab") {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]",
              ),
            ).filter(item => !item.closest("[hidden], [inert]"));
            const first = items[0],
              last = items.at(-1);
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault();
              last.focus();
            } else if (
              !event.shiftKey &&
              document.activeElement === last &&
              first
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="finance-header">
          <div>
            <span className="finance-eyebrow">FINANCEBUDDY · CUBY</span>
            <h2>
              <FileCheck2 size={18} />
              {selected ? selected.title : consistency?REVIEW_NAMES[reviewKind]:"報告工作台"}
            </h2>
          </div>
          <div className="finance-actions">
            {consistency && <button ref={filesButtonRef} hidden={!!selected} style={selected?{display:"none"}:undefined} onClick={()=>reviewProject&&reviewVersion?configure(reviewKind,reviewProject,reviewVersion.id,true):props.onChoose(reviewKind==="c2"?"review":"consistency")}>文件與檢查記錄</button>}
            {!selected && (
              <button
                title={expanded ? "並排對話" : "展開工作台"}
                aria-label={expanded ? "並排對話" : "展開工作台"}
                onClick={() => setExpanded(!expanded)}
              >
                <Maximize2 size={16} />
              </button>
            )}
            {!selected && (
              <button
                title="返回功能選擇"
                aria-label="返回功能選擇"
                onClick={() => {
                  props.onChoose(null);
                  setOpened(null);
                  setConsistency(null);
                }}
              >
                <Files size={17} />
              </button>
            )}
            {!selected && (
              <button
                title="重新載入結果清單"
                aria-label="重新載入結果清單"
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
              </button>
            )}
            <button
              title="關閉工作台"
              aria-label="關閉工作台"
              onClick={closeWorkspace}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="finance-error" role="alert">
            {error}
          </div>
        )}
        {loading && (
          <div className="finance-loading" role="status">
            正在驗證原件版本及載入檢查結果…
          </div>
        )}
        {!loading && (selected?.id === "consistency"||selected?.id === "review") ? (
          <FinanceProjectSetup key={`${selected.id}:${target?.project_id??props.projectContext?.id??""}:${target?.version_id??""}`} initialSelection={target} initialMode={selected.id==="review"?"c2":"consistency"} client={client} request={request} context={props.projectContext} onSwitch={configure} onComplete={openResult}/>
        ) : !loading && selected?.id === "peers" ? (
          <FinancePeerSetup request={request} context={props.projectContext} busy={props.busy} onManageFiles={(project,versionId)=>configure("consistency",project,versionId)} onLaunch={async(prompt,projectId)=>{await props.onLaunch(prompt,undefined,projectId);props.onClose();}}/>
        ) : !loading && selected ? (
          <div className="finance-setup"><span className="finance-badge">{selected.stage}</span><h3>{selected.title}</h3><p>{selected.detail}</p>
            <div className="finance-scope"><strong>等待來源確認</strong><p>需要來源 Excel／系統、欄位說明、報告期間、業務邊界、負責人及讀取權限。資料齊備後接通整合及報告生成。</p></div>
          </div>
        ) : !loading && consistency ? null : !loading && opened ? (
          <NativeFinanceReader
            key={opened.handle}
            opened={opened}
            request={request}
            draftKey={openedPath + ":" + opened.review.review_sha256}
            draftStore={draftStore.current}
          />
        ) : !loading ? (
          <div className="finance-setup">
            <h3>今日要處理邊項工作？</h3>
            <FinanceWorkflowCards onChoose={props.onChoose} />
            <ReviewList catalog={catalog} onOpen={(p) => void open(p)} />
          </div>
        ) : null}
        {!loading && consistency && (!selected || preserveSavedReader.current) && <div className="finance-preserved-review" hidden={Boolean(selected)} inert={Boolean(selected)} aria-hidden={selected ? true : undefined}>
          {reviewProject&&reviewVersion&&<FinanceReviewNavigation kind={reviewKind} project={reviewProject} version={reviewVersion} report={consistency} onOpen={kind=>void openRelated(kind)} onHistory={()=>{if(reviewKind==='c2')void openRelated('consistency',true);else if(consistency.history.status==='unavailable'||consistency.history.missing_slots?.length)setSupplementOpen(true);else configure('consistency',reviewProject,reviewVersion.id);}} busy={loading}/>}
          <ConsistencyReader key={consistency.run_id} report={consistency} request={request} followupContext={reviewProject&&reviewVersion?{project_id:reviewProject.id,version_id:reviewVersion.id,run_id:consistency.run_id}:undefined} onReportChange={updateReport} onSupplement={reviewProject?()=>setSupplementOpen(true):undefined} download={props.client.downloadFinanceExport?.bind(props.client)} busy={props.busy} askBlockedReason={props.askBlockedReason} askQueued={props.askQueued} askRecovery={props.askRecovery} onShowChat={()=>setExpanded(false)} onAsk={async(prompt)=>{
            if(!reviewBinding)throw new Error("請先重新開啟此項目的審閱紀錄。");await props.onLaunch(prompt,reviewBinding);setExpanded(false);
          }}/>{supplementOpen&&reviewProject&&<FinanceHistorySupplement client={client} project={reviewProject} report={consistency} request={request} onComplete={supplemented} onClose={()=>setSupplementOpen(false)}/>}</div>}
      </aside>
    </div>
  );
}

function ReviewList(props: {
  catalog: FinanceCatalog | null;
  onOpen: (path: string) => void;
}) {
  return (
    <section className="finance-review-list">
      <h3>已保存的檢查結果</h3>
      <p className="finance-muted">
        開啟已保存的檢查結果，不會重新執行檢查。內容仍需人手覆核。
      </p>
      {!props.catalog && <p role="status">正在連接 FinanceBuddy…</p>}
      {props.catalog?.reviews.map((r) => (
        <button key={r.review_path} onClick={() => props.onOpen(r.review_path)}>
          <BookOpen size={18} />
          <span>
            <strong>{r.label}</strong>
            <small>
              {r.check_count} 項 · 原件 {r.source.report_fiscal_year} → 目標{" "}
              {r.target_period.fiscal_year}
            </small>
          </span>
          <ChevronRight size={16} />
        </button>
      ))}
      {props.catalog && !props.catalog.reviews.length && (
        <p>未有已保存的檢查結果。請先加入報告並開始檢查。</p>
      )}
      {!!props.catalog?.unavailable.length && (
        <p className="finance-muted">
          以下檢查結果尚未就緒或未能驗證：{props.catalog.unavailable.join("、")}
        </p>
      )}
    </section>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "未能完成此操作。";
}
