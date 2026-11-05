import { useEffect, useId, useRef, useState } from "react";
import { availableConsistencyComparisons, FinanceProjectSchema, FinanceProjectListSchema, FinanceProjectBuildSchema, ConsistencyReportSchema, InputInspectionSchema, InputKnowledgeSchema, type FinanceProject, type ConsistencyReport, type ConsistencySlot, type ConsistencyComparison, type FinanceRequest, type InputInspection, type InputKnowledge, type KnowledgeDocument } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { latestReview, reviewStatus, REVIEW_NAMES, REVIEW_PURPOSES, FinanceProjectPicture, type ReviewKind } from "./finance-review-navigation.js";

const SLOTS: [ConsistencySlot, string][] = [["esg_zh", "ESG · 中文"], ["esg_en", "ESG · English"], ["annual_zh", "年報 · 中文"], ["annual_en", "年報 · English"]];
const CHECKS: [ConsistencyComparison, string, string][] = [
  ["internal", "內文與數據", "一份報告即可；查前後矛盾、表格及加總"],
  ["bilingual", "中英對照", "同類報告需有中文及英文版"],
  ["cross_report", "ESG 與年報", "比較今次所選同財年的 ESG 及年報"],
  ["restatement", "與去年比較", "核對比較數字與去年原稿；年度變化本身不代表錯誤"],
];
type Request = (input: FinanceRequest) => Promise<unknown>;
type FieldName = keyof InputInspection["fields"];
type Upload = { key: number; file: File; status: "staging" | "inspecting" | "ready" | "failed"; path?: string; inspection?: InputInspection; error?: string; resolved: Partial<Record<FieldName, string>> };
type CurrentDocument = { slot: ConsistencySlot; file_name: string; sha256: string; origin: "chosen" | "inherited" | "saved" };
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const FIELD_LABELS: Record<FieldName, string> = { issuer: "公司", fiscal_year: "財年", kind: "報告種類", language: "語言" };
function slotLabel(slot: ConsistencySlot) { return SLOTS.find(([s]) => s === slot)?.[1] ?? slot; }
function uploadSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`; }
function fieldValue(upload: Upload, field: FieldName) { const value = upload.inspection?.fields[field]; return value?.status === "identified" ? value.value ?? "" : upload.resolved[field] ?? ""; }
function uploadSlot(upload: Upload): ConsistencySlot | undefined {
  const kind = fieldValue(upload, "kind"), language = fieldValue(upload, "language");
  return (kind === "esg" || kind === "annual") && (language === "en" || language === "zh-Hant") ? `${kind}_${language === "en" ? "en" : "zh"}` : undefined;
}
function previousYear(year: string) { const start = Number(year.slice(0, 4)); return /^20\d{2}\/\d{2}$/.test(year) ? `${start - 1}/${String(start).slice(-2)}` : ""; }
function knowledgeSlot(document: KnowledgeDocument): ConsistencySlot { return `${document.kind}_${document.language === "en" ? "en" : "zh"}`; }
function originalStatus(document: KnowledgeDocument) {
  return { verified: "原稿已核對", missing: "原稿不在此電腦", hash_mismatch: "原稿版本不符", unreadable: "原稿未能讀取", unavailable: "原稿未能確認" }[document.original_status];
}
function sourceReady(document: KnowledgeDocument) {
  return document.original_status === "verified" && (document.indexed_status === "verified" || document.indexed_status === "local_verified");
}
function readStatus(document: KnowledgeDocument) {
  if (document.indexed_status === "local_verified") return "隨附公開原件已核對";
  return document.indexed_status === "verified" ? "讀取已核對" : "讀取未確認";
}
function message(error: unknown, fallback: string) { return error instanceof Error && error.name !== "ZodError" ? error.message : fallback; }

export function FinanceProjectSetup(props: { client: MemmyAgentClient; request: Request; context?: { id: string; name: string } | null; initialSelection?: { project_id: string; version_id: string }; initialMode?: ReviewKind; onSwitch?: (kind: ReviewKind, project: FinanceProject, versionId: string) => void; onComplete: (report: ConsistencyReport, project: FinanceProject) => void | Promise<void> }) {
  const [projects, setProjects] = useState<FinanceProject[]>([]), [id, setId] = useState("");
  const [title, setTitle] = useState(props.context?.name ?? "億都報告"), [versionId, setVersionId] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]), [busy, setBusy] = useState(false), [loadingProjects, setLoadingProjects] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [error, setError] = useState(""), [phase, setPhase] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]), [dragging, setDragging] = useState(false);
  const [knowledge, setKnowledge] = useState<InputKnowledge>(), [knowledgeError, setKnowledgeError] = useState("");
  const [history, setHistory] = useState<{ key: string; value?: InputKnowledge; error?: string }>();
  const fileInput = useRef<HTMLInputElement>(null), uploadId = useId();
  const generation = useRef(0), nextFile = useRef(0), activeFiles = useRef(new Set<number>()), knowledgeSequence = useRef(0);
  const [comparisons, setComparisons] = useState<ConsistencyComparison[]>(CHECKS.map(([s]) => s));
  const reviewMode = props.initialMode ?? "consistency";
  const [periodStart, setPeriodStart] = useState(""), [periodEnd, setPeriodEnd] = useState("");
  const [mandatory, setMandatory] = useState<"yes" | "no" | "unknown">("unknown"), [primary, setPrimary] = useState<"esg_zh" | "esg_en" | "">("");
  const project = projects.find(p => p.id === id);
  const version = project?.versions.find(v => v.id === versionId) ?? project?.versions.find(v => v.id === project.active_version) ?? project?.versions.at(-1);
  // Save inherits the active version, even while the user is reading an older saved result.
  const activeVersion = project?.versions.find(v => v.id === project.active_version) ?? project?.versions.at(-1);
  const previous = latestReview(version, reviewMode), lastRun = previous?.run_id;
  const pendingC2 = reviewMode === "c2" && previous?.status === "not_started";
  const versionSlots = version?.documents.map(d => d.slot) ?? [];
  const years = [...new Set(uploads.map(u => fieldValue(u, "fiscal_year")).filter(Boolean))];
  const year = years.length === 1 ? years[0]! : "";
  const pendingSlots = uploads.flatMap(u => { const slot = uploadSlot(u); return slot ? [slot] : []; });
  const unsupported = uploads.some(u => u.inspection && Object.values(u.inspection.fields).some(field => field.status === "unsupported"));
  const issuerConflict = uploads.some(u => fieldValue(u, "issuer") && fieldValue(u, "issuer") !== "yeebo");
  const duplicateBytes = uploads.some((u, i) => u.inspection && uploads.some((other, j) => j < i && other.inspection?.sha256 === u.inspection!.sha256));
  const duplicateSlots = pendingSlots.length !== new Set(pendingSlots).size;
  const ready = uploads.length > 0 && uploads.length <= 4 && !unsupported && !issuerConflict && !duplicateBytes && !duplicateSlots && years.length === 1 && /^20\d{2}\/\d{2}$/.test(year) && uploads.every(u => u.status === "ready" && u.path && u.inspection?.inspection_id && fieldValue(u, "issuer") === "yeebo" && uploadSlot(u) && fieldValue(u, "fiscal_year"));
  const inherited = activeVersion?.fiscal_year === year ? activeVersion.documents : [];
  const currentDocuments: CurrentDocument[] = [
    ...inherited.filter(d => !pendingSlots.includes(d.slot)).map(d => ({ ...d, origin: "inherited" as const })),
    ...uploads.flatMap(u => { const slot = uploadSlot(u); return slot && u.inspection ? [{ slot, file_name: u.file.name, sha256: u.inspection.sha256, origin: "chosen" as const }] : []; }),
  ];
  const uploadSlots = [...new Set(currentDocuments.map(d => d.slot))];
  const planYear = uploads.length ? year : version?.fiscal_year ?? "";
  const planDocuments: CurrentDocument[] = uploads.length ? currentDocuments : version?.documents.map(d => ({ ...d, origin: "saved" as const })) ?? [];
  const planSlots = [...new Set(planDocuments.map(d => d.slot))];
  const hasPlan = uploads.length ? ready : !!version && planSlots.length > 0;
  const historyKey = hasPlan ? `${planYear}:${[...planSlots].sort().join(",")}` : "";
  const historyValue = history?.key === historyKey ? history.value : undefined;
  const historyError = history?.key === historyKey ? history.error : undefined;
  const priorYear = previousYear(planYear);
  const prior = planSlots.map(slot => ({ slot, documents: historyValue?.documents.filter(d => d.fiscal_year === priorYear && knowledgeSlot(d) === slot) ?? [] }));
  const historyReady = !!historyValue && !historyValue.error && prior.length > 0 && prior.every(item => item.documents.length === 1 && sourceReady(item.documents[0]!));
  const historySettled = !!historyKey && history?.key === historyKey && (!!history.value || !!history.error);
  function enabled(slots: ConsistencySlot[], preview = false) { const available = availableConsistencyComparisons(slots); return comparisons.filter(c => available.includes(c) && (!preview || c !== "restatement" || historyReady)); }
  function canStart(slots: ConsistencySlot[], preview = false) { return reviewMode === "c2" ? slots.some(s => s.startsWith("esg_")) : enabled(slots, preview).length > 0; }
  function clearPending() { generation.current++; activeFiles.current.clear(); setUploads([]); setUploadErrors([]); setHistory(undefined); setLoadingProjects(false); setPeriodStart(""); setPeriodEnd(""); setPrimary(""); setPhase(""); setError(""); }
  function remember(p: FinanceProject, vid = p.active_version ?? "") { setProjects(v => [p, ...v.filter(x => x.id !== p.id)]); setId(p.id); setVersionId(vid); localStorage.setItem("financebuddy.project", p.id); }
  async function loadProjects(selection?: { project_id: string; version_id: string }) {
    const epoch = generation.current; setLoadingProjects(true); setError("");
    try {
      const value = FinanceProjectListSchema.parse(await props.request({ action: "project-list" }));
      if (epoch !== generation.current) return;
      const selected = selection && value.projects.find(p => p.id === selection.project_id);
      if (selection && !selected) throw Error("這個已保存報告項目目前無法找到；未有建立新項目。請重試載入。");
      if (selection && !selected?.versions.some(v => v.id === selection.version_id)) throw Error("所選已保存文件版本目前無法找到；未有改用其他版本。請重試載入。");
      setProjects(value.projects);
      if (selected) { setId(selected.id); setVersionId(selected.versions.find(v => v.id === selection.version_id)?.id ?? selected.active_version ?? ""); setProjectSettingsOpen(true); }
    } catch (e) { if (epoch === generation.current) setError(message(e, "未能載入已保存項目。請稍後重試。")); }
    finally { if (epoch === generation.current) setLoadingProjects(false); }
  }
  useEffect(() => {
    clearPending(); setBusy(false); setProjects([]); setId(""); setVersionId(""); setProjectSettingsOpen(false); setLoadingProjects(false); setTitle(props.context?.name ?? "億都報告"); setKnowledge(undefined); setKnowledgeError("");
    let disposed = false;
    void props.request({ action: "input-knowledge" }).then(value => { if (!disposed) setKnowledge(InputKnowledgeSchema.parse(value)); }).catch(e => { if (!disposed) setKnowledgeError(message(e, "知識庫暫時未能連接或回覆未完整。")); });
    if (props.initialSelection) void loadProjects(props.initialSelection);
    return () => { disposed = true; generation.current++; activeFiles.current.clear(); };
  }, [props.context?.id, props.initialSelection?.project_id, props.initialSelection?.version_id]);
  useEffect(() => {
    const sequence = ++knowledgeSequence.current, epoch = generation.current;
    if (!historyKey) { setHistory(undefined); return; }
    setHistory({ key: historyKey });
    void props.request({ action: "input-knowledge", fiscal_year: planYear, slots: planSlots }).then(value => {
      if (sequence === knowledgeSequence.current && epoch === generation.current) setHistory({ key: historyKey, value: InputKnowledgeSchema.parse(value) });
    }).catch(e => { if (sequence === knowledgeSequence.current && epoch === generation.current) setHistory({ key: historyKey, error: message(e, "未能確認去年原稿，請稍後重試。") }); });
  }, [historyKey]);
  async function inspect(upload: Upload, epoch: number) {
    const live = () => epoch === generation.current && activeFiles.current.has(upload.key);
    const update = (patch: Partial<Upload>) => { if (live()) setUploads(current => current.map(u => u.key === upload.key ? { ...u, ...patch } : u)); };
    try {
      const staged = await props.client.uploadAgentMedia([{ blob: upload.file, name: upload.file.name, mime: "application/pdf", kind: "file" }]);
      if (!live()) return;
      const media = staged[0];
      if (staged.length !== 1 || media?.kind !== "file" || media.mime !== "application/pdf" || !media.url || !media.path) throw Error("文件暫存未完成。請移除後重新加入。");
      update({ status: "inspecting", path: media.path });
      const inspection = InputInspectionSchema.parse(await props.request({ action: "input-inspect", media_ref: media.url, file_name: upload.file.name }));
      if (!inspection.inspection_id) throw Error("文件識別憑證未完成。請移除後重新加入。");
      update({ status: "ready", inspection });
    } catch (e) { update({ status: "failed", error: message(e, "未能讀取完整的 PDF 識別結果。請移除後重新加入。") }); }
  }
  function addFiles(files: File[]) {
    if (busy) return;
    const accepted: Upload[] = [], problems: string[] = [];
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name) || !["", "application/pdf", "application/x-pdf", "application/octet-stream"].includes(file.type.toLowerCase())) problems.push(`「${file.name}」不是 PDF。請選擇 .pdf 文件。`);
      else if (file.size > MAX_PDF_BYTES) problems.push(`「${file.name}」超過30 MB。請先縮小 PDF 或選擇較小的文件。`);
      else if (activeFiles.current.size + accepted.length >= 4) problems.push(`未加入「${file.name}」：每個版本最多四份。請先移除不需要的文件。`);
      else accepted.push({ key: ++nextFile.current, file, status: "staging", resolved: {} });
    }
    setUploadErrors(problems); setError("");
    if (!accepted.length) return;
    for (const upload of accepted) activeFiles.current.add(upload.key);
    setUploads(current => [...current, ...accepted]);
    const epoch = generation.current;
    // Limit local staging/inspection to one file at a time within each selection.
    void (async () => { for (const upload of accepted) { if (epoch !== generation.current) break; if (activeFiles.current.has(upload.key)) await inspect(upload, epoch); } })();
  }
  function removeFile(key: number) { activeFiles.current.delete(key); setUploads(current => current.filter(u => u.key !== key)); }
  function resolveField(key: number, field: FieldName, value: string) { setUploads(current => current.map(u => u.key === key ? { ...u, resolved: { ...u.resolved, [field]: value } } : u)); }
  async function begin(target: FinanceProject, vid: string, chosen: ConsistencyComparison[]) {
    const saved = target.versions.find(v => v.id === vid)!;
    if (reviewMode === "c2") chosen = ["internal", ...(historyReady ? ["restatement" as const] : [])];
    if (!chosen.length) throw Error("請選至少一項可進行的檢查。");
    setPhase("正在讀取 PDF 及建立檢查結果…");
    const result = FinanceProjectBuildSchema.parse(await props.request({ action: "project-build", project_id: target.id, version_id: vid, kind: reviewMode, comparisons: chosen }));
    remember(result.project, vid); let report = result.report; localStorage.setItem(`financebuddy.${reviewMode}.lastRun`, report.run_id); setPhase("正在啟動內文核對…");
    if (reviewMode === "c2") { setPhase("正在啟動完整 C2 披露檢查…"); report = await startC2(report.run_id, saved); }
    else try { report = ConsistencyReportSchema.parse(await props.request({ action: "consistency-semantic-start", run_id: report.run_id })); } catch { /* Reader preserves numerical results and exposes retry. */ }
    await props.onComplete(report, result.project);
  }
  async function startC2(runId: string, saved: FinanceProject["versions"][number]) {
    const esg = saved.documents.filter(d => d.slot.startsWith("esg_")); if (!esg.length) throw Error("請加入至少一份 ESG 報告。");
    const selected = (esg.some(d => d.slot === primary) ? primary : esg[0]!.slot) as "esg_zh" | "esg_en";
    return ConsistencyReportSchema.parse(await props.request({ action: "c2-start", run_id: runId, profile: { period_start: periodStart || `${saved.fiscal_year.slice(0, 4)}-04-01`, period_end: periodEnd || `${Number(saved.fiscal_year.slice(0, 4)) + 1}-03-31`, part_d_mandatory: mandatory, primary_esg_slot: selected } }));
  }
  async function save(andStart = false) {
    if (!ready || !historySettled || busy) return;
    const epoch = generation.current;
    setBusy(true); setError("");
    try {
      let target = project;
      if (!target) { target = FinanceProjectSchema.parse(await props.request({ action: "project-create", title, ...(props.context ? { external_id: props.context.id } : {}) })); if (epoch !== generation.current) return; remember(target); }
      const documents = uploads.map(u => ({ slot: uploadSlot(u)!, path: u.path!, file_name: u.file.name, inspection_id: u.inspection!.inspection_id!, ...(u.inspection!.fields.issuer.status !== "identified" && u.resolved.issuer === "yeebo" ? { confirmed_issuer: "yeebo" as const } : {}) }));
      setPhase("正在保存已確認的文件…");
      target = FinanceProjectSchema.parse(await props.request({ action: "project-save", project_id: target.id, expected_revision: target.revision, fiscal_year: year, documents }));
      if (epoch !== generation.current) return;
      const chosen = enabled(uploadSlots, true);
      remember(target); activeFiles.current.clear(); setUploads([]); const saved = target.versions.find(v => v.id === target.active_version)!;
      if (andStart) await begin(target, saved.id, chosen); else setPhase("文件已保存，可開始審閱。");
    } catch (e) { if (epoch === generation.current) setError(message(e, "未能儲存報告。請重新確認文件後重試。")); } finally { if (epoch === generation.current) setBusy(false); }
  }
  async function run(openLast = false) {
    if (!project || !version) return; setBusy(true); setError("");
    try {
      if (openLast && lastRun) { setPhase(`正在開啟${REVIEW_NAMES[reviewMode]}結果…`); localStorage.setItem(`financebuddy.${reviewMode}.lastRun`, lastRun); let report = ConsistencyReportSchema.parse(await props.request({ action: "consistency-read", run_id: lastRun })); if (reviewMode === "consistency" && report.compliance) throw Error("這份是 C2 檢查結果，請重新載入檢查清單。"); if (reviewMode === "c2" && !report.compliance) report = await startC2(lastRun, version); await props.onComplete(report, project); }
      else await begin(project, version.id, enabled(versionSlots, true));
    } catch (e) { setError(e instanceof Error ? e.message : "未能開始審閱。"); } finally { setBusy(false); }
  }
  function choices(slots: ConsistencySlot[], preview = false) {
    const available = availableConsistencyComparisons(slots);
    return <fieldset className="finance-review-choices"><legend>今次檢查甚麼</legend>{CHECKS.map(([s, label, help]) => {
      const can = available.includes(s) && (!preview || s !== "restatement" || historyReady);
      return <label key={s} className={!can ? "unavailable" : ""}><input type="checkbox" disabled={busy || !can} checked={can && comparisons.includes(s)} onChange={e => setComparisons(v => e.target.checked ? [...v, s] : v.filter(x => x !== s))} /><span><strong>{label}</strong><small>{can ? help : s === "restatement" && preview ? "去年同類同語言原稿未齊；今次不做，其他檢查可繼續" : s === "bilingual" ? "未有對應中英兩版，今次不做" : s === "cross_report" ? "未有 ESG 及年報，今次不做" : "加入文件後可選"}</small></span></label>;
    })}</fieldset>;
  }
  const selectedYear = uploads.length ? year : version?.fiscal_year ?? "";
  const c2Settings = reviewMode === "c2" && <section className="finance-c2-settings"><p>全本主板 C2 · 148 個核對項。先核對所選 ESG；年報可稍後補交。另一語言不會用來填補本稿缺漏。</p><div><label>報告開始日<input type="date" aria-label="C2報告開始日" disabled={busy} value={periodStart || (selectedYear ? `${selectedYear.slice(0, 4)}-04-01` : "")} onChange={e => setPeriodStart(e.target.value)} /></label><label>報告結束日<input type="date" aria-label="C2報告結束日" disabled={busy} value={periodEnd || (selectedYear ? `${Number(selectedYear.slice(0, 4)) + 1}-03-31` : "")} onChange={e => setPeriodEnd(e.target.value)} /></label></div><label>氣候披露類別<select aria-label="C2氣候披露類別" disabled={busy} value={mandatory} onChange={e => setMandatory(e.target.value as typeof mandatory)}><option value="unknown">待確認（可以先核對）</option><option value="no">一般主板公司，過往未被納入大型股強制披露</option><option value="yes">適用大型股強制披露，或過往已被納入</option></select></label><small>按財年、上一年度指數成份及過往適用狀態判斷；未確認時不會猜測。</small><label>本次核對語言<select aria-label="C2核對版本" disabled={busy} value={primary || ((uploads.length ? uploadSlots : versionSlots).find(s => s.startsWith("esg_")) ?? "")} onChange={e => setPrimary(e.target.value as typeof primary)}>{(uploads.length ? uploadSlots : versionSlots).filter(s => s.startsWith("esg_")).map(s => <option key={s} value={s}>{slotLabel(s)}</option>)}</select></label></section>;
  const knownYears = [...new Set(knowledge?.documents.map(d => d.fiscal_year) ?? [])].sort().reverse();
  const validSave = !busy && !!title.trim() && ready && historySettled;
  if (props.initialSelection && (!project || !version)) return <section className="finance-setup finance-project-setup" aria-label="載入已保存文件">
    <h3>查看已保存文件／繼續設定</h3>
    {error ? <p role="alert">{error}</p> : <p role="status">正在載入所選項目及文件版本…</p>}
    <p>只讀取已保存文件；不會重新上載、建立項目或開始檢查。</p>
    <button type="button" disabled={loadingProjects} onClick={() => void loadProjects(props.initialSelection)}>{loadingProjects ? "正在載入…" : "重試載入已保存文件"}</button>
  </section>;
  return <div className="finance-setup finance-project-setup">
    <div className={`finance-task-purpose ${reviewMode}`}><span>{reviewMode === "consistency" ? "內容核對" : "規則披露"}</span><h3>{reviewMode === "consistency" ? "報告的數字與說法有沒有矛盾？" : "報告有沒有披露 C2 要求的內容？"}</h3><p>{REVIEW_PURPOSES[reviewMode]}</p></div>
    <div className="finance-project-heading"><h3>加入今次要核對的報告</h3><span>已知歷年報告毋須重傳</span></div>
    <p className="finance-review-intro">只加入今次稿件；財年、種類及語言由 PDF 內容識別。一份{reviewMode === "c2" ? " ESG" : "報告"}即可開始。</p>
    {version && <section className="finance-project-files"><label>文件版本<select aria-label="項目報告版本" value={version.id} disabled={busy || uploads.length > 0} onChange={e => { clearPending(); setVersionId(e.target.value); }}>{project!.versions.map((v, i) => <option key={v.id} value={v.id}>FY{v.fiscal_year} · 版本{i + 1}</option>)}</select></label>
      <FinanceProjectPicture version={version} />
      {version.documents.map(d => <div key={d.slot}><strong>{slotLabel(d.slot)}</strong><span title={d.file_name}>{d.file_name}</span><small>{uploadSize(d.bytes)}</small></div>)}
      {previous && <p className="finance-task-saved-result">此版本的{REVIEW_NAMES[reviewMode]}：{reviewStatus(previous)}</p>}
      {lastRun && !pendingC2 && <div className="finance-project-actions"><button className="finance-primary" disabled={busy || uploads.length > 0} onClick={() => void run(true)}>開啟{REVIEW_NAMES[reviewMode]}結果</button></div>}
    </section>}
    <section className="finance-project-upload" aria-label="今次稿件與歷年報告">
      <div className="finance-input-start">
        <div className={`finance-upload-dropzone${dragging && !busy ? " finance-upload-dropzone--active" : ""}`} role="group" aria-labelledby={`${uploadId}-title`} aria-describedby={`${uploadId}-hint`} aria-disabled={busy}
          onDragEnter={event => { event.preventDefault(); event.stopPropagation(); if (!busy) setDragging(true); }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
          <strong id={`${uploadId}-title`}>加入報告 PDF</strong><input ref={fileInput} id={`${uploadId}-picker`} hidden type="file" multiple accept="application/pdf,.pdf" aria-label="加入報告 PDF" disabled={busy} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="finance-upload-add" aria-controls={`${uploadId}-picker`} aria-describedby={`${uploadId}-hint`} disabled={busy} onClick={() => fileInput.current?.click()}>加入 PDF</button>
          <p id={`${uploadId}-hint`}>拖放 PDF 到此處，或按「加入 PDF」選擇文件。每份最多30 MB，最多四份。</p><small>選擇後會暫存到此電腦並讀取內容；尚未保存項目、加入知識庫或開始檢查。</small>
        </div>
        <aside className="finance-input-knowledge" aria-label="歷年原稿">
          <strong>{knowledge?.source_mode === "public_snapshot" ? "億都公開報告 · 隨附版本" : `知識庫 · ${knowledge?.entity_name ?? "億都（Yeebo）"}`}</strong>
          {knowledge?.source_mode === "public_snapshot" && <p>使用隨安裝附送的港交所公開報告，範圍為 FY2023/24 至 FY2025/26。</p>}
          {!knowledge && !knowledgeError && <p role="status">正在讀取已知報告清單…</p>}
          {(knowledgeError || knowledge?.error) && <p role="alert">暫未能確認知識庫清單。{knowledgeError || knowledge?.error}</p>}
          {knowledge && !knowledge.error && <><table><caption className="finance-input-caption">已知年份、種類及語言</caption><thead><tr><th>財年</th><th>ESG</th><th>年報</th></tr></thead><tbody>{knownYears.map(fy => <tr key={fy}><th>FY{fy}</th>{(["esg", "annual"] as const).map(kind => <td key={kind}>{["zh-Hant", "en"].filter(language => knowledge.documents.some(d => d.fiscal_year === fy && d.kind === kind && d.language === language)).map(language => language === "en" ? "English" : "中文").join(" · ") || "未有記錄"}</td>)}</tr>)}</tbody></table>{!knownYears.length && <p>目前未有可確認的歷年報告。</p>}<small>這是已知清單；加入今次稿件後再核對去年原稿及讀取狀態。更早年份只供查看，今次不作多年比較。</small><details className="finance-input-known-details"><summary>查看歷年檔案及可用狀態</summary>{knowledge.documents.map((d, i) => <p key={`${d.source_id}-${i}`}><strong>FY{d.fiscal_year} · {slotLabel(knowledgeSlot(d))}</strong><span>{d.file_name}</span><small>{originalStatus(d)} · {readStatus(d)}{d.reason ? ` · ${d.reason}` : ""}</small></p>)}</details></>}
        </aside>
      </div>
      {uploadErrors.length > 0 && <div className="finance-upload-errors" role="alert">{uploadErrors.map((message, index) => <p key={index}>{message}</p>)}</div>}
      {uploads.length > 0 && <><p className="finance-upload-next" role="status">已加入 {uploads.length} 份，尚未儲存。{uploads.some(u => u.status === "staging" || u.status === "inspecting") ? "正在從 PDF 內容識別；毋須按檔名猜測。" : ready ? reviewMode === "c2" && !canStart(uploadSlots) ? "開始 C2 檢查需加入 ESG 報告；亦可只儲存。" : "請核對下方今次稿件及去年來源，再選擇儲存或開始。" : "請處理標示的未確定資料或衝突。"}</p>
        {uploads.map((u, i) => <article className="finance-upload-row finance-input-file" key={u.key}><header><span><strong title={u.file.name}>{u.file.name}</strong><small>{uploadSize(u.file.size)} · {u.status === "staging" ? "正在本機暫存…" : u.status === "inspecting" ? "正在讀取 PDF…" : "已暫存，尚未儲存"}</small></span><button type="button" aria-label={`移除文件${i + 1}`} disabled={busy} onClick={() => removeFile(u.key)}>移除</button></header>
          {u.error && <p role="alert">未能識別：{u.error}</p>}
          {u.inspection && <><p className="finance-input-identity"><strong>{fieldValue(u, "issuer") === "yeebo" ? "億都（Yeebo）" : "公司待確認"}</strong><span>{fieldValue(u, "fiscal_year") ? `FY${fieldValue(u, "fiscal_year")}` : "財年待確認"}</span><span>{uploadSlot(u) ? slotLabel(uploadSlot(u)!) : "種類／語言待確認"}</span>{u.inspection.test_only && <strong>TEST ONLY · 合成測試文件</strong>}</p>
            {Object.entries(u.resolved).some(([, value]) => value) && <small>已由你按原稿確認：{(Object.keys(u.resolved) as FieldName[]).filter(field => u.resolved[field]).map(field => FIELD_LABELS[field]).join("、")}。其餘資料來自 PDF 內容。</small>}
            {(Object.keys(FIELD_LABELS) as FieldName[]).map(field => { const result = u.inspection!.fields[field]; if (result.status === "identified") return null; if (result.status === "unsupported") return <p role="alert" key={field}>{FIELD_LABELS[field]}不在目前支援範圍。請移除此文件；目前只支援億都的中英文 ESG／年報。</p>; return <label key={field} className="finance-input-unresolved">{FIELD_LABELS[field]}未能確定{field === "fiscal_year" ? <input aria-label={`文件${i + 1}財年`} placeholder="例如 2026/27" value={u.resolved[field] ?? ""} disabled={busy} onChange={e => resolveField(u.key, field, e.target.value)} /> : <select aria-label={`文件${i + 1}${FIELD_LABELS[field]}`} value={u.resolved[field] ?? ""} disabled={busy} onChange={e => resolveField(u.key, field, e.target.value)}><option value="">請按原稿確認</option>{(field === "issuer" ? [["yeebo", "億都（Yeebo）"]] : field === "kind" ? [["esg", "ESG"], ["annual", "年報"]] : [["zh-Hant", "中文"], ["en", "English"]]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</label>; })}
            <details className="finance-input-evidence"><summary>查看識別依據及文件版本</summary><p>SHA256 <code>{u.inspection.sha256}</code> · {u.inspection.pages} 頁</p>{(Object.keys(FIELD_LABELS) as FieldName[]).map(field => <div key={field}><strong>{FIELD_LABELS[field]}</strong>{u.inspection!.fields[field].evidence.length ? u.inspection!.fields[field].evidence.map((evidence, n) => <blockquote key={n}>PDF p.{evidence.page} · {evidence.quote}</blockquote>) : <p>未取得可靠的原文依據，請按原稿確認。</p>}</div>)}{u.inspection.limits.map((limit, n) => <p key={n}>{limit}</p>)}</details>
          </>}
        </article>)}
        {years.length > 1 && <p role="alert" className="finance-input-conflict">今次稿件包含不同財年（{years.map(fy => `FY${fy}`).join("、")}）。請移除歷年文件，只保留今次同一財年的稿件；歷年來源會另行列出。</p>}
        {issuerConflict && <p role="alert" className="finance-input-conflict">今次稿件的公司不同，請移除其他公司的文件。</p>}
        {duplicateBytes && <p role="alert" className="finance-input-conflict">有相同內容的 PDF，即使檔名不同亦只需一份。請移除重複文件。</p>}
        {duplicateSlots && <p role="alert" className="finance-input-conflict">同一種類及語言有多個版本。請保留今次要核對的一份，移除其他版本。</p>}
      </>}
      {hasPlan && <section className="finance-input-plan" aria-label="儲存前文件及比較預覽"><h4>今次使用 · FY{planYear}</h4><p>以下是今次稿件。核對以此稿件為準。</p>
        <ul>{planDocuments.map(d => <li key={d.slot}><strong>{slotLabel(d.slot)}</strong><span>{d.file_name}</span><small>{d.origin === "saved" ? "所選項目已保存文件" : d.origin === "inherited" ? "沿用項目現有文件" : inherited.some(old => old.slot === d.slot) ? `替換現有：${inherited.find(old => old.slot === d.slot)!.file_name}；原版本保留` : "今次選擇"} · SHA256 {d.sha256.slice(0, 12)}…</small><details><summary>文件版本資料</summary><code>SHA256 {d.sha256}</code>{d.origin !== "chosen" && <small>項目版本 {d.origin === "saved" ? version?.id : activeVersion?.id}</small>}</details></li>)}</ul>
        <p>{availableConsistencyComparisons(planSlots).includes("cross_report") ? `同財年對照：以上 FY${planYear} ESG 與年報。` : "同財年 ESG／年報尚未齊備；其他可用檢查仍可進行。"}</p><h4>去年原稿 · FY{priorYear}（{historyValue?.source_mode === "public_snapshot" ? "隨附公開報告，只讀" : "知識庫，只讀"}）</h4>
        {!historySettled && <p role="status">正在確認去年同類、同語言的原稿…</p>}
        {(historyError || historyValue?.error) && <p role="alert">去年來源暫未能確認：{historyError || historyValue?.error}。今次不作去年比較。</p>}
        {historyValue && !historyValue.error && <ul>{prior.map(item => <li key={item.slot}><strong>{slotLabel(item.slot)}</strong>{item.documents.length === 1 ? <><span>{item.documents[0]!.file_name}</span><small>{originalStatus(item.documents[0]!)} · {readStatus(item.documents[0]!)} · 版本 {item.documents[0]!.source_id} · SHA256 {item.documents[0]!.sha256.slice(0, 12)}…</small>{item.documents[0]!.reason && <small>{item.documents[0]!.reason}</small>}<details><summary>文件版本資料</summary><code>SHA256 {item.documents[0]!.sha256}</code></details></> : <span>{item.documents.length ? "有多個來源版本，未能唯一確認；今次不作去年比較。" : `缺少 FY${priorYear} 同類同語言原稿；不會改用更早年份。`}</span>}</li>)}</ul>}
        <small>年度數字改變本身不代表錯誤；去年比較核對的是比較數字與原稿。原稿未齊時可以先做其他檢查。</small>
      </section>}
      {version && !uploads.length && <details className="finance-new-review" open={!lastRun || pendingC2}><summary>{lastRun && !pendingC2 ? `另開一次${REVIEW_NAMES[reviewMode]}` : "檢查設定"}</summary>
        {reviewMode === "c2" && c2Settings}{reviewMode === "consistency" && choices(versionSlots, true)}
        <div className="finance-project-actions"><button className="finance-primary" disabled={busy || !historySettled || !canStart(versionSlots, true)} onClick={() => void run(pendingC2)}>{pendingC2 ? "繼續啟動 C2 披露檢查" : `開始${reviewMode === "c2" ? " " : ""}${REVIEW_NAMES[reviewMode]}`}</button></div>
      </details>}
      {(uploads.length > 0 || !version) && <><section className="finance-input-project"><button type="button" className="finance-input-project-toggle" aria-expanded={projectSettingsOpen} disabled={busy} onClick={() => setProjectSettingsOpen(open => !open)}>{project ? `儲存到：${project.title}` : "儲存到新項目"} · 更改</button>{projectSettingsOpen && <><label>項目<select aria-label="報告項目" disabled={busy} value={id} onChange={e => { clearPending(); setId(e.target.value); setVersionId(""); }}><option value="">＋ 新項目{props.context ? ` · ${props.context.name}` : ""}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>{!project && <label>名稱<input aria-label="新項目名稱" value={title} disabled={busy} onChange={e => setTitle(e.target.value)} maxLength={100} /></label>}<button type="button" disabled={busy || loadingProjects} onClick={() => void loadProjects(undefined)}>{loadingProjects ? "正在載入…" : "載入已保存項目"}</button></>}</section>
        {reviewMode === "consistency" && choices(uploadSlots, true)}{reviewMode === "c2" && c2Settings}
        <div className="finance-project-actions"><button className="finance-primary" disabled={!validSave || !canStart(uploadSlots, true)} onClick={() => void save(true)}>儲存並開始{REVIEW_NAMES[reviewMode]}</button><button disabled={!validSave} onClick={() => void save(false)}>只儲存文件</button></div><small>只有按儲存才建立項目版本；按開始才執行檢查。文件及修訂保存在此電腦。</small>
      </>}
    </section>
    {project && version && props.onSwitch && <div className="finance-review-next"><span>{reviewMode === "consistency" ? "要核對 HKEX 披露要求？" : "要找數字、翻譯或前後說法的差異？"}</span><button disabled={busy || uploads.length > 0} onClick={() => props.onSwitch!(reviewMode === "consistency" ? "c2" : "consistency", project, version.id)}>使用同一版文件，前往{REVIEW_NAMES[reviewMode === "consistency" ? "c2" : "consistency"]} →</button></div>}
    {phase && <p role="status">{busy ? "◌ " : ""}{phase}</p>}{error && <div className="finance-error" role="alert">{error}</div>}
  </div>;
}
