import { describe, expect, it } from "vitest";
import { appViewContainer, buildAppCsp, cubyHostContext, injectAppCsp } from "../app-theme.js";

describe("appViewContainer", () => {
  const expandedFrame = { clientWidth: 1408, offsetTop: 61, offsetParent: { clientHeight: 900 } };

  it("keeps the fixed chat budget for an inline view", () => {
    expect(appViewContainer({ displayMode: "inline" })).toEqual({ width: 800, maxHeight: 640 });
    expect(appViewContainer({ displayMode: "inline", frame: expandedFrame }))
      .toEqual({ width: 800, maxHeight: 640 });
  });

  it("reports the frame's real width and the height left below it in fullscreen", () => {
    expect(appViewContainer({ displayMode: "fullscreen", frame: expandedFrame, overlayPaddingBottom: 16 }))
      .toEqual({ width: 1408, maxHeight: 823 });
    expect(appViewContainer({
      displayMode: "fullscreen",
      frame: { clientWidth: 1887.6, offsetTop: 61, offsetParent: { clientHeight: 1040 } },
    })).toEqual({ width: 1887, maxHeight: 979 });
  });

  it("falls back to the inline budget when the frame has no layout", () => {
    expect(appViewContainer({ displayMode: "fullscreen" })).toEqual({ width: 800, maxHeight: 640 });
    expect(appViewContainer({ displayMode: "fullscreen", frame: null })).toEqual({ width: 800, maxHeight: 640 });
    expect(appViewContainer({
      displayMode: "fullscreen",
      frame: { clientWidth: 1408, offsetTop: 61, offsetParent: null },
    })).toEqual({ width: 800, maxHeight: 640 });
    expect(appViewContainer({
      displayMode: "fullscreen",
      frame: { clientWidth: 0, offsetTop: 0, offsetParent: { clientHeight: 0 } },
    })).toEqual({ width: 800, maxHeight: 640 });
  });
});

describe("cubyHostContext", () => {
  it("maps Cuby tokens to MCP Apps style variables", () => {
    const context = cubyHostContext({
      displayMode: "inline", container: { width: 800, maxHeight: 480 }, locale: "zh-CN", theme: "light",
      readToken: (name) => `value-of-${name}`
    });
    expect(context).toMatchObject({
      theme: "light",
      displayMode: "inline",
      locale: "zh-CN",
      containerDimensions: { width: 800, maxHeight: 480 },
      styles: { variables: expect.objectContaining({
        "--color-background-primary": expect.any(String),
        "--color-text-primary": expect.any(String),
        "--font-sans": expect.any(String)
      }) }
    });
  });

  it("denies network by default and only allows declared CSP domains", () => {
    const denied = buildAppCsp();
    expect(denied).toContain("default-src 'none'");
    expect(denied).not.toContain("connect-src");
    expect(denied).toContain("base-uri 'none'");

    const allowed = buildAppCsp({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://player.example.com"],
      baseUriDomains: ["https://example.com"],
    });
    expect(allowed).toContain("connect-src https://api.example.com");
    expect(allowed).toContain("img-src data: https://cdn.example.com");
    expect(allowed).toContain("frame-src https://player.example.com");
    expect(allowed).toContain("base-uri https://example.com");
  });

  it("injects the CSP meta before the document body", () => {
    const html = injectAppCsp("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(html).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("</head>"));
  });
});
