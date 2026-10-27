import { consistencyQuestionDisplayText } from "./finance-consistency.js";

export type FinanceWorkflowId =
  | "sources"
  | "report"
  | "review"
  | "peers"
  | "consistency"
  | "commitments";
export const FINANCE_WORKFLOWS: {
  id: FinanceWorkflowId;
  title: string;
  detail: string;
  stage: string;
}[] = [
  {
    id: "sources",
    title: "整合來源資料",
    detail: "整理 Excel、數據來源及缺項",
    stage: "等待資料及權限",
  },
  {
    id: "report",
    title: "生成報告",
    detail: "從已核對數據建立年報／ESG 草稿",
    stage: "等待來源數據",
  },
  {
    id: "review",
    title: "檢查報告",
    detail: "核對披露、規則版本及補件要求",
    stage: "可用 · C2 Scope 1/2",
  },
  {
    id: "peers",
    title: "同行比較",
    detail: "查官方報告，比較數據及口徑",
    stage: "可用 · 排放指標",
  },
  {
    id: "consistency",
    title: "報告一致性核對",
    detail: "中英／跨報告／內部／跨年重述四類初核",
    stage: "可用 · 新稿＋歷史基準",
  },
];

/** Form values are structured inputs, never skill names or free-form user prompts. */
export function buildFinancePrompt(input: {
  workflow: "review" | "peers";
  mode: "same_year" | "next_year_readiness";
  peers: string[];
  sourceVariant?: "official" | "deliberate_errors";
}): string {
  if (input.workflow === "review") {
    const synthetic = input.sourceVariant === "deliberate_errors";
    if (synthetic && input.mode !== "same_year")
      throw new Error("錯漏副本測試只支援本年度英文模式。");
    return [
      "執行 FinanceBuddy 報告檢查。先讀 skills/financebuddy-c2-review/SKILL.md，再按 skill 完成工具核對。",
      "原件：億都 FY2025/26 英文 ESG 報告；範圍只限已支援的 12 項 HKEX C2 Scope 1/2。",
      input.mode === "same_year"
        ? "模式 same_year：核對 FY2025/26 本年度披露。"
        : "模式 next_year_readiness：以上年 FY2025/26 原件評估 FY2026/27 準備度，不得把上年數據視為今年數據。",
      "以 prepare_c2_review 準備證據和官方條文版本，逐項核對原件，再 finalize_c2_review。輸出規則版本、來源及實際 PDF 頁碼；全部保留人工覆核狀態。",
      synthetic
        ? "prepare_c2_review 必須傳 source_variant=deliberate_errors、language=en。這是 TEST ONLY 人為錯漏副本；只讀工具返回的 review-brief 及原頁，按相同條文判讀，不能讀測試答案或把錯漏歸因於公司正式披露。最後連結測試 PDF 並清楚標示這是驗證，不是對原件公司的指控。"
        : "prepare_c2_review 使用 source_variant=official，核對正式原件。",
      "完成後給出可點擊的相對 outputs/ 底稿連結，必須包括 review.json，讓用戶在 Cuby 內置 Reader 打開。不可宣稱全份 ESG 合規或全部通過。",
    ].join("\n");
  }
  const allowed = [
    "Truly International（信利國際，00732）",
    "Solomon Systech（晶門半導體，02878）",
  ];
  if (!input.peers.length || input.peers.some((p) => !allowed.includes(p)))
    throw new Error("請選擇至少一間支援的同行公司。");
  return [
    "執行 FinanceBuddy 同行比較。先讀 skills/financebuddy-peer-comparison/SKILL.md。",
    `以億都 FY2025/26 ESG 作基準，上網尋找 ${input.peers.join("、")} 的 2025 年官方報告。`,
    `第一步必須呼叫 mcp_financebuddy_reports_build_peer_comparison，stock_codes: ${JSON.stringify(input.peers.map((p) => (p.includes("00732") ? "00732" : "02878")))}，output_name 使用新名稱。此工具會直接讀 live 知識庫、在線核對已收錄官方 PDF、抽取及驗算 Scope 1、Scope 2、碳密度，完成 CSV 匯出及逐欄讀回。不要重新從網站首頁盲目搜尋已收錄報告。`,
    "保留精確報告期間、原單位、邊界、Scope 2 基礎、密度分母、來源網址及頁碼。口徑不同要明示，不可直接排名或補猜數值。",
    "成功後直接使用工具的 summary、limits、artifact_links 回覆短表格、口徑差異及 CSV 連結。不可反推製成品產量，亦不可把沒有雙軌排放數值一概當作違規。",
    "若工具報原件改版／來源不可用，才用 web_search 和 read_public_report 查官方替代版本，完成已核實部分的 export_peer_comparison 並讀回；未完成匯出就不得結束成為正式比較結果或再問是否需要繼續已授權工作。",
  ].join("\n");
}
/** Collapse only exact app-generated requests; arbitrary user text remains visible. */
export function financeWorkflowDisplayText(content: string): string | null {
  const consistency = consistencyQuestionDisplayText(content);
  if (consistency) return consistency;
  if (
    content.trim() ===
    buildFinancePrompt({
      workflow: "review",
      mode: "same_year",
      peers: [],
      sourceVariant: "deliberate_errors",
    })
  )
    return "錯漏副本測試（TEST ONLY）：用相同12項 C2 Scope 1／2 流程檢查；結果不代表公司正式披露有這些錯漏。";
  for (const mode of ["same_year", "next_year_readiness"] as const) {
    if (
      content.trim() ===
      buildFinancePrompt({ workflow: "review", mode, peers: [] })
    ) {
      return mode === "same_year"
        ? "檢查億都 FY2025/26 ESG 報告：核對 12 項 C2 Scope 1／2 披露，列出來源、規則及待補資料。"
        : "以上年 FY2025/26 ESG 報告評估 FY2026/27 準備度；保留原件年份，列出今年仍須確認的資料。";
    }
  }
  const peers = [
    "Truly International（信利國際，00732）",
    "Solomon Systech（晶門半導體，02878）",
  ];
  for (const selected of [
    [peers[0]!],
    [peers[1]!],
    peers,
    [...peers].reverse(),
  ]) {
    if (
      content.trim() ===
      buildFinancePrompt({
        workflow: "peers",
        mode: "same_year",
        peers: selected,
      })
    ) {
      return `以億都 FY2025/26 為基準，比較 ${selected.join("、")} 的 2025 官方報告：Scope 1、Scope 2、碳密度、口徑差異及來源，並匯出表格。`;
    }
  }
  return null;
}
