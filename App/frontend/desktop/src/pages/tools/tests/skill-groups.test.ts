import { describe, expect, it } from "vitest";
import type { PanelItemsOutput } from "@memmy/local-api-contracts";
import {
  buildSkillTabs,
  cardsForTab,
  isBuiltinSkillItem,
  searchCards,
  skillSourceOf,
  sourceLabel
} from "../skill-groups.js";

type SkillItem = PanelItemsOutput["items"][number];

function skill(options: {
  id: string;
  title: string;
  source?: string;
  summary?: string;
  updatedAt?: string;
}): SkillItem {
  return {
    id: options.id,
    kind: "skill",
    memoryLayer: "Skill",
    status: "activated",
    title: options.title,
    summary: options.summary ?? `${options.title} summary`,
    tags: [],
    ...(options.source ? { metadata: { source: options.source } } : {}),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-01T00:00:00.000Z",
    version: 1
  } as SkillItem;
}

const items = [
  skill({ id: "resume-codex", title: "memmy-resume", source: "codex", updatedAt: "2026-10-02T00:00:00.000Z" }),
  skill({ id: "resume-workbuddy", title: "memmy-resume", source: "workbuddy", updatedAt: "2026-10-03T00:00:00.000Z" }),
  skill({ id: "memory-opencode", title: "memmy-memory", source: "opencode" }),
  skill({ id: "imagegen", title: "imagegen", source: "codex" }),
  skill({ id: "docs", title: "openai-docs", source: "codex" }),
  skill({ id: "evolved", title: "archify_code_flow_diagram" }),
  skill({ id: "evolved-memmy", title: "local_web_page_issue_audit", source: "memmy" }),
  skill({ id: "mine", title: "my-release-check", source: "manual" }),
];

describe("skill groups", () => {
  it("identifies Cuby built-ins by skill name", () => {
    expect(isBuiltinSkillItem(items[0]!)).toBe(true);
    expect(isBuiltinSkillItem(items[2]!)).toBe(true);
    expect(isBuiltinSkillItem(items[3]!)).toBe(false);
  });

  it("treats missing or internal sources as locally learned", () => {
    expect(skillSourceOf(items[5]!)).toBe("memmy");
    expect(skillSourceOf(items[6]!)).toBe("memmy");
    expect(skillSourceOf(items[3]!)).toBe("codex");
  });

  it("builds tabs in builtin, mine, learned, then source order", () => {
    expect(buildSkillTabs(items)).toEqual([
      { id: "builtin", group: "builtin", count: 2 },
      { id: "mine", group: "mine", count: 1 },
      { id: "learned", group: "learned", count: 2 },
      { id: "source:codex", group: "source", source: "codex", count: 2 },
    ]);
  });

  it("merges built-in copies into one card", () => {
    const cards = cardsForTab(items, "builtin");

    expect(cards.map((card) => card.key)).toEqual(["builtin:memmy-memory", "builtin:memmy-resume"]);
    const resume = cards.find((card) => card.key === "builtin:memmy-resume")!;
    expect(resume.mergedItems.map((item) => item.id)).toEqual(["resume-codex", "resume-workbuddy"]);
    expect(resume.item.id).toBe("resume-workbuddy");
  });

  it("puts locally imported skills in the mine tab", () => {
    expect(cardsForTab(items, "mine").map((card) => card.item.title)).toEqual(["my-release-check"]);
  });

  it("keeps built-in copies out of their source tabs", () => {
    const cards = cardsForTab(items, "source:codex");

    expect(cards.map((card) => card.item.title)).toEqual(["imagegen", "openai-docs"]);
  });

  it("dedupes built-ins in search results and labels their group", () => {
    const cards = searchCards(items);

    expect(cards.map((card) => card.key)).toEqual([
      "builtin:memmy-memory",
      "builtin:memmy-resume",
      "mine:mine",
      "learned:evolved",
      "learned:evolved-memmy",
      "source:codex:imagegen",
      "source:codex:docs",
    ]);
  });

  it("labels known agent sources for cards", () => {
    expect(sourceLabel("codex")).toBe("Codex");
    expect(sourceLabel("workbuddy")).toBe("WorkBuddy");
    expect(sourceLabel("claude-code")).toBe("Claude Code");
    expect(sourceLabel("deepseek_harness")).toBe("DeepSeek Harness");
    expect(sourceLabel("some_new_agent")).toBe("Some New Agent");
  });
});
