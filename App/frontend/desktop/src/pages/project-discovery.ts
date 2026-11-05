import type { FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentProject } from "../api/memmy-agent-client.js";

/** Optional application facts; the platform keeps the user's native project name. */
export interface ProjectDiscoveryMetadata {
  summary: string;
  searchText: string;
}

export type ProjectDiscoveryMap = Record<string, ProjectDiscoveryMetadata>;

export function matchesProjectDiscovery(
  project: MemmyAgentProject,
  query: string,
  metadata: ProjectDiscoveryMap = {},
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [project.name, project.rootPath, metadata[project.id]?.searchText]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
}

/** Explicit unique native binding; no title/path/company/FY inference. */
export function financeProjectDiscoveryByNativeId(projects: FinanceProject[]): ProjectDiscoveryMap {
  const bindings = new Map<string, FinanceProject[]>();
  for (const project of projects) {
    if (!project.external_id) continue;
    bindings.set(project.external_id, [...(bindings.get(project.external_id) ?? []), project]);
  }
  const result: ProjectDiscoveryMap = {};
  for (const [nativeId, matches] of bindings) {
    if (matches.length !== 1) continue;
    const project = matches[0]!;
    const version = project.versions.find(candidate => candidate.id === project.active_version)
      ?? project.versions.at(-1);
    const storedYear = version?.fiscal_year.trim();
    const year = storedYear && /^\d{4}\/\d{2}$/.test(storedYear) ? storedYear : undefined;
    const statuses = (["consistency", "c2"] as const).map(kind => {
      const review = [...(version?.reviews ?? [])].reverse().find(candidate => candidate.kind === kind);
      const label = kind === "c2" ? "C2" : "一致性";
      const state = review ? {
        not_started: "未開始", running: "進行中", completed: "已完成", partial: "部分完成", failed: "失敗",
      }[review.status] : "未確認";
      return `${label}：${state}`;
    });
    const summary = [year ? `FY${year}` : "財年未確認", ...statuses].join(" · ");
    result[nativeId] = { summary, searchText: summary };
  }
  return result;
}
