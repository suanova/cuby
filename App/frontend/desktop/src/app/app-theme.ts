const TOKEN_MAP: Record<string, string> = {
  "--color-background-primary": "--color-background-paper",
  "--color-background-secondary": "--color-canvas-oat",
  "--color-text-primary": "--color-text-ink",
  "--color-text-secondary": "--color-ink-muted",
  "--color-border-primary": "--color-border-stone",
  "--color-ring-primary": "--color-action-sky",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
  "--border-radius-md": "--radius-card",
  "--border-radius-sm": "--radius-btn",
  "--shadow-md": "--shadow-card",
};

export type AppCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

function cspDomains(values: string[] | undefined): string {
  return (values ?? []).filter((value) => typeof value === "string" && value.trim()).join(" ");
}

export function buildAppCsp(csp?: AppCsp): string {
  const resource = cspDomains(csp?.resourceDomains);
  const connect = cspDomains(csp?.connectDomains);
  const frame = cspDomains(csp?.frameDomains);
  const base = cspDomains(csp?.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resource ? ` ${resource}` : ""}`,
    `style-src 'unsafe-inline'${resource ? ` ${resource}` : ""}`,
    `img-src data:${resource ? ` ${resource}` : ""}`,
    ...(resource ? [`font-src ${resource}`, `media-src ${resource}`] : []),
    ...(connect ? [`connect-src ${connect}`] : []),
    ...(frame ? [`frame-src ${frame}`] : []),
    `base-uri ${base || "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function injectAppCsp(html: string, csp?: AppCsp): string {
  const content = buildAppCsp(csp).replace(/"/g, "&quot;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${content}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${meta}`);
  }
  return `${meta}${html}`;
}

export function detectCubyTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  return root.dataset.theme === "dark" || root.classList.contains("dark") ? "dark" : "light";
}

export function detectCubyLocale(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
}

export function watchCubyTheme(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(() => callback())
    : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
  const media = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const onChange = () => callback();
  media?.addEventListener?.("change", onChange);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.("change", onChange);
  };
}

const INLINE_APP_VIEW_CONTAINER = { width: 800, maxHeight: 640 };

/**
 * The room an app view has. An inline view keeps the fixed chat budget. An
 * expanded view sits in a fixed overlay, which is then the frame's offset
 * parent: report the frame's real width and the height left below its top
 * edge, so a page can lay out for the window it actually has.
 */
export function appViewContainer(input: {
  displayMode: "inline" | "fullscreen";
  frame?: {
    clientWidth: number;
    offsetTop: number;
    offsetParent: { clientHeight: number } | null;
  } | null;
  overlayPaddingBottom?: number;
}): { width: number; maxHeight: number } {
  const overlay = input.frame?.offsetParent;
  if (input.displayMode !== "fullscreen" || !input.frame || !overlay) {
    return { ...INLINE_APP_VIEW_CONTAINER };
  }
  const width = Math.floor(input.frame.clientWidth);
  const maxHeight = Math.floor(
    overlay.clientHeight - input.frame.offsetTop - (input.overlayPaddingBottom ?? 0),
  );
  // No layout yet (or a test DOM without one): keep the inline budget.
  if (!(width > 0) || !(maxHeight > 0)) return { ...INLINE_APP_VIEW_CONTAINER };
  return { width, maxHeight };
}

export function cubyHostContext(input: {
  displayMode: "inline" | "fullscreen";
  container: { width: number; height?: number; maxHeight?: number };
  locale: string;
  theme: "light" | "dark";
  readToken?: (name: string) => string;
}): Record<string, unknown> {
  const readToken = input.readToken ?? ((name: string) => {
    if (typeof document === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  });

  const variables: Record<string, string> = {};
  for (const [target, source] of Object.entries(TOKEN_MAP)) {
    const value = readToken(source);
    if (value) variables[target] = value;
  }

  return {
    theme: input.theme,
    displayMode: input.displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: input.container,
    locale: input.locale,
    timeZone: typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined,
    platform: "desktop",
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    styles: { variables },
  };
}
