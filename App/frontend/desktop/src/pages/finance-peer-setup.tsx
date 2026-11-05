import { useEffect, useState } from "react";
import { buildPeerComparisonPrompt, FINANCE_PEER_DEFAULTS, FINANCE_PEER_TOPICS, FinancePeerCompanySchema, FinanceProjectListSchema, FinanceProjectSchema, type FinancePeerCompany, type FinancePeerWorkflow, type FinanceProject, type FinanceRequest } from "@memmy/local-api-contracts";

type Request=(input:FinanceRequest)=>Promise<unknown>;
const identity=(c:FinancePeerCompany)=>c.stock_code?"code:"+c.stock_code.toLowerCase():"name:"+c.name.replace(/\s/g,"").toLowerCase();
const DEFAULTS:FinancePeerCompany[]=FINANCE_PEER_DEFAULTS.map(({name,stock_code})=>({name,stock_code}));
const labels={esg_zh:"ESG · 中文",esg_en:"ESG · English",annual_zh:"年報 · 中文",annual_en:"年報 · English"};
export function FinancePeerSetup(props:{request:Request;context?:{id:string;name:string}|null;busy:boolean;onLaunch:(prompt:string,projectId:string)=>Promise<void>;onManageFiles:(project:FinanceProject,versionId:string)=>void}) {
  const [projects,setProjects]=useState<FinanceProject[]>([]),[projectId,setProjectId]=useState(""),[versionId,setVersionId]=useState("");
  const [companies,setCompanies]=useState<FinancePeerCompany[]>(DEFAULTS),[pool,setPool]=useState<FinancePeerCompany[]>(DEFAULTS);
  const [name,setName]=useState(""),[code,setCode]=useState(""),[year,setYear]=useState("2025"),[slot,setSlot]=useState<FinancePeerWorkflow['source_slot']>("esg_zh");
  const [topics,setTopics]=useState<FinancePeerWorkflow['topics']>(["ghg","disclosure"]);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[starting,setStarting]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const project=projects.find(p=>p.id===projectId);
  const version=project?.versions.find(v=>v.id===versionId)??project?.versions.find(v=>v.id===project.active_version)??project?.versions.at(-1);
  const locked=props.busy||saving||starting;
  useEffect(()=>{
    let active=true;setLoading(true);setError("");
    void props.request({action:"project-list"}).then(raw=>{
      if(!active)return;const data=FinanceProjectListSchema.parse(raw);setProjects(data.projects);
      const selected=props.context?data.projects.find(p=>p.external_id===props.context!.id):data.projects.find(p=>p.id===localStorage.getItem("financebuddy.project"))??data.projects[0];
      setProjectId(selected?.id??"");setVersionId("");
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:"未能載入項目。");}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[props.context?.id]);
  useEffect(()=>{
    const saved=project?.peer_companies??DEFAULTS;
    setCompanies(saved);setPool([...DEFAULTS,...saved.filter(c=>!DEFAULTS.some(d=>identity(d)===identity(c)))]);
    setError("");setStatus("");setName("");setCode("");
  },[projectId]);
  useEffect(()=>{
    if(!version)return;
    setYear(version.fiscal_year.slice(0,4));setSlot(version.documents.find(d=>d.slot==="esg_zh")?.slot??version.documents.find(d=>d.slot.startsWith("esg_"))?.slot??version.documents[0]?.slot??"esg_zh");
  },[version?.id]);
  function addCompany(){
    setError("");setStatus("");
    const result=FinancePeerCompanySchema.safeParse({name:name.trim(),...(code.trim()?{stock_code:code.trim()}:{})});
    if(!result.success){setError("請填寫公司名稱（最多100字）；代號可留空。");return;}
    const company=result.data;
    const existing=pool.find(c=>identity(c)===identity(company)||c.name.replace(/\s/g,"").toLowerCase()===company.name.replace(/\s/g,"").toLowerCase());
    if(existing){if(!companies.some(c=>identity(c)===identity(existing)))setCompanies(v=>[...v,existing]);else setError("這間公司已在名單內。");}
    else if(companies.length>=8){setError("每次最多八間，請先移除一間。");return;}
    else {setPool(v=>[...v,company]);setCompanies(v=>[...v,company]);}
    setName("");setCode("");
  }
  async function saveCompanies(){
    if(!project)throw Error("請先選擇項目。");
    const saved=FinanceProjectSchema.parse(await props.request({action:"project-peers",project_id:project.id,expected_revision:project.revision,companies}));
    setProjects(v=>v.map(p=>p.id===saved.id?saved:p));return saved;
  }
  async function remember(){setSaving(true);setError("");try{await saveCompanies();setStatus("同行名單已保存，下次沿用。");}catch(e){setError(e instanceof Error?e.message:"未能儲存。");}finally{setSaving(false);}}
  async function reloadProjects(){setSaving(true);try{const data=FinanceProjectListSchema.parse(await props.request({action:"project-list"}));setProjects(data.projects);setError("");setStatus("項目已更新，可再次儲存或開始比較。");}catch(e){setError(e instanceof Error?e.message:"未能重新載入。");}finally{setSaving(false);}}
  async function start(){
    if(!project||!version)return;
    setStarting(true);setError("");setStatus("");
    try {
      const prompt=buildPeerComparisonPrompt({project_id:project.id,version_id:version.id,fiscal_year:version.fiscal_year,source_slot:slot,report_year:year,companies,topics});
      const saved=await saveCompanies();
      if(!saved.external_id)throw Error("項目未連結 Cuby，請重新載入項目。");
      await props.onLaunch(prompt,saved.external_id);
      setStatus("已在此項目開啟同行比較對話，完成後可開啟匯出表格及來源。");
    }catch(e){setError(e instanceof Error?e.message:"未能開始同行比較。");}finally{setStarting(false);}
  }
  if(loading)return <div className="finance-setup" role="status">正在載入項目文件及同行名單…</div>;
  return <div className="finance-setup finance-peer-setup">
    <div className="finance-task-purpose"><span>ESG 報告驗證 · 同行比較</span><h3>同行披露了甚麼？有甚麼值得參考？</h3><p>沿用項目報告，查官方原件，再對照數據、口徑及披露做法。</p></div>
    <section className="finance-peer-section"><h3>1 · 基準報告</h3>
      <label>項目<select aria-label="同行比較項目" value={projectId} disabled={locked} onChange={e=>{setProjectId(e.target.value);setVersionId("");localStorage.setItem("financebuddy.project",e.target.value);}}><option value="">選擇已存項目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
      {project&&!version&&<p>此項目未有報告，請先加入一份 ESG 或年報。</p>}
      {version&&<><label>文件版本<select aria-label="同行比較報告版本" value={version.id} disabled={locked} onChange={e=>setVersionId(e.target.value)}>{project!.versions.map((v,i)=><option key={v.id} value={v.id}>FY{v.fiscal_year} · 版本{i+1}</option>)}</select></label>
        <label>用作比較的文件<select aria-label="同行比較基準文件" value={slot} disabled={locked} onChange={e=>setSlot(e.target.value as typeof slot)}>{version.documents.map(d=><option key={d.slot} value={d.slot}>{labels[d.slot]} · {d.file_name}</option>)}</select></label>
        <small>使用這份上載版本，無需再次上載。</small></>}
      {project&&<button type="button" className="finance-peer-link" disabled={locked} onClick={()=>props.onManageFiles(project,version?.id??"")}>管理項目文件 →</button>}
      {!projects.length&&<p>先在「一致性審閱」建立項目及上載文件，再回來比較。</p>}
    </section>
    <section className="finance-peer-section"><h3>2 · 選擇同行</h3><p>預設參考名單可修改；公司名單沿用，報告年度及版本每次核對。</p>
      <div className="finance-peer-companies">{pool.map(company=>{const known=FINANCE_PEER_DEFAULTS.find(c=>c.stock_code===company.stock_code);return <label key={identity(company)} className="finance-peer-company"><input type="checkbox" checked={companies.some(c=>identity(c)===identity(company))} disabled={locked} onChange={e=>{setCompanies(v=>e.target.checked?[...v,company]:v.filter(c=>identity(c)!==identity(company)));setStatus("");}}/><span><strong>{company.name}{company.stock_code?` · ${company.stock_code}`:""}</strong><small>{known?`${known.business} · ${known.relationship}`:"自行加入 · 搜尋時確認公司身份及業務"}</small></span></label>;})}</div>
      <div className="finance-peer-add"><input aria-label="新增同行公司名稱" placeholder="輸入公司名稱，例如京東方" maxLength={100} value={name} disabled={locked} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addCompany();}}}/><input aria-label="新增同行公司代號" placeholder="代號（選填）" maxLength={20} value={code} disabled={locked} onChange={e=>setCode(e.target.value)}/><button type="button" disabled={locked||!name.trim()} onClick={addCompany}>加入公司</button></div>
      <button type="button" disabled={locked||!project||companies.length>8} onClick={()=>void remember()}>儲存同行名單</button>
      <label>同行報告年度<input aria-label="同行報告年度" inputMode="numeric" maxLength={4} value={year} disabled={locked} onChange={e=>setYear(e.target.value)}/></label><small>按報告封面年度搜尋；實際起訖日另列，不假設與本公司財年相同。</small>
    </section>
    <section className="finance-peer-section"><h3>3 · 比較內容</h3><div className="finance-peer-topics">{FINANCE_PEER_TOPICS.map(topic=><label key={topic.id}><input type="checkbox" checked={topics.includes(topic.id)} disabled={locked} onChange={e=>setTopics(v=>e.target.checked?[...v,topic.id]:v.filter(t=>t!==topic.id))}/><span><strong>{topic.label}</strong><small>{topic.detail}</small></span></label>)}</div></section>
    <div className="finance-peer-outcome"><strong>輸出：比較表格 · 差異原因 · 可參考做法 · 官方來源及頁碼</strong><p>期間、業務或密度分母不同會寫明；不直接排名。取不到的資料會留空並說明。</p></div>
    {error&&<div className="finance-error" role="alert">{error}<button type="button" disabled={locked} onClick={()=>void reloadProjects()}>重新載入項目</button></div>}{status&&<p role="status">{status}</p>}
    <button className="finance-primary" disabled={locked||!version||!version.documents.some(d=>d.slot===slot)||!companies.length||companies.length>8||!topics.length||!/^20\d{2}$/.test(year)} onClick={()=>void start()}>{starting?"正在儲存設定及開啟比較…":"搜尋官方報告並開始比較"}</button>
    {props.busy&&<p role="status">Cuby 目前正處理對話，完成後可開始比較。</p>}
  </div>;
}
