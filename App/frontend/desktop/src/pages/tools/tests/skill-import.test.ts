import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  readSkillImportFile,
  skillDraftsFromFiles,
  skillImportMemoryInput,
  SkillImportError
} from "../skill-import.js";

describe("skill import", () => {
  it("reads SKILL.md entries and parses their frontmatter", () => {
    const drafts = skillDraftsFromFiles([
      { path: "my-skill/SKILL.md", text: "---\nname: release-check\ndescription: Check a release before shipping.\nversion: 1.2.0\n---\n\n# Release Check\n" },
      { path: "my-skill/scripts/run.sh", text: "echo hi" },
      { path: "__MACOSX/._SKILL.md", text: "metadata" }
    ]);

    expect(drafts).toEqual([
      {
        name: "release-check",
        description: "Check a release before shipping.",
        version: "1.2.0",
        content: "---\nname: release-check\ndescription: Check a release before shipping.\nversion: 1.2.0\n---\n\n# Release Check\n",
        sourceSkillId: "my-skill",
        sourceSkillPath: "my-skill/SKILL.md"
      }
    ]);
  });

  it("supports nested skill folders and falls back to the folder name", () => {
    const drafts = skillDraftsFromFiles([
      { path: "repo-main/skills/pdf-tools/SKILL.md", text: "# PDF Tools\n" },
      { path: "repo-main/skills/web-search/SKILL.md", text: "---\nname: \"web-search\"\n---\n# Search\n" }
    ]);

    expect(drafts.map((draft) => [draft.name, draft.sourceSkillId])).toEqual([
      ["pdf-tools", "repo-main/skills/pdf-tools"],
      ["web-search", "repo-main/skills/web-search"]
    ]);
  });

  it("rejects an archive with no SKILL.md", () => {
    expect(() => skillDraftsFromFiles([{ path: "README.md", text: "hello" }])).toThrow(SkillImportError);
  });

  it("reads a standalone markdown file", async () => {
    const drafts = await readSkillImportFile(fileLike("review.md", "---\nname: review-agent\ndescription: Review changes.\n---\n# Review\n"));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ name: "review-agent", description: "Review changes." });
  });

  it("reads every SKILL.md inside a zip", async () => {
    const zip = new JSZip();
    zip.file("skills/one/SKILL.md", "---\nname: one\n---\n# One\n");
    zip.file("skills/two/SKILL.md", "---\nname: two\n---\n# Two\n");
    zip.file("skills/two/README.md", "not a skill");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const drafts = await readSkillImportFile(fileLike("skills.zip", "", buffer));

    expect(drafts.map((draft) => draft.name)).toEqual(["one", "two"]);
  });

  it("builds a manual Skill memory request", () => {
    const input = skillImportMemoryInput({
      name: "release-check",
      description: "Check a release.",
      content: "# Release Check\n",
      sourceSkillId: "my-skill",
      sourceSkillPath: "my-skill/SKILL.md"
    });

    expect(input).toMatchObject({
      layer: "Skill",
      title: "release-check",
      content: "# Release Check\n",
      source: "manual",
      sourceAgentId: "manual",
      sourceSkillId: "my-skill",
      sourceSkillPath: "my-skill/SKILL.md",
      tags: ["local-import"]
    });
  });
});

function fileLike(name: string, text: string, buffer?: ArrayBuffer) {
  const data = buffer ?? new TextEncoder().encode(text).buffer;
  return {
    name,
    size: data.byteLength,
    arrayBuffer: async () => data,
    text: async () => text
  } as unknown as File;
}
