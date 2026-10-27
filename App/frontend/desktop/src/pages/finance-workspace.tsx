import { NativeFinanceReader } from "./finance-reader-view.js";
import { ConsistencySetup, ConsistencyReader } from "./finance-consistency-view.js";
import { useEffect, useRef, useState } from "react";
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
  type FinanceCatalog,
  type FinanceOpen,
  type FinanceNoteWrite,
  type FinanceRequest,
  type ConsistencyReport,
} from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import {
  buildFinancePrompt,
  FINANCE_WORKFLOWS,
  type FinanceWorkflowId,
} from "./finance-workflows.js";
import "./finance-workspace.css";

export const FINANCE_REVIEW_LINK =
  /^outputs\/c2-reviews\/[A-Za-z0-9_-]+\/review\.(?:json|html)$/;
const PEERS = [
  "Truly International（信利國際，00732）",
  "Solomon Systech（晶門半導體，02878）",
];

export function FinanceWorkflowCards(props: {
  onChoose: (id: FinanceWorkflowId) => void;
}) {
  return (
    <section className="finance-shortcuts" aria-label="FinanceBuddy 五大功能">
      <div className="finance-shortcuts-heading">
        <span>FinanceBuddy</span>
        <small>選擇工作，唔使寫 prompt</small>
      </div>
      <div className="finance-shortcut-grid">
        {FINANCE_WORKFLOWS.map((item, i) => (
          <button
            type="button"
            key={item.id}
            onClick={() => props.onChoose(item.id)}
          >
            <span className="finance-step">0{i + 1}</span>
            <strong>{item.title}</strong>
            <small>{item.stage}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

type Drafts = Record<
  string,
  { decision: FinanceNoteWrite["decision"]; note: string }
>;
export function FinanceWorkspace(props: {
  visible: boolean;
  client: MemmyAgentClient;
  initialPath: string | null;
  artifactPath?: string | null;
  workflow: FinanceWorkflowId | null;
  busy: boolean;
  onChoose: (id: FinanceWorkflowId | null) => void;
  onLaunch: (prompt: string) => Promise<void>;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<FinanceCatalog | null>(null);
  const [opened, setOpened] = useState<FinanceOpen | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [openedPath, setOpenedPath] = useState("");
  const draftStore = useRef<Record<string, Drafts>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"same_year" | "next_year_readiness">(
    "same_year",
  );
  const [peers, setPeers] = useState(PEERS);
  const [sourceVariant, setSourceVariant] = useState<
    "official" | "deliberate_errors"
  >("official");
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const openSequence = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const client = props.client;
  async function request(input: FinanceRequest) {
    if (!client.financeReaderRequest)
      throw new Error("此版本 Cuby 未支援內置 Reader，請更新 Cuby。");
    return client.financeReaderRequest(input);
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
  const selected = FINANCE_WORKFLOWS.find((x) => x.id === props.workflow);
  useEffect(() => {
    if (props.workflow === "review") {
      setSourceVariant("official");
      setMode("same_year");
    }
  }, [props.workflow]);
  useEffect(() => {
    if (!props.visible || !selected) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-label="關閉工作台"]')
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [props.visible, selected?.id]);
  async function launch() {
    if (props.workflow !== "review" && props.workflow !== "peers") return;
    setLaunching(true);
    setError("");
    try {
      await props.onLaunch(
        buildFinancePrompt({
          workflow: props.workflow,
          mode,
          peers,
          sourceVariant,
        }),
      );
      setLaunched(true);
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLaunching(false);
    }
  }
  return (
    <div
      hidden={!props.visible}
      className={
        selected ? "finance-dialog-backdrop" : "finance-workspace-host"
      }
      onMouseDown={(event) => {
        if (selected && event.target === event.currentTarget) props.onClose();
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
            props.onClose();
          }
          if (event.key === "Tab") {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]",
              ),
            );
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
              {selected ? selected.title : "報告工作台"}
            </h2>
          </div>
          <div className="finance-actions">
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
                title="重新載入底稿清單"
                aria-label="重新載入底稿清單"
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
              </button>
            )}
            <button
              title="關閉工作台"
              aria-label="關閉工作台"
              onClick={props.onClose}
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
            正在驗證原件版本及載入底稿…
          </div>
        )}
        {!loading && selected?.id === "consistency" ? (
          <ConsistencySetup client={client} request={request} onComplete={(report) => {
            setConsistency(report);setOpened(null);setExpanded(true);props.onChoose(null);
          }}/>
        ) : !loading && selected ? (
          <div className="finance-setup">
            <span className="finance-badge">{selected.stage}</span>
            <h3>{selected.title}</h3>
            <p>{selected.detail}</p>
            {selected.id === "review" || selected.id === "peers" ? (
              <>
                <label>
                  基準報告
                  <select value="yeebo2025" disabled>
                    <option value="yeebo2025">
                      億都 · FY2025/26 · 英文 ESG 報告
                    </option>
                  </select>
                </label>
                <p className="finance-muted">
                  目前已驗證此報告。其他年份及任意上載報告尚未接通。
                </p>
                {selected.id === "review" ? (
                  <>
                    <label>
                      檢查對象
                      <select
                        value={sourceVariant}
                        onChange={(event) => {
                          setSourceVariant(
                            event.target.value as typeof sourceVariant,
                          );
                          if (event.target.value === "deliberate_errors")
                            setMode("same_year");
                        }}
                      >
                        <option value="official">已公開的正式原件</option>
                        <option value="deliberate_errors">
                          TEST ONLY · 人為錯漏副本測試
                        </option>
                      </select>
                    </label>
                    {sourceVariant === "deliberate_errors" && (
                      <p className="finance-test-notice">
                        會建立獨立、每頁標示 TEST ONLY
                        的測試副本，原件及知識庫不會改動。測試只驗證目前已支援的檢查能力。
                      </p>
                    )}
                    <label>
                      核對目的
                      <select
                        value={mode}
                        disabled={sourceVariant === "deliberate_errors"}
                        onChange={(e) => {
                          setMode(e.target.value as typeof mode);
                          setLaunched(false);
                        }}
                      >
                        <option value="same_year">
                          核對 FY2025/26 本年度披露
                        </option>
                        <option value="next_year_readiness">
                          以舊報告評估 FY2026/27 準備度
                        </option>
                      </select>
                    </label>
                    <div className="finance-scope">
                      <strong>範圍：12 項 C2 Scope 1／2 披露核對</strong>
                      <p>
                        檢查已披露的證據、口徑及規則版本。其餘 ESG
                        章節、原始數據審計及完整合規判定不包含在內。
                      </p>
                      {mode === "next_year_readiness" && (
                        <p>
                          原件年份仍是
                          2025/26；所有舊數據及今年適用性均須另行確認。
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <fieldset>
                    <legend>同行 · 2025 年官方報告</legend>
                    {PEERS.map((peer) => (
                      <label className="finance-checkbox" key={peer}>
                        <input
                          type="checkbox"
                          checked={peers.includes(peer)}
                          onChange={(e) => {
                            setPeers(
                              e.target.checked
                                ? [...peers, peer]
                                : peers.filter((p) => p !== peer),
                            );
                            setLaunched(false);
                          }}
                        />
                        {peer}
                      </label>
                    ))}
                    <p className="finance-muted">
                      比較 Scope 1、Scope
                      2、碳密度；保留期間、邊界、分母及來源，口徑不同不直接排名。
                    </p>
                  </fieldset>
                )}
                <button
                  className="finance-primary"
                  disabled={
                    props.busy ||
                    launching ||
                    (selected.id === "peers" && !peers.length)
                  }
                  onClick={() => void launch()}
                >
                  {launching ? "正在交畀 Cuby…" : "開始此工作"}
                </button>
                {props.busy && (
                  <p role="status">
                    Cuby 正在處理對話；完成後可開始另一項工作。
                  </p>
                )}
                {launched && (
                  <p role="status">
                    {selected.id === "peers"
                      ? "已交畀左邊 Cuby 對話處理。完成後點 CSV 檔案開啟比較表；來源及口徑亦會保留在底稿。"
                      : "已交畀左邊 Cuby 對話處理。核對完成後，點 review.json 可在此閱讀；沒有重新核對的話可直接開啟下面現有底稿。"}
                  </p>
                )}
              </>
            ) : (
              <div className="finance-scope">
                <strong>
                  {selected.id === "commitments"
                    ? "專用流程尚待開發"
                    : "等待 Mavis 確認來源"}
                </strong>
                <p>
                  {selected.id === "commitments"
                    ? "需要上年度承諾清單、今年結果及對應證據；之後建立逐項追蹤和人工覆核。此入口目前不會啟動一個未驗證的流程。"
                    : "需要來源 Excel／系統、欄位說明、報告期間、業務邊界、負責人及讀取權限。資料齊備後才接通整合及報告生成。"}
                </p>
              </div>
            )}
            {selected.id === "review" && (
              <ReviewList catalog={catalog} onOpen={(p) => void open(p)} />
            )}
          </div>
        ) : !loading && consistency ? (
          <ConsistencyReader key={consistency.run_id} report={consistency} request={request} busy={props.busy} onAsk={async(prompt)=>{
            await props.onLaunch(prompt);setExpanded(false);
          }}/>
        ) : !loading && opened ? (
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
      <h3>現有核對底稿</h3>
      <p className="finance-muted">
        直接閱讀已完成底稿，不重新呼叫模型。全部仍需業務覆核。
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
        <p>未有可用底稿。請先完成一次報告核對。</p>
      )}
      {!!props.catalog?.unavailable.length && (
        <p className="finance-muted">
          以下底稿尚未就緒或未能驗證：{props.catalog.unavailable.join("、")}
        </p>
      )}
    </section>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "未能完成此操作。";
}
