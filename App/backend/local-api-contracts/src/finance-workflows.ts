export type FinanceWorkflowId =
  | "sources"
  | "report"
  | "review"
  | "peers"
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
    id: "commitments",
    title: "追蹤上年承諾",
    detail: "逐項對照目標、今年成果及依據",
    stage: "待建立專用核對流程",
  },
];

/** Form values are structured inputs, never skill names or free-form user prompts. */
export function buildFinancePrompt(input: {
  workflow: "review" | "peers";
  mode: "same_year" | "next_year_readiness";
  peers: string[];
}): string {
  if (input.workflow === "review")
    return [
      "執行 FinanceBuddy 報告檢查。先讀 skills/financebuddy-c2-review/SKILL.md，再按 skill 完成工具核對。",
      "原件：億都 FY2025/26 英文 ESG 報告；範圍只限已支援的 12 項 HKEX C2 Scope 1/2。",
      input.mode === "same_year"
        ? "模式 same_year：核對 FY2025/26 本年度披露。"
        : "模式 next_year_readiness：以上年 FY2025/26 原件評估 FY2026/27 準備度，不得把上年數據視為今年數據。",
      "以 prepare_c2_review 準備證據和官方條文版本，逐項核對原件，再 finalize_c2_review。輸出規則版本、來源及實際 PDF 頁碼；全部保留人工覆核狀態。",
      "完成後給出可點擊的相對 outputs/ 底稿連結，必須包括 review.json，讓用戶在 Cuby 內置 Reader 打開。不可宣稱全份 ESG 合規或全部通過。",
    ].join("\n");
  const allowed = [
    "Truly International（信利國際，00732）",
    "Solomon Systech（晶門半導體，02878）",
  ];
  if (!input.peers.length || input.peers.some((p) => !allowed.includes(p)))
    throw new Error("請選擇至少一間支援的同行公司。");
  return [
    "執行 FinanceBuddy 同行比較。先讀 skills/financebuddy-peer-comparison/SKILL.md。",
    `以億都 FY2025/26 ESG 作基準，上網尋找 ${input.peers.join("、")} 的 2025 年官方報告。`,
    "比較 Scope 1、Scope 2 及碳密度。以知識庫證據查億都，以 web_search 尋找同行官方來源，再用 read_public_report 核對實際 PDF 頁。",
    "保留精確報告期間、原單位、邊界、Scope 2 基礎、密度分母、來源網址及頁碼。口徑不同要明示，不可直接排名或補猜數值。",
    "用 export_peer_comparison 匯出 CSV 並讀回核對；輸出差異及可參考披露做法，附可點擊 outputs/ 檔案連結。",
  ].join("\n");
}
/** Collapse only exact app-generated requests; arbitrary user text remains visible. */
export function financeWorkflowDisplayText(content: string): string | null {
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
