import { useEffect, useRef, useState, type Ref } from "react";
import { Upload } from "lucide-react";
import type { GetMemoryOutput, MemoryApiLog, MemoryApiLogToolName, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { formatUserDateTime } from "../../lib/user-time-zone.js";
import {
  buildMemoryUiDeletedEvent,
  buildMemoryUiDetailOpenedEvent,
  buildMemoryUiPanelRefreshedEvent,
  buildMemoryUiSearchSubmittedEvent
} from "../../analytics/memory-ui-analytics.js";
import { useAnalytics } from "../../analytics/use-analytics.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { Search, Wand2, X } from "../memory/memory-prototype-icons.js";
import { MemoryDrawerDeleteAction } from "../memory/memory-delete-action.js";
import { toMemoryDetailErrorMessage } from "../memory/memory-detail-error.js";
import { cleanMemoryBody, cleanMemoryText, drawerEyebrow } from "../memory/memory-display.js";
import { displayMemoryId } from "../memory/memory-id.js";
import {
  MemoryReferenceTags,
  type MemoryReferencePage,
  type OpenMemoryReference
} from "../memory/memory-reference-tags.js";
import {
  clearMemoryPanelCache,
  memoryPanelCacheKey,
  memoryPanelLatestCacheKey,
  readMemoryPanelCacheFirst,
  writeMemoryPanelCaches
} from "../memory/memory-panel-cache.js";
import { MemoryRefreshButton } from "../memory/memory-refresh-button.js";
import { MemoryStateBox } from "../memory/memory-state-box.js";
import { type RemoteData, toErrorMessage } from "../memory/remote-state.js";
import { demoSkillDetail, demoSkillPanelItems, demoSkillTimeline, isSkillsDemoEnabled } from "../memory/skill-demo-data.js";
import { buildSkillTabs, cardsForTab, searchCards, skillSourceOf, sourceLabel, type SkillCard, type SkillTabId } from "./skill-groups.js";
import { readSkillImportFile, skillImportMemoryInput, type ImportedSkillDraft } from "./skill-import.js";

type SkillDetailState = RemoteData<SkillDetailData> | null;
const SKILLS_CACHE_SECTION = "skills";
const SKILL_TIMELINE_TOOLS: MemoryApiLogToolName[] = ["skill_generate", "skill_evolve"];
type SkillStatusTone = "candidate" | "active" | "archived" | "deleted" | "unknown";
type SkillTimelineTone = "running" | "succeeded" | "failed" | "skipped";

interface SkillDetailData {
  detail: GetMemoryOutput;
  timeline: SkillTimelineEntry[];
}

export interface SkillTimelineEntry {
  ts: string;
  kind: string;
  phase?: string;
  durationMs: number;
  success: boolean;
  summary?: string;
}

interface SkillDecisionGuidance {
  preference: string[];
  antiPattern: string[];
}

interface SkillView {
  title: string;
  status: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  usageGuide: string;
  decisionGuidance: SkillDecisionGuidance;
  evidenceAnchors: string[];
  sourcePolicyIds: string[];
  eta?: number;
  support?: number;
  gain?: number;
  trialsAttempted?: number;
  trialsPassed?: number;
  usageCount?: number;
  lastUsedAt?: string;
}

export interface SkillsSectionRequest {
  skillId: string | null;
  requestId: number;
}

export interface SkillsSectionProps {
  client: MemoryRuntimeClient | null;
  request?: SkillsSectionRequest | null;
  onRequestHandled?: (requestId: number) => void;
  onOpenMemoryReference: OpenMemoryReference;
}

export async function loadSkillsData(client: MemoryRuntimeClient, query = ""): Promise<PanelItemsOutput> {
  const first = await loadSkillsDataPage(client, query, 1);
  if (!first.hasNext) return first;

  const items = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await loadSkillsDataPage(client, query, page);
    items.push(...next.items);
    if (!next.hasNext) break;
  }
  return { ...first, items, page: 1, total: items.length, totalPages: 1, hasNext: false, hasPrev: false };
}

export function loadSkillsDataPage(client: MemoryRuntimeClient, query = "", page = 1): Promise<PanelItemsOutput> {
  const keyword = query.trim();
  return client.listPanelItems(
    keyword ? { layer: "Skill", q: keyword, page } : { layer: "Skill", page }
  );
}

export function loadSkillDetail(client: MemoryRuntimeClient, skillId: string): Promise<GetMemoryOutput> {
  return client.getMemory(skillId);
}

