---
name: financebuddy-reporting
description: 將有來源的指標與已核對規則映射產生五類工作底稿、年報及 ESG 草稿，並與獨立保留的歷史真報告事實比較；適用於底稿導出及歷史報告重建，並非正式合規或審計批准。
metadata:
  version: "0.1.3"
---

# 底稿與報告重建

能源消耗／密度及原始活動數據補件清單先用 `financebuddy-energy` 的 `build_energy_baseline`，範圍為 FY2025/26 已驗證能源主表。原始燃料量、換算及面積尚未核實時，不把報告值重組當成獨立計算或重建。

使用本機 `mcp_financebuddy_reports_build_workpapers` 及 `mcp_financebuddy_reports_evaluate_historical_report`；公開 PDF 用 `mcp_financebuddy_reports_read_public_report`，同行 CSV 用 `mcp_financebuddy_reports_export_peer_comparison`。不需要執行 shell 或自行拼 Windows Python 命令。

交付檔案時直接使用工具回傳的 `artifact_links[].markdown`。Cuby 只應用 workspace 相對 `outputs/...` 路徑建立檔案按鈕；不要將 Windows 絕對路徑或 `file://` 放入 Markdown 目的地，否則可能被過濾成空連結並錯開 Cuby 內部網址。舊結果需先確認真實檔案及 workspace，再轉相對路徑，不重建既有底稿只為補連結。

若先建立億都 FY2025/26 中英 ESG 排放主表基線，先讀 `financebuddy-baseline` 並用 `mcp_financebuddy_reports_build_ghg_baseline` 從即時知識庫建立底稿，不用手工填舊答案。這個來源連結樣本仍待原件及業務復核，不能直接把 proposed 事實改為 reviewed 或稱五項需求完成。

先讀 `planning/workflow-input-example.json` 作資料契約；其內容全部虛構，只能參考欄位，不能填進億都報告。實際來源來自 FinanceBuddy 知識庫、用戶提供檔案或已讀取的官方公開文件。每項數值保留唯一 fact ID、主體、指標、原值、原單位、數據期間、營運邊界、方法、密度分母、來源 ID、實際頁／工作表儲存格及 proposed／reviewed 狀態。`reviewed` 只能用於已完成原件核對的項目，不代表業務批准。

工作輸入存為 `outputs/` 或 `dataset/workflows/` 內的 JSON，用檔案寫入工具建立。規則需要原件、版本、有效期、適用性及每項義務的指標／敘述映射；不能只靠模型記憶填條款。舊／新規則不足時保留未確認，不把原本的數據缺口說成新法規要求。全文審核需要完整已確認條款目錄；top-k 檢索或一個案例不等於已覆蓋所有披露。

`build_workpapers` 會建立五個 CSV：潛在披露缺口、定性轉定量、指標基線、同業對照、一致性；另外生成 annual-draft.html、esg-draft.html 及 run.json。這是可編輯內容的初步草稿，未完成 Word／PDF 正式排版。來源或章節不足會明示待補；不能稱完整年報。財務合計與單位換算需有明確輸入及可重跑算式，不能讓模型心算補數。審計意見、董事聲明及管理層承諾只可使用已批准內容，不能自行生成署名或批准。

獨立歷史重建先隔離輸入資料與目標真報告：同年度正式報告只用在評估保留集，不用來取生成事實或草擬正文。可用上一年度模板作結構參考，但不可把上一年度數值當本年度數值。若目前樣本事實取自目標報告，明示「連線及資料重組測試」，不可宣稱獨立重建成功。

評估 reference JSON 包含 `report_source_hashes`、`report_kind: annual` 或 `esg`，以及人工標註 facts（主體、指標、期間、原單位、值及容差）。工具按語義欄位配對，不要求保留集使用相同來源或 fact ID；只比較實際放入指定報告的指標。未指定 report_kind 則只核對事實表，不能稱報告評估。工具同時檢查來源重疊及標出草稿缺章；這不評分全部文字、法定完整性或報告批准。最後報告已測範圍、缺資料、待業務確認及檔案路徑。不要將五個檔案已建立說成五項業務需求已驗收。
