import type { FinanceProject, ConsistencyReport } from "@memmy/local-api-contracts";

export type ReviewKind = "consistency" | "c2";
export type ReviewVersion = FinanceProject["versions"][number];
export const REVIEW_NAMES = { consistency: "一致性審閱", c2: "C2 披露檢查" };
export const REVIEW_PURPOSES = {
  consistency: "檢查數字、單位及內文說法是否一致；按文件進行中英、年報及跨年對照。",
  c2: "按 HKEX 主板 C2 逐項找披露證據，列出缺項、補件及適用性問題。",
};
export function latestReview(version: ReviewVersion | undefined, kind: ReviewKind) {
  return version?.reviews?.filter(r => r.kind === kind).at(-1);
}
export function reviewStatus(review: NonNullable<ReviewVersion["reviews"]>[number] | undefined) {
  if (!review) return "未開始";
  return { not_started: "已建立，待核對內文", running: "處理中", completed: "檢查完成", partial: "已有結果，部分待核實", failed: "已中斷，可繼續" }[review.status];
}

export function projectStatus(version:ReviewVersion,live?:ConsistencyReport) {
  const consistency=latestReview(version,'consistency'),c2=latestReview(version,'c2');
  const active=live?.compliance?'c2':'consistency';
  const state=(kind:ReviewKind)=>live&&active===kind?(kind==='c2'?live.compliance?.status:live.semantic?.status)??'not_started':(kind==='c2'?c2:consistency)?.status;
  const label=(kind:ReviewKind)=>{const s=state(kind);return !s||s==='not_started'?'未開始':s==='running'?'檢查中':s==='completed'?'檢查完成':s==='failed'?'已中斷，可繼續':'部分完成';};
  const historical=live&&!live.compliance?live.history:undefined;
  const historyStatus=historical?.status??consistency?.history_status;
  const missing=historical?.missing_slots??consistency?.missing_history_slots??[];
  const task=live&&!live.compliance?live.semantic?.tasks.find(t=>t.id==='restatement')?.status:consistency?.restatement_status;
  const history=historyStatus==='unavailable'?'欠去年文件':historyStatus==='not_requested'?'本次未選':historyStatus!=='ready'?'尚未確認':missing.length?'部分欠件':task==='running'?'核對中':task==='completed'?'已執行':task==='failed'?'已中斷，可繼續':'文件已齊，待核對';
  return {consistency:label('consistency'),c2:label('c2'),history,missingHistory:historyStatus==='unavailable'||missing.length>0};
}

export function FinanceProjectPicture(props:{version:ReviewVersion;live?:ConsistencyReport}) {
  const status=projectStatus(props.version,props.live);
  return <div className="finance-project-picture" aria-label="項目整體檢查狀態"><span>一致性：<strong>{status.consistency}</strong></span><span>C2：<strong>{status.c2}</strong></span><span data-missing={status.missingHistory}>跨年：<strong>{status.history}</strong></span></div>;
}

/** Separate saved workflows over the same immutable document version. Navigation never starts a model. */
export function FinanceReviewNavigation(props: {
  kind: ReviewKind; project: FinanceProject; version: ReviewVersion;
  onOpen: (kind: ReviewKind) => void; busy?: boolean;
  report?:ConsistencyReport;onHistory?:()=>void;
}) {
  const index = props.project.versions.findIndex(v => v.id === props.version.id) + 1;
  const status=projectStatus(props.version,props.report);
  return <section className="finance-review-navigation" aria-label="此版本的檢查工作">
    <div className="finance-review-project"><strong>{props.project.title}</strong><span>FY{props.version.fiscal_year} · 文件版本 {index} · {props.version.documents.length}份文件</span><small>兩項檢查共用此版本文件，結果與追問分開保存</small></div>
    <div className="finance-review-steps">{(["consistency", "c2"] as const).map((kind, i) => {
      const current = props.kind === kind, previous = latestReview(props.version, kind);
      return <button key={kind} aria-current={current ? "page" : undefined} aria-disabled={current || props.busy} disabled={props.busy} onClick={() => { if(!current) props.onOpen(kind); }}>
        <span className="finance-review-step-number">{i + 1}</span><span><strong>{REVIEW_NAMES[kind]} · {status[kind]}</strong><small>{current ? "正在查看此結果" : previous ? "查看已保存結果" : "使用同一版文件"}</small></span>
        <span className="finance-review-step-action">{current ? "目前" : previous ? "查看結果 →" : "設定檢查 →"}</span>
      </button>;
    })}<button className="finance-review-history" data-missing={status.missingHistory} disabled={props.busy} onClick={()=>props.onHistory?.()}><span><strong>跨年 · {status.history}</strong><small>{status.missingHistory?'補齊來源後沿用本次審閱':'對照上年度原件'}</small></span><span className="finance-review-step-action">{status.missingHistory?'補文件 →':'查看 →'}</span></button></div>
  </section>;
}