export async function loadSkillTimeline(client: MemoryRuntimeClient, skillId: string): Promise<SkillTimelineEntry[]> {
  const output = await client.listMemoryLogs({
    tools: SKILL_TIMELINE_TOOLS,
    limit: 500,
    offset: 0
  });

  return skillTimelineFromLogs(output.logs, skillId);
}

function skillsCacheKeys(query: string): string[] {
  return [
    memoryPanelCacheKey(SKILLS_CACHE_SECTION, query.trim(), 1),
    memoryPanelLatestCacheKey(SKILLS_CACHE_SECTION)
  ];
}

export function SkillsSection(props: SkillsSectionProps) {
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const skillsFilterLayer = "Skill";
  const demoEnabled = isSkillsDemoEnabled();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<SkillTabId | null>(null);
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [detail, setDetail] = useState<SkillDetailState>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  function openSkill(skillId: string) {
    setSelectedSkillId(skillId);
    track(buildMemoryUiDetailOpenedEvent({
      subPage: "skills",
      filterLayer: skillsFilterLayer
    }));
    if (demoEnabled) {
      const skillDetail = demoSkillDetail(skillId);
      if (!skillDetail) {
        setDetail({ status: "error", message: t("memory.detailUnavailable") });
        return;
      }

      setDetail({ status: "ready", data: { detail: skillDetail, timeline: demoSkillTimeline(skillId) } });
      return;
    }

    if (!props.client) {
      setDetail({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    setDetail({ status: "loading" });
    void Promise.all([
      loadSkillDetail(props.client, skillId),
      loadSkillTimeline(props.client, skillId).catch(() => [])
    ])
      .then(([skillDetail, timeline]) => setDetail({ status: "ready", data: { detail: skillDetail, timeline } }))
      .catch((error) => setDetail({ status: "error", message: toMemoryDetailErrorMessage(error, t("memory.detailUnavailable")) }));
  }

  function refresh(options: { useCache?: boolean; query?: string } = {}): Promise<PanelItemsOutput | undefined> {
    const keyword = options.query ?? submittedQuery;

    if (demoEnabled) {
      const data = demoSkillPanelItems(keyword, 1);
      setState({ status: "ready", data });
      if (!selectedSkillId && !detail) {
        const firstSkill = data.items[0];
        const firstDetail = firstSkill ? demoSkillDetail(firstSkill.id) : undefined;
        if (firstSkill && firstDetail) {
          setSelectedSkillId(firstSkill.id);
          setDetail({ status: "ready", data: { detail: firstDetail, timeline: demoSkillTimeline(firstSkill.id) } });
        }
      }
      return Promise.resolve(data);
    }

    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const cacheKeys = skillsCacheKeys(keyword);
    const cached = (options.useCache ?? true) ? readMemoryPanelCacheFirst<PanelItemsOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return loadSkillsData(props.client, keyword)
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        setState({ status: "ready", data });
        return data;
      })
      .catch((error) => {
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function changeQuery(value: string) {
    setQuery(value);
    closeSkill();
    if (!value.trim() && submittedQuery) {
      setSubmittedQuery("");
      void refresh({ query: "" }).catch(() => undefined);
    }
  }

  function runSearch() {
    const keyword = query.trim();
    setSubmittedQuery(keyword);
    closeSkill();
    void refresh({ query: keyword })
      .then((data) => {
        if (!data) {
          return;
        }
        track(buildMemoryUiSearchSubmittedEvent({
          subPage: "skills",
          filterLayer: skillsFilterLayer,
          resultCount: data.total
        }));
      })
      .catch(() => undefined);
  }

  async function importSkills(files: File[]) {
    if (files.length === 0 || demoEnabled) return;
    if (!props.client) {
      setImportNotice(t("memory.clientNotReady"));
      return;
    }
    setImporting(true);
    setImportNotice(null);
    const drafts: ImportedSkillDraft[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        drafts.push(...await readSkillImportFile(file));
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let imported = 0;
    for (const draft of drafts) {
      try {
        await props.client.addMemory(skillImportMemoryInput(draft));
        imported += 1;
      } catch (error) {
        errors.push(`${draft.name}: ${toErrorMessage(error)}`);
      }
    }
    const parts: string[] = [];
    if (imported > 0) parts.push(t("memory.skills.importSuccess", { count: imported }));
    if (errors.length > 0) parts.push(t("memory.skills.importFailed", { count: errors.length }), errors.slice(0, 3).join("; "));
    setImportNotice(parts.join(" "));
    setImporting(false);
    if (imported > 0) {
      setQuery("");
      setSubmittedQuery("");
      setActiveTabId("mine");
      clearMemoryPanelCache();
      void refresh({ query: "", useCache: false }).catch(() => undefined);
    }
  }

  function closeSkill() {
    setDetail(null);
    setSelectedSkillId(null);
  }

  async function deleteSkill(id: string) {
    if (demoEnabled) {
      closeSkill();
      return;
    }

    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deleteMemory(id);
    track(buildMemoryUiDeletedEvent({
      subPage: "skills",
      filterLayer: skillsFilterLayer
    }));
    clearMemoryPanelCache();
    closeSkill();
    void refresh({ useCache: false }).catch(() => undefined);
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, t, demoEnabled]);

  useEffect(() => {
    const request = props.request;
    if (!request) {
      return;
    }

    if (request.skillId) {
      openSkill(request.skillId);
    } else {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
    }
    props.onRequestHandled?.(request.requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request?.requestId]);

  return (
    <SkillsSectionView
      sectionRef={sectionRef}
      state={state.status === "ready" ? { ...state, detail } : state}
      detail={detail}
      selectedSkillId={selectedSkillId}
      query={query}
      searchActive={submittedQuery.trim().length > 0}
      importing={importing}
      importNotice={importNotice}
      activeTabId={activeTabId}
      onTabChange={setActiveTabId}
      onImportSkills={importSkills}
      onQueryChange={changeQuery}
      onSearch={runSearch}
      onRefresh={async () => {
        const keyword = query.trim();
        setSubmittedQuery(keyword);
        const data = await refresh({ query: keyword, useCache: false });
        if (data) {
          track(buildMemoryUiPanelRefreshedEvent({
            subPage: "skills",
            filterLayer: skillsFilterLayer,
            resultCount: data.total
          }));
        }
      }}
      onOpenSkill={openSkill}
      onDeleteSkill={deleteSkill}
      onCloseSkill={closeSkill}
      onOpenMemoryReference={props.onOpenMemoryReference}
    />
  );
}

export interface SkillsSectionViewProps {
  sectionRef?: Ref<HTMLElement>;
  state: RemoteData<PanelItemsOutput> | ({ status: "ready"; data: PanelItemsOutput; detail: SkillDetailState });
  detail?: SkillDetailState;
  selectedSkillId?: string | null;
  query: string;
  searchActive: boolean;
  importing: boolean;
  importNotice?: string | null;
  activeTabId: SkillTabId | null;
  onTabChange: (id: SkillTabId) => void;
  onImportSkills: (files: File[]) => void | Promise<void>;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void | Promise<void>;
  onOpenSkill: (skillId: string) => void;
  onDeleteSkill: (id: string) => Promise<void>;
  onCloseSkill: () => void;
  onOpenMemoryReference: OpenMemoryReference;
}

export function SkillsSectionView(props: SkillsSectionViewProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const items = props.state.status === "ready" ? props.state.data.items : [];
  const tabs = buildSkillTabs(items);
  const activeTab = tabs.find((tab) => tab.id === props.activeTabId) ?? tabs[0];
  const cards = props.searchActive
    ? searchCards(items)
    : activeTab
      ? cardsForTab(items, activeTab.id)
      : [];

  return (
    <section className="mb-8" data-tools-skills-section="" ref={props.sectionRef}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-text-ink">
            {props.searchActive ? t("memory.skills.searchResults") : t("memory.skills.title")}
          </div>
          {!props.searchActive && <p className="mt-1 text-xs text-text-ink/55">{t("memory.skills.description")}</p>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label className="memory-search">
            <Search size={15} className="memory-search__icon" />
            <input
              type="search"
              value={props.query}
              placeholder={t("memory.skills.searchPlaceholder")}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  props.onSearch();
                }
              }}
              className="memory-search__input"
            />
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.md,text/markdown,application/zip"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void props.onImportSkills(files);
            }}
          />
          <button
            type="button"
            disabled={props.importing}
            onClick={() => fileInputRef.current?.click()}
            title={t("memory.skills.importHint")}
            className="flex items-center gap-1.5 rounded-btn border border-content-panel bg-background-paper px-3 py-1.5 text-xs text-text-ink/65 transition-colors hover:bg-canvas-oat/40 disabled:opacity-50"
          >
            <Upload size={13} />
            {props.importing ? t("memory.skills.importing") : t("memory.skills.import")}
          </button>
          <MemoryRefreshButton onClick={props.onRefresh} />
        </div>
      </div>
      {props.importNotice && (
        <p className="mb-3 rounded-card border border-amber-300/40 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
          {props.importNotice}
        </p>
      )}
      {props.state.status === "loading" && <MemoryStateBox message={t("memory.skills.loading")} />}
      {props.state.status === "error" && <MemoryStateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && !props.searchActive && tabs.length > 0 && (
        <div className="tools-skill-tabs" data-tools-skill-tabs="" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab?.id}
              onClick={() => props.onTabChange(tab.id)}
              className={`tools-skill-tab${tab.id === activeTab?.id ? " tools-skill-tab--active" : ""}`}
            >
              {skillTabLabel(tab, t)}
              <span className="tools-skill-tab__count">{tab.count}</span>
            </button>
          ))}
        </div>
      )}
      {props.state.status === "ready" && cards.length === 0 && <MemoryStateBox message={t("memory.skills.empty")} />}
      {props.state.status === "ready" && cards.length > 0 && (
        <div className="tools-icon-grid">
          {cards.map((card) => (
            <SkillGridCard
              key={card.key}
              card={card}
              searchActive={props.searchActive}
              selected={props.selectedSkillId === card.item.id}
              onOpen={() => props.onOpenSkill(card.item.id)}
            />
          ))}
        </div>
      )}
      <SkillDrawer
        detail={props.detail ?? ("detail" in props.state ? props.state.detail : null)}
        onClose={props.onCloseSkill}
        onDelete={props.onDeleteSkill}
        onOpenMemoryReference={props.onOpenMemoryReference}
      />
    </section>
  );
}

