/** Search palette module. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "../pages/memory/memory-prototype-icons.js";
import type { MemmyAgentProject } from "../api/memmy-agent-client.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";
import { matchesProjectDiscovery, type ProjectDiscoveryMap } from "../pages/project-discovery.js";

export interface SearchPaletteProps {
  open: boolean;
  tasks: AgentTaskView[];
  projects?: MemmyAgentProject[];
  projectMetadata?: ProjectDiscoveryMap;
  onSelectProject?: (project: MemmyAgentProject) => void;
  projectRegistryState?: "ready" | "corrupt";
  onClose: () => void;
  onSelectTask: (task: AgentTaskView) => void;
  placeholder?: string;
  emptyLabel?: string;
  untitledLabel?: string;
  ariaLabel?: string;
  standaloneLabel?: string;
  missingProjectLabel?: string;
  registryUnavailableLabel?: string;
}

export function SearchPalette(props: SearchPaletteProps) {
  const {
    open,
    tasks,
    projects = [],
    projectRegistryState = "ready",
    onClose,
    onSelectTask,
    placeholder,
    emptyLabel,
    untitledLabel,
    ariaLabel
  } = props;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = filterTasks(tasks, query, projects, {
    projectRegistryState,
    standaloneLabel: props.standaloneLabel,
    missingProjectLabel: props.missingProjectLabel,
    registryUnavailableLabel: props.registryUnavailableLabel,
    projectMetadata: props.projectMetadata,
  });
  const displayTasks = query.trim() ? filtered : tasks.slice(0, 12);
  const projectMatches = props.onSelectProject && projectRegistryState === "ready"
    ? [...projects].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.createdAt.localeCompare(left.createdAt))
      .filter(project => matchesProjectDiscovery(project, query, props.projectMetadata))
    : [];
  const displayProjects = query.trim() ? projectMatches : projectMatches.slice(0, 12);
  const resultCount = displayProjects.length + displayTasks.length;

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, Math.min(i + 1, resultCount - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const project = displayProjects[activeIndex];
      if (project) props.onSelectProject?.(project);
      else {
        const task = displayTasks[activeIndex - displayProjects.length];
        if (task) onSelectTask(task);
      }
    }
  }

  return (
    <div className="search-palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-palette" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="search-palette-input-row">
          <Search size={16} className="search-palette-icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-palette-input"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="search-palette-list" ref={listRef} role="listbox">
          {resultCount === 0 && (
            <div className="search-palette-empty">{emptyLabel}</div>
          )}
          {displayProjects.map((project, index) => <button
            key={`project:${project.id}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            aria-label={[project.name, props.projectMetadata?.[project.id]?.summary, "展開項目"].filter(Boolean).join(" · ")}
            title={project.rootPath}
            className={`search-palette-item${index === activeIndex ? " search-palette-item--active" : ""}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => props.onSelectProject?.(project)}
          >
            <span className="search-palette-item-title">{project.name}</span>
            {props.projectMetadata?.[project.id] && <span className="search-palette-item-preview">{props.projectMetadata[project.id]!.summary}</span>}
            <span className="search-palette-item-preview">展開項目</span>
          </button>)}
          {displayTasks.map((task, taskIndex) => {
            const i = displayProjects.length + taskIndex;
            const ownership = resolveTaskOwnership(task, projects, {
              projectRegistryState,
              standaloneLabel: props.standaloneLabel,
              missingProjectLabel: props.missingProjectLabel,
              registryUnavailableLabel: props.registryUnavailableLabel,
              projectMetadata: props.projectMetadata,
            });
            const taskLabel = [task.title || untitledLabel || "", ownership].filter(Boolean).join(" · ");
            return (
            <button
              key={task.sessionKey}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              aria-label={taskLabel}
              title={props.projectMetadata ? task.cwd || ownership || undefined : ownership || undefined}
              className={`search-palette-item${i === activeIndex ? " search-palette-item--active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelectTask(task)}
            >
              <span className="search-palette-item-title">{task.title || untitledLabel}</span>
              {task.preview && <span className="search-palette-item-preview">{task.preview}</span>}
              {ownership && <span className="search-palette-item-preview">{ownership}</span>}
            </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function filterTasks(
  tasks: AgentTaskView[],
  searchQuery: string,
  projects: MemmyAgentProject[] = [],
  labels: TaskOwnershipLabels = {}
): AgentTaskView[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((task) => {
    const haystack = [
      task.title,
      task.preview,
      ...task.tags,
      resolveTaskOwnership(task, projects, labels),
      task.cwd,
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

interface TaskOwnershipLabels {
  projectMetadata?: ProjectDiscoveryMap;
  projectRegistryState?: "ready" | "corrupt";
  standaloneLabel?: string;
  missingProjectLabel?: string;
  registryUnavailableLabel?: string;
}

export function resolveTaskOwnership(
  task: AgentTaskView,
  projects: MemmyAgentProject[],
  labels: TaskOwnershipLabels = {}
): string {
  const project = task.groupProjectId
    ? projects.find((candidate) => candidate.id === task.groupProjectId) ?? null
    : null;
  if (project) {
    // Root metadata describes its selected project version, not every historical task.
    return labels.projectMetadata ? project.name : `${project.name} · ${task.cwd}`;
  }
  if (task.projectId == null) return "";
  const unavailableLabel = labels.projectRegistryState === "corrupt"
    ? labels.registryUnavailableLabel
    : labels.missingProjectLabel;
  return [unavailableLabel, task.cwd].filter(Boolean).join(" · ");
}
