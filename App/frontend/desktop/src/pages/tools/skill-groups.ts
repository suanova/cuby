/** Skill grouping module. */
import type { PanelItemsOutput } from "@memmy/local-api-contracts";

export type SkillPanelItem = PanelItemsOutput["items"][number];
export type SkillTabId = "builtin" | "mine" | "learned" | `source:${string}`;

export interface SkillTab {
  id: SkillTabId;
  group: "builtin" | "mine" | "learned" | "source";
  source?: string;
  count: number;
}

export interface SkillCard {
  key: string;
  group: "builtin" | "mine" | "learned" | "source";
  source?: string;
  item: SkillPanelItem;
  mergedItems: SkillPanelItem[];
}

/**
 * Skills the backend installer writes into every agent's skill directory.
 * The memory layer stores one row per agent, so the list merges them by name.
 */
export const CUBY_BUILTIN_SKILL_NAMES = new Set(["memmy-resume", "memmy-memory", "cuby-memory"]);

/** Sources that mean a user imported the skill from local files. */
const MINE_SOURCES = new Set(["manual", "local"]);

const SOURCE_LABELS: Record<string, string> = {
  codex: "Codex",
  workbuddy: "WorkBuddy",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  cursor: "Cursor",
  hermes: "Hermes",
  deepseek_harness: "DeepSeek Harness"
};

export function isBuiltinSkillItem(item: SkillPanelItem): boolean {
  return CUBY_BUILTIN_SKILL_NAMES.has(normalizeSkillName(item.title));
}

/** Source for grouping; missing/internal sources are locally learned skills. */
export function skillSourceOf(item: SkillPanelItem): string {
  const raw = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? (item.metadata as Record<string, unknown>).source
    : undefined;
  const source = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!source || source === "unknown") return "memmy";
  return source;
}

export function sourceLabel(source: string): string {
  const known = SOURCE_LABELS[source];
  if (known) return known;
  return source
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Other";
}

export function buildSkillTabs(items: SkillPanelItem[]): SkillTab[] {
  const builtinNames = new Set(
    items.filter(isBuiltinSkillItem).map((item) => normalizeSkillName(item.title))
  );
  const mine = items.filter(isMineSkillItem);
  const learned = items.filter((item) => !isBuiltinSkillItem(item) && skillSourceOf(item) === "memmy");
  const sources = new Map<string, number>();
  for (const item of items) {
    if (isBuiltinSkillItem(item) || isMineSkillItem(item)) continue;
    const source = skillSourceOf(item);
    if (source === "memmy") continue;
    sources.set(source, (sources.get(source) ?? 0) + 1);
  }

  const tabs: SkillTab[] = [];
  if (builtinNames.size > 0) tabs.push({ id: "builtin", group: "builtin", count: builtinNames.size });
  if (mine.length > 0) tabs.push({ id: "mine", group: "mine", count: mine.length });
  if (learned.length > 0) tabs.push({ id: "learned", group: "learned", count: learned.length });
  for (const [source, count] of [...sources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    tabs.push({ id: `source:${source}`, group: "source", source, count });
  }
  return tabs;
}

export function cardsForTab(items: SkillPanelItem[], tabId: SkillTabId): SkillCard[] {
  if (tabId === "builtin") return builtinCards(items);
  if (tabId === "mine") {
    return sortedCards(items.filter(isMineSkillItem), "mine");
  }
  if (tabId === "learned") {
    return sortedCards(items.filter((item) => !isBuiltinSkillItem(item) && skillSourceOf(item) === "memmy"), "learned");
  }
  const source = tabId.slice("source:".length);
  return sortedCards(
    items.filter((item) => !isBuiltinSkillItem(item) && skillSourceOf(item) === source),
    "source",
    source
  );
}

/** Mixed results keep built-in copies merged so search does not repeat them. */
export function searchCards(items: SkillPanelItem[]): SkillCard[] {
  const cards: SkillCard[] = [...builtinCards(items), ...cardsForTab(items, "mine"), ...cardsForTab(items, "learned")];
  const sources = [...new Set(
    items
      .filter((item) => !isBuiltinSkillItem(item) && !isMineSkillItem(item))
      .map(skillSourceOf)
      .filter((source) => source !== "memmy")
  )].sort();
  for (const source of sources) {
    cards.push(...cardsForTab(items, `source:${source}`));
  }
  return cards;
}

function isMineSkillItem(item: SkillPanelItem): boolean {
  return !isBuiltinSkillItem(item) && MINE_SOURCES.has(skillSourceOf(item));
}

function builtinCards(items: SkillPanelItem[]): SkillCard[] {
  const byName = new Map<string, SkillPanelItem[]>();
  for (const item of items) {
    if (!isBuiltinSkillItem(item)) continue;
    const name = normalizeSkillName(item.title);
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, copies]) => {
      const item = [...copies].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]!;
      return { key: `builtin:${name}`, group: "builtin" as const, item, mergedItems: copies };
    });
}

function sortedCards(
  items: SkillPanelItem[],
  group: "mine" | "learned" | "source",
  source?: string
): SkillCard[] {
  return [...items]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((item) => ({
      key: group === "source" ? `source:${source}:${item.id}` : `${group}:${item.id}`,
      group,
      ...(source ? { source } : {}),
      item,
      mergedItems: [item]
    }));
}

function normalizeSkillName(title: string | undefined): string {
  return (title ?? "").trim().toLowerCase();
}
