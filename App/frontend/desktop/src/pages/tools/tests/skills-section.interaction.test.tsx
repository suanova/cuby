// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../../app/providers.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { SkillsSection } from "../skills-section.js";
import { createMemoryRuntimeClientStub, skillPanelDetailFixture, skillPanelItemsFixture } from "../../memory/tests/fixtures.js";

describe("SkillsSection interaction", () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("loads the Skill layer, opens a detail, and deletes the selected skill", async () => {
    const skillId = skillPanelItemsFixture.items[0]!.id;
    const listPanelItems = vi.fn(async () => skillPanelItemsFixture);
    const getMemory = vi.fn(async () => skillPanelDetailFixture);
    const listMemoryLogs = vi.fn(async () => emptyLogs());
    const deleteMemory = vi.fn(async () => ({
      ok: true as const,
      id: skillId,
      kind: "skill" as const,
      status: "deleted" as const,
      changeSeq: 1,
      syncCursor: "cursor-1",
      serverTime: "2026-06-03T10:00:00.000Z"
    }));
    const client = createMemoryRuntimeClientStub({ listPanelItems, getMemory, listMemoryLogs, deleteMemory });

    await act(async () => {
      root.render(
        <AppProviders>
          <I18nProvider language="zh-CN">
            <SkillsSection client={client} onOpenMemoryReference={vi.fn()} />
          </I18nProvider>
        </AppProviders>
      );
    });

    expect(listPanelItems).toHaveBeenCalledWith({ layer: "Skill", page: 1 });
    expect(container.querySelectorAll(".tools-icon-grid > .integration-card")).toHaveLength(
      skillPanelItemsFixture.items.length
    );

    act(() => container.querySelector<HTMLButtonElement>(".integration-card")?.click());
    await act(async () => undefined);

    expect(getMemory).toHaveBeenCalledWith(skillId);
    expect(container.querySelector(".memory-drawer")).not.toBeNull();

    const deleteButton = container.querySelector<HTMLButtonElement>(".memory-delete-button");
    act(() => deleteButton?.click());
    await act(async () => {
      deleteButton?.click();
    });

    expect(deleteMemory).toHaveBeenCalledWith(skillId);
  });

  it("opens a skill requested by cross-page navigation", async () => {
    const getMemory = vi.fn(async () => skillPanelDetailFixture);
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => skillPanelItemsFixture),
      getMemory,
      listMemoryLogs: vi.fn(async () => emptyLogs())
    });
    const onRequestHandled = vi.fn();

    await act(async () => {
      root.render(
        <AppProviders>
          <I18nProvider language="zh-CN">
            <SkillsSection
              client={client}
              request={{ skillId: "skill-memory-1", requestId: 7 }}
              onRequestHandled={onRequestHandled}
              onOpenMemoryReference={vi.fn()}
            />
          </I18nProvider>
        </AppProviders>
      );
    });

    expect(getMemory).toHaveBeenCalledWith("skill-memory-1");
    expect(onRequestHandled).toHaveBeenCalledWith(7);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("acknowledges a focus-only request without opening a skill", async () => {
    const getMemory = vi.fn(async () => skillPanelDetailFixture);
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => skillPanelItemsFixture),
      getMemory
    });
    const onRequestHandled = vi.fn();

    await act(async () => {
      root.render(
        <AppProviders>
          <I18nProvider language="zh-CN">
            <SkillsSection
              client={client}
              request={{ skillId: null, requestId: 9 }}
              onRequestHandled={onRequestHandled}
              onOpenMemoryReference={vi.fn()}
            />
          </I18nProvider>
        </AppProviders>
      );
    });

    expect(getMemory).not.toHaveBeenCalled();
    expect(onRequestHandled).toHaveBeenCalledWith(9);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("imports a local SKILL.md into the Skill layer", async () => {
    const addMemory = vi.fn(async () => ({
      id: "skill-local",
      kind: "skill" as const,
      memoryLayer: "Skill" as const,
      status: "activated" as const,
      title: "my-skill",
      summary: "",
      tags: ["manual"],
      createdAt: "2026-10-28T00:00:00.000Z",
      serverTime: "2026-10-28T00:00:00.000Z"
    }));
    const listPanelItems = vi.fn(async () => skillPanelItemsFixture);
    const client = createMemoryRuntimeClientStub({ listPanelItems, addMemory });

    await act(async () => {
      root.render(
        <AppProviders>
          <I18nProvider language="zh-CN">
            <SkillsSection client={client} onOpenMemoryReference={vi.fn()} />
          </I18nProvider>
        </AppProviders>
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const content = "---\nname: my-skill\n---\n# My Skill\n";
    const file = new File([content], "SKILL.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({
      layer: "Skill",
      source: "manual",
      sourceAgentId: "manual",
      title: "my-skill",
      content
    }));
    expect(listPanelItems.mock.calls.length).toBeGreaterThan(1);
  });

  it("routes skill detail references back to the memory page", async () => {
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => skillPanelItemsFixture),
      getMemory: vi.fn(async () => skillPanelDetailFixture),
      listMemoryLogs: vi.fn(async () => emptyLogs())
    });
    const onOpenMemoryReference = vi.fn();

    await act(async () => {
      root.render(
        <AppProviders>
          <I18nProvider language="zh-CN">
            <SkillsSection client={client} onOpenMemoryReference={onOpenMemoryReference} />
          </I18nProvider>
        </AppProviders>
      );
    });

    act(() => container.querySelector<HTMLButtonElement>(".integration-card")?.click());
    await act(async () => undefined);

    const reference = container.querySelector<HTMLButtonElement>(".memory-policy-id--link");
    expect(reference).not.toBeNull();
    act(() => reference?.click());

    expect(onOpenMemoryReference).toHaveBeenCalledWith("memory-policy-1", "policies");
  });
});

function emptyLogs() {
  return {
    logs: [],
    total: 0,
    limit: 500,
    offset: 0,
    serverTime: "2026-06-03T10:00:00.000Z"
  };
}