function SkillGridCard(props: {
  card: SkillCard;
  searchActive: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const item = props.card.item;
  const title = displaySkillTitle(item);
  const description = skillCardDescription(item);
  const groupLabel = props.searchActive
    ? props.card.group === "builtin"
      ? t("memory.skills.tabs.builtin")
      : props.card.group === "mine"
        ? t("memory.skills.tabs.mine")
        : props.card.group === "learned"
          ? t("memory.skills.tabs.learned")
          : sourceLabel(props.card.source ?? "")
    : props.card.group === "builtin"
      ? t("memory.skills.syncedTools", { count: new Set(props.card.mergedItems.map(skillSourceOf)).size })
      : "";

  return (
    <button
      type="button"
      title={description ? `${title} — ${description}` : title}
      onClick={props.onOpen}
      className={`integration-card rounded-card integration-card-integration ${skillCardStatusClass(item.status)}${props.selected ? " integration-card--selected" : ""}`}
    >
      <span className="integration-card-logo flex items-center justify-center text-text-ink/45">
        <Wand2 size={22} />
      </span>
      <span className="integration-card-content">
        <span className="integration-card-name">{title}</span>
        {description && <span className="integration-card-description">{description}</span>}
        <span className="integration-card-meta">
          {groupLabel && <span className="integration-card-source">{groupLabel}</span>}
          <span className={`integration-card-state-label ${skillCardStateClass(item.status)}`}>
            {skillStatusLabel(item.status, t)}
          </span>
        </span>
      </span>
    </button>
  );
}

function skillTabLabel(tab: { group: "builtin" | "mine" | "learned" | "source"; source?: string }, t: (key: MessageKey) => string): string {
  if (tab.group === "builtin") return t("memory.skills.tabs.builtin");
  if (tab.group === "mine") return t("memory.skills.tabs.mine");
  if (tab.group === "learned") return t("memory.skills.tabs.learned");
  return sourceLabel(tab.source ?? "");
}

function skillCardDescription(item: { summary?: string }): string {
  return cleanMemoryText(item.summary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && line !== "---") ?? "";
}

/**
 * Renders the skill detail drawer.
 *
 * @param props.detail The skill detail remote state.
 * @param props.onClose The close callback.
 * @returns The skill detail node.
 */
function SkillDrawer(props: {
  detail: SkillDetailState;
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
  onOpenMemoryReference: OpenMemoryReference;
}) {
  const { t } = useTranslation();

  if (!props.detail) {
    return null;
  }

  const readyDetail = props.detail.status === "ready" ? props.detail.data : null;
  const title = readyDetail ? skillFromDetail(readyDetail.detail).title : t("memory.skills.detailTitle");
  const eyebrow = readyDetail ? drawerEyebrow(readyDetail.detail.item) : t("memory.skills.detailTitle");

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-skill-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span className="memory-drawer__eyebrow">{eyebrow}</span>
            </div>
            <h4 id="memory-skill-title" className="memory-drawer__title">{title}</h4>
          </div>
          <button type="button" className="memory-drawer__close" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          {props.detail.status === "loading" && <MemoryStateBox message={t("memory.skills.detailLoading")} />}
          {props.detail.status === "error" && <MemoryStateBox message={props.detail.message} tone="error" />}
          {props.detail.status === "ready" && (
            <SkillDetail
              detail={props.detail.data.detail}
              timeline={props.detail.data.timeline}
              onOpenMemoryReference={props.onOpenMemoryReference}
            />
          )}
        </div>
        {readyDetail && <MemoryDrawerDeleteAction onDelete={() => props.onDelete(readyDetail.detail.item.id)} />}
      </aside>
    </div>
  );
}

