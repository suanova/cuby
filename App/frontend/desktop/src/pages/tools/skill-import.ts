/** Local skill import module. */
import JSZip from "jszip";
import type { AddMemoryInput } from "@memmy/local-api-contracts";

export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_CHARS = 1_000_000;
export const MAX_SKILLS_PER_ARCHIVE = 50;

const IGNORED_SEGMENTS = new Set(["__MACOSX", ".git", "node_modules"]);
const LOCAL_IMPORT_SOURCE = "manual";

export class SkillImportError extends Error {}

export interface SkillImportFile {
  path: string;
  text: string;
}

export interface ImportedSkillDraft {
  name: string;
  description?: string;
  version?: string;
  content: string;
  sourceSkillId: string;
  sourceSkillPath: string;
}

export interface SkillImportFileLike {
  name: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

/** Extracts one draft per SKILL.md, skipping archives and tooling folders. */
export function skillDraftsFromFiles(files: SkillImportFile[]): ImportedSkillDraft[] {
  const drafts = files
    .filter((file) => isSkillMarkdown(file.path))
    .map((file) => draftFromMarkdown(file.text, file.path, directoryOf(file.path), file.path));
  if (drafts.length === 0) throw new SkillImportError("No SKILL.md found in the archive.");
  if (drafts.length > MAX_SKILLS_PER_ARCHIVE) {
    throw new SkillImportError(`The archive contains more than ${MAX_SKILLS_PER_ARCHIVE} skills.`);
  }
  return drafts;
}

export async function readSkillImportFile(file: SkillImportFileLike): Promise<ImportedSkillDraft[]> {
  if (file.size && file.size > MAX_IMPORT_FILE_BYTES) {
    throw new SkillImportError(`${file.name} is larger than ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB.`);
  }
  const buffer = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith(".zip")) {
    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(buffer);
    } catch {
      throw new SkillImportError(`${file.name} is not a valid zip archive.`);
    }
    const entries: SkillImportFile[] = [];
    for (const [path, entry] of Object.entries(archive.files)) {
      if (entry.dir || !isSkillMarkdown(path)) continue;
      entries.push({ path, text: await entry.async("string") });
    }
    return skillDraftsFromFiles(entries);
  }

  const text = file.text ? await file.text() : new TextDecoder().decode(buffer);
  return [draftFromMarkdown(text, file.name, "", file.name)];
}

export function skillImportMemoryInput(draft: ImportedSkillDraft): AddMemoryInput {
  return {
    content: draft.content,
    layer: "Skill",
    title: draft.name,
    source: LOCAL_IMPORT_SOURCE,
    sourceAgentId: LOCAL_IMPORT_SOURCE,
    sourceSkillId: draft.sourceSkillId,
    sourceSkillPath: draft.sourceSkillPath,
    ...(draft.version ? { sourceSkillVersion: draft.version } : {}),
    tags: ["local-import"]
  };
}

function draftFromMarkdown(
  content: string,
  path: string,
  directory: string,
  fallbackPath: string
): ImportedSkillDraft {
  if (content.length > MAX_SKILL_CHARS) {
    throw new SkillImportError(`${path} is larger than ${Math.round(MAX_SKILL_CHARS / 1000)}k characters.`);
  }
  const frontmatter = parseFrontmatter(content);
  const fallbackName = lastSegment(directory) || stripMarkdownExtension(fallbackPath);
  const name = frontmatter.name || fallbackName || "untitled-skill";
  return {
    name,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.version ? { version: frontmatter.version } : {}),
    content,
    sourceSkillId: directory || name,
    sourceSkillPath: path
  };
}

function parseFrontmatter(content: string): { name?: string; description?: string; version?: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const values: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---") break;
    const match = /^(name|description|version):\s*(.+)$/i.exec(line);
    if (match) values[match[1]!.toLowerCase()] = unquote(match[2]!.trim());
  }
  return {
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
    ...(values.version ? { version: values.version } : {})
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function isSkillMarkdown(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  const base = segments.at(-1)?.toLowerCase();
  return base === "skill.md";
}

function directoryOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}
