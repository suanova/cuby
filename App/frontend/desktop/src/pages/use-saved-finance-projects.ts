import { useCallback, useEffect, useRef, useState } from "react";
import { FinanceProjectListSchema, type FinanceProject } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { financeProjectDiscoveryByNativeId } from "./project-discovery.js";

export interface SavedFinanceSelection {
  project_id: string;
  version_id: string;
}

/** Only an explicit service binding identifies an application's native project. */
export function savedFinanceProjectsByNativeId(projects: FinanceProject[]) {
  const result: Record<string, { selection: SavedFinanceSelection; detail: string }> = {};
  const bindings = new Map<string, FinanceProject[]>();
  for (const project of projects) {
    if (!project.external_id) continue;
    bindings.set(project.external_id, [...(bindings.get(project.external_id) ?? []), project]);
  }
  for (const [nativeId, matches] of bindings) {
    // Ambiguous bindings must not open an arbitrary report library.
    if (matches.length !== 1) continue;
    const project = matches[0]!;
    const version = project.versions.find(v => v.id === project.active_version && v.documents.length)
      ?? [...project.versions].reverse().find(v => v.documents.length);
    if (!version || version.runs.length > 0) continue;
    result[nativeId] = {
      selection: { project_id: project.id, version_id: version.id },
      detail: `FY${version.fiscal_year} · 版本${project.versions.indexOf(version) + 1} · ${version.documents.length}份文件`,
    };
  }
  return result;
}

/** Reuses the existing startup library connection, with stale-client protection. */
export function useSavedFinanceProjects(
  client: MemmyAgentClient | undefined,
  enabled: boolean,
  connectionStatus: string,
  onLoaded: () => void,
) {
  const [projects, setProjects] = useState<FinanceProject[]>([]);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!enabled || !client?.financeReaderRequest) { setProjects([]); setError(false); return; }
    setError(false);
    try {
      const response = FinanceProjectListSchema.parse(await client.financeReaderRequest({ action: "project-list" }));
      if (request !== sequence.current) return;
      setProjects(response.projects);
      onLoadedRef.current();
    } catch {
      if (request === sequence.current) { setProjects([]); setError(true); }
    }
  }, [client, enabled, connectionStatus]);
  useEffect(() => {
    setProjects([]);
    void refresh();
    return () => { sequence.current++; };
  }, [refresh]);
  return { entries: savedFinanceProjectsByNativeId(projects), metadata: financeProjectDiscoveryByNativeId(projects), error, refresh };
}