function SkillDetail(props: {
  detail: GetMemoryOutput;
  timeline: SkillTimelineEntry[];
  onOpenMemoryReference: OpenMemoryReference;
}) {
  const { t } = useTranslation();
  const skill = skillFromDetail(props.detail);
  const hasDecisionGuidance = skill.decisionGuidance.preference.length > 0 || skill.decisionGuidance.antiPattern.length > 0;

  return (
    <>
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <div className="memory-detail-metrics">
          <Metric label={t("memory.memories.status")} value={skillStatusLabel(skill.status, t)} />
          <Metric label={t("memory.skills.valueScore")} value={formatNumber(skill.eta, 3)} />
          <Metric label={t("memory.policies.gain")} value={formatNumber(skill.gain, 3)} />
          <Metric label={t("memory.policies.support")} value={formatNumber(skill.support, 0)} />
          <Metric label="trials" value={formatTrials(skill.trialsPassed, skill.trialsAttempted)} />
          <Metric label="usage" value={formatNumber(skill.usageCount, 0)} />
          <Metric label={t("memory.memories.createdAt")} value={formatDateTime(skill.createdAt)} />
          <Metric label={t("memory.memories.updatedAt")} value={formatDateTime(skill.updatedAt)} />
          <Metric label="last used" value={formatDateTime(skill.lastUsedAt)} />
        </div>
        {skill.source && (
          <div className="memory-policy-source">
            <span>{t("memory.tasks.source")}</span>
            {skill.source}
          </div>
        )}
      </section>

      <SkillTimelineSection entries={props.timeline} />
      {skill.usageGuide && <DetailTextSection title={t("memory.skills.invocationGuide")} body={skill.usageGuide} />}
      <DetailTextSection title={t("memory.skills.body")} body={skill.body} />

      {hasDecisionGuidance && (
        <section className="memory-detail-card">
          <h5 className="memory-detail-card__label">{t("memory.skills.decisionGuidance")}</h5>
          {skill.decisionGuidance.preference.length > 0 && (
            <GuidanceList title={t("memory.skills.prefer")} entries={skill.decisionGuidance.preference} tone="prefer" />
          )}
          {skill.decisionGuidance.antiPattern.length > 0 && (
            <GuidanceList title={t("memory.skills.avoid")} entries={skill.decisionGuidance.antiPattern} tone="avoid" />
          )}
        </section>
      )}

      <LinkedIdsSection
        title={t("memory.skills.sourceExperience")}
        ids={skill.sourcePolicyIds.length > 0 ? skill.sourcePolicyIds : props.detail.item.sourceMemoryIds}
        empty={t("memory.skills.noSourceExperience")}
        fallbackPage="policies"
        onOpen={props.onOpenMemoryReference}
      />
      <LinkedIdsSection
        title={t("memory.skills.evidenceAnchors")}
        ids={skill.evidenceAnchors}
        empty={t("memory.skills.noEvidenceAnchors")}
        fallbackPage="memories"
        onOpen={props.onOpenMemoryReference}
      />
    </>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="memory-detail-metric">
      <div className="memory-detail-metric__label">{props.label}</div>
      <div className="memory-detail-metric__value">{props.value}</div>
    </div>
  );
}

function DetailTextSection(props: { title: string; body?: string }) {
  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      <div className="memory-policy-section-body">{cleanMemoryBody(props.body) || "-"}</div>
    </section>
  );
}

function GuidanceList(props: { title: string; entries: string[]; tone: "prefer" | "avoid" }) {
  return (
    <div className={`memory-policy-guidance memory-policy-guidance--${props.tone}`}>
      <div className="memory-policy-guidance__title">{props.title}</div>
      <ul className="memory-policy-guidance__list">
        {props.entries.map((entry, index) => (
          <li key={`${props.tone}-${index}`}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

function LinkedIdsSection(props: {
  title: string;
  ids: string[];
  empty: string;
  fallbackPage: MemoryReferencePage;
  onOpen: OpenMemoryReference;
}) {
  const hasIds = props.ids.some(Boolean);

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      {!hasIds ? (
        <div className="memory-policy-empty">{props.empty}</div>
      ) : (
        <MemoryReferenceTags ids={props.ids} fallbackPage={props.fallbackPage} onOpen={props.onOpen} />
      )}
    </section>
  );
}

function SkillTimelineSection(props: { entries: SkillTimelineEntry[] }) {
  const { t } = useTranslation();

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{t("memory.skills.evolutionTimeline")}</h5>
      {props.entries.length === 0 ? (
        <div className="memory-policy-empty">{t("memory.skills.evolutionTimeline.empty")}</div>
      ) : (
        <div className="memory-skill-timeline">
          {props.entries.map((entry, index) => (
            <div key={`${entry.ts}-${entry.kind}-${index}`} className="memory-skill-timeline__item">
              <div className="memory-skill-timeline__rail" aria-hidden="true">
                <span className={`memory-skill-timeline__dot memory-skill-timeline__dot--${skillTimelineTone(entry)}`} />
              </div>
              <div className="memory-skill-timeline__body">
                <div className="memory-skill-timeline__head">
                  <span className={`memory-pill memory-pill--skill-${skillTimelineTone(entry)}`}>
                    {skillTimelineLabel(entry.kind, entry.phase, t)}
                  </span>
                  <span className="memory-skill-timeline__time">{formatDateTime(entry.ts)}</span>
                </div>
                {entry.summary && <div className="memory-skill-timeline__summary">{entry.summary}</div>}
                {skillTimelineShowsDuration(entry) && (
                  <div className="memory-skill-timeline__meta">{t("memory.skills.timeline.duration", { duration: entry.durationMs })}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function skillStatusTone(status: string | undefined): SkillStatusTone {
  const toneByStatus: Record<string, SkillStatusTone> = {
    resolving: "candidate",
    candidate: "candidate",
    activated: "active",
    active: "active",
    archived: "archived",
    deleted: "deleted"
  };

  return toneByStatus[status ?? ""] ?? "unknown";
}

function skillCardStatusClass(status: string | undefined): string {
  const tone = skillStatusTone(status);
  if (tone === "active") {
    return "integration-card-status-connected";
  }
  if (tone === "candidate") {
    return "integration-card-status-connecting";
  }

  return "";
}

function skillCardStateClass(status: string | undefined): string {
  const tone = skillStatusTone(status);
  if (tone === "active") {
    return "text-status-success";
  }
  if (tone === "candidate") {
    return "text-amber-800";
  }

  return "text-text-ink/45";
}

function skillStatusLabel(status: string | undefined, t: (key: MessageKey) => string): string {
  const keyByTone: Record<SkillStatusTone, MessageKey> = {
    candidate: "memory.policies.status.candidate",
    active: "memory.policies.status.active",
    archived: "memory.policies.status.archived",
    deleted: "memory.memories.status.deleted",
    unknown: "memory.policies.status.unknown"
  };

  return t(keyByTone[skillStatusTone(status)]);
}

function skillTimelineFromLogs(logs: MemoryApiLog[], skillId: string): SkillTimelineEntry[] {
  return logs
    .flatMap((log) => {
      const input = parseJsonString(log.inputJson);
      const output = parseJsonString(log.outputJson);
      const loggedSkillId = firstString(
        recordValue(output).skillId,
        recordValue(output).skill_id,
        recordValue(input).skillId,
        recordValue(input).skill_id
      );
      if (!loggedSkillId || !isSameSkillId(loggedSkillId, skillId)) {
        return [];
      }

      const kind = firstString(recordValue(output).kind, log.toolName) ?? log.toolName;
      const phase = firstString(recordValue(input).phase, recordValue(output).phase);
      const summary = firstString(
        recordValue(output).name,
        recordValue(output).title,
        recordValue(output).summary,
        recordValue(output).reason,
        recordValue(input).summary,
        recordValue(input).reason
      );

      return [{
        ts: log.calledAt,
        kind,
        phase,
        durationMs: log.durationMs,
        success: log.success,
        summary
      }];
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

function isSameSkillId(loggedSkillId: string, selectedSkillId: string): boolean {
  return compactComparableId(loggedSkillId) === compactComparableId(selectedSkillId);
}

function compactComparableId(value: string): string {
  return value.split("::").pop()?.trim() || value.trim();
}

function skillTimelineTone(entry: SkillTimelineEntry): SkillTimelineTone {
  if (!entry.success || entry.phase === "failed" || entry.kind === "skill.failed" || entry.kind === "skill.verification.failed") {
    return "failed";
  }
  if (entry.phase === "started" || entry.kind === "skill.crystallization.started") {
    return "running";
  }
  if (entry.kind === "skill.archived") {
    return "skipped";
  }
  return "succeeded";
}

function skillTimelineShowsDuration(entry: SkillTimelineEntry): boolean {
  return entry.kind === "skill.crystallized" || entry.kind === "skill.rebuilt" || entry.kind === "skill_generate";
}

function skillTimelineLabel(kind: string, phase: string | undefined, t: (key: MessageKey) => string): string {
  switch (kind) {
    case "skill.crystallized":
      return t("memory.skills.timeline.kind.crystallized");
    case "skill.crystallization.started":
      return t("memory.skills.timeline.kind.started");
    case "skill.rebuilt":
      return t("memory.skills.timeline.kind.rebuilt");
    case "skill.eta.updated":
      return t("memory.skills.timeline.kind.etaUpdated");
    case "skill.status.changed":
      return t("memory.skills.timeline.kind.statusChanged");
    case "skill.archived":
      return t("memory.skills.timeline.kind.archived");
    case "skill.verification.failed":
      return t("memory.skills.timeline.kind.verifyFailed");
    case "skill.failed":
      return t("memory.skills.timeline.kind.failed");
    case "skill_generate":
      if (phase === "started") return t("memory.skills.timeline.kind.started");
      if (phase === "failed") return t("memory.skills.timeline.kind.failed");
      return t("memory.skills.timeline.kind.crystallized");
    case "skill_evolve":
      return t("memory.skills.timeline.kind.rebuilt");
    default:
      return kind;
  }
}

function skillFromDetail(detail: GetMemoryOutput): SkillView {
  const metadata = detail.item.metadata;
  const properties = recordValue(metadata.properties);
  const info = recordValue(metadata.info);
  const internalInfo = recordValue(properties.internal_info);
  const layerSkill = recordValue(detail.item.skill);
  const skill = recordValue(firstDefined(internalInfo.skill, metadata.skill, properties.skill));
  const procedure = recordValue(firstDefined(skill.procedureJson, skill.procedure_json, internalInfo.procedureJson, internalInfo.procedure_json));
  const decisionGuidance = readDecisionGuidance(
    firstDefined(skill.decisionGuidance, skill.decision_guidance, internalInfo.decisionGuidance, internalInfo.decision_guidance)
  );
  const body = cleanMemoryBody(detail.item.body);
  const shortUsageGuide = uniqueStrings([
    firstString(layerSkill.retrievalBlurb, layerSkill.retrieval_blurb, procedure.retrievalBlurb, procedure.retrieval_blurb) ?? "",
    firstString(layerSkill.triggerContext, layerSkill.trigger_context, procedure.triggerContext, procedure.trigger_context) ?? ""
  ]).join("\n\n");
  const parsedUsageGuide = parseMarkdownSection(detail.item.body, ["When to use", "\u9002\u7528\u573a\u666f", "\u8c03\u7528\u65f6\u673a"]);
  const legacyInvocationGuide = firstString(
    layerSkill.invocationGuide,
    skill.invocationGuide,
    skill.invocation_guide,
    internalInfo.invocationGuide,
    internalInfo.invocation_guide
  );
  const distinctLegacyGuide = legacyInvocationGuide && cleanMemoryBody(legacyInvocationGuide) !== body
    ? legacyInvocationGuide
    : "";

  return {
    title: displaySkillTitle(detail.item, firstString(skill.title, internalInfo.title)),
    status: firstString(skill.status, internalInfo.status, info.status, detail.item.status) ?? detail.item.status,
    source: firstString(metadata.source, internalInfo.source),
    createdAt: detail.item.createdAt,
    updatedAt: detail.item.updatedAt,
    body,
    usageGuide: shortUsageGuide || parsedUsageGuide || distinctLegacyGuide,
    decisionGuidance,
    evidenceAnchors: readEvidenceAnchors(firstDefined(skill.evidenceAnchors, skill.evidence_anchors, internalInfo.evidenceAnchors, internalInfo.evidence_anchors)),
    sourcePolicyIds: stringArray(firstDefined(skill.sourcePolicyIds, skill.source_policy_ids, internalInfo.sourcePolicyIds, internalInfo.source_policy_ids)),
    eta: numberValue(firstDefined(skill.eta, internalInfo.eta, info.eta)),
    support: numberValue(firstDefined(skill.support, internalInfo.support, info.support)),
    gain: numberValue(firstDefined(skill.gain, internalInfo.gain, info.gain)),
    trialsAttempted: numberValue(firstDefined(skill.trialsAttempted, skill.trials_attempted, internalInfo.trialsAttempted, internalInfo.trials_attempted)),
    trialsPassed: numberValue(firstDefined(skill.trialsPassed, skill.trials_passed, internalInfo.trialsPassed, internalInfo.trials_passed)),
    usageCount: numberValue(firstDefined(skill.usageCount, skill.usage_count, internalInfo.usageCount, internalInfo.usage_count)),
    lastUsedAt: firstString(skill.lastUsedAt, skill.last_used_at, internalInfo.lastUsedAt, internalInfo.last_used_at)
  };
}

function displaySkillTitle(
  item: { id: string; title?: string; summary?: string; body?: string; memoryLayer?: string },
  ...candidates: Array<string | undefined>
): string {
  for (const value of [
    ...candidates,
    item.title,
    markdownHeadingTitle(item.body),
    item.summary,
    item.body
  ]) {
    const title = cleanSkillTitle(value);
    if (title && !isInternalSkillTitle(title)) {
      return title;
    }
  }

  return displayMemoryId(item.id);
}

function cleanSkillTitle(value?: string): string | undefined {
  const firstLine = cleanMemoryText(value)
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  if (isInternalSkillTitle(firstLine)) return undefined;
  const clipped = firstLine
    .split(/\s+(?:Use this skill|When to use|Procedure|Decision guidance)\b/i)[0]
    ?.trim();
  if (clipped && isInternalSkillTitle(clipped)) return undefined;
  return humanizeIdentifier(clipped || firstLine);
}

function markdownHeadingTitle(value?: string): string | undefined {
  const line = (value ?? "").split(/\r?\n/).find((candidate) => /^\s*#{1,6}\s+/.test(candidate));
  return line?.replace(/^\s*#{1,6}\s+/, "").trim() || undefined;
}

function isInternalSkillTitle(value: string): boolean {
  const text = value.trim();
  return /^(trace|policy|world|world_model|skill)[:_]/i.test(text)
    || /^[a-z]+_[a-f0-9]{12,}$/i.test(text);
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  if (!/^[a-z0-9_:-]+$/i.test(cleaned)) return cleaned;
  return cleaned
    .replace(/^(skill|policy|trace|world)[:_]/i, "")
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ") || undefined;
}

function readDecisionGuidance(value: unknown): SkillDecisionGuidance {
  const source = recordValue(value);

  return {
    preference: stringArray(source.preference),
    antiPattern: stringArray(firstDefined(source.antiPattern, source.anti_pattern))
  };
}

function readEvidenceAnchors(value: unknown): string[] {
  const parsed = parseJsonString(value);
  const list = Array.isArray(parsed) ? parsed : parsed === undefined || parsed === null ? [] : [parsed];

  return list
    .map((item) => {
      const record = recordValue(item);
      return firstString(item, record.traceId, record.trace_id, record.memoryId, record.memory_id, record.id, record.label, record.title);
    })
    .filter((item): item is string => Boolean(item));
}

function parseMarkdownSection(body: string, labels: string[]): string | undefined {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return Boolean(match && normalizedLabels.includes((match[1] ?? "").trim().toLowerCase()));
  });

  if (startIndex < 0) {
    return undefined;
  }

  const chunks: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line)) {
      break;
    }
    chunks.push(line);
  }

  return chunks.join("\n").trim() || undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  const parsed = parseJsonString(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = parseJsonString(value);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
  }

  return undefined;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringArray(value: unknown): string[] {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => firstString(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatNumber(value: number | undefined, digits: number): string {
  return value === undefined ? "-" : value.toFixed(digits);
}

function formatTrials(passed: number | undefined, attempted: number | undefined): string {
  if (passed === undefined && attempted === undefined) {
    return "-";
  }

  return `${passed ?? 0}/${attempted ?? 0}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  return formatUserDateTime(value);
}
