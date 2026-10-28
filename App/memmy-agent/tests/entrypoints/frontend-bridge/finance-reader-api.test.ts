import { describe, it, expect, vi } from "vitest";
import { FinanceReaderApi } from "../../../src/entrypoints/frontend-bridge/finance-reader-api.js";

const sha = "a".repeat(64);
const path = "outputs/c2-reviews/business-review/review.json";
const review = {
  schema_version: "financebuddy-reader-1",
  review_sha256: sha,
  source: { file_name: "report.pdf", report_fiscal_year: "2025/26", sha256: sha, language: "en" },
  target_period: {
    fiscal_year: "2025/26",
    start: "2025-04-01",
    end: "2026-03-31",
    scenario_assumption: false,
  },
  mode: "same_year",
  rules: { status: "selected_text_matches", checked_at: "2026-10-26", scope: "C2 28-29 only" },
  checks: [],
  anchors: {},
  pages: [{ number: 1, width: 100, height: 200 }],
  status_counts: {},
  rule_url: "https://en-rules.hkex.com.hk/",
  exclusions: [],
  human_review_notice: "Human review required",
};
const notes = { review_sha256: sha, revision: 0, decisions: {}, history: [] };
function setup(url = "http://127.0.0.1:60939") {
  const tool = vi.fn(async () => JSON.stringify({ reader_url: url }));
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url);
    if (route.endsWith("/api/health"))
      return Response.json({ app: "financebuddy-review-reader", review_sha256: sha });
    if (route.endsWith("/api/review")) return Response.json(review);
    if (route.endsWith("/api/drafts"))
      return Response.json({ review_sha256: sha, revision: 0, edits: [], history: [] });
    if (route.endsWith("/api/draft-export"))
      return Response.json({
        review_sha256: sha,
        draft: { review_sha256: sha, revision: 0, edits: [], history: [] },
        text: "Draft text",
        pages: [{ number: 1, text: "Draft text" }],
      });
    if (route.endsWith("/api/decisions"))
      return Response.json(notes, { status: init?.method === "POST" ? 409 : 200 });
    if (route.endsWith("/1.png"))
      return new Response(Buffer.from("89504e470d0a1a0a00000000", "hex"), {
        headers: { "Content-Type": "image/png" },
      });
    return new Response("company,period\n", { headers: { "Content-Type": "text/csv" } });
  });
  return { api: new FinanceReaderApi(tool, fetchFn as typeof fetch), tool, fetchFn };
}

describe("Native Cuby FinanceBuddy adapter", () => {
  it("routes persistent projects and review decisions only through their fixed tools", async()=>{
    const state={run_id:"20310101T000000-aabbccdd",base_sha256:sha,revision:1,proposals:{},decisions:{},history:[]};
    const tool=vi.fn(async()=>state),api=new FinanceReaderApi(tool);
    await api.request({action:"consistency-decide",run_id:state.run_id,check_id:"issue",expected_revision:0,operation:"dismiss"});
    expect(tool).toHaveBeenCalledWith("mcp_financebuddy_reports_edit_consistency_draft",{operation:"update",operation_decision:"dismiss",run_id:state.run_id,check_id:"issue",expected_revision:0});
    tool.mockClear();
    await expect(api.request({action:"consistency-draft-export",run_id:state.run_id,output_path:"C:/anything.docx"})).rejects.toThrow("Invalid report reader request");
    await expect(api.request({action:"project-save",project_id:"a".repeat(32),expected_revision:0,fiscal_year:"2031/32",documents:["esg_zh","esg_en","annual_zh","annual_en"].map(slot=>({slot,path:"C:/private/report.pdf"}))})).rejects.toThrow("已上載");
    expect(tool).not.toHaveBeenCalled();
  });
  it("allows only the fixed semantic tool and refuses renderer-supplied model credentials", async () => {
    const tool=vi.fn(async()=>JSON.stringify({})),api=new FinanceReaderApi(tool);
    await expect(api.request({action:"consistency-semantic-start",run_id:"20310101T000000-aabbccdd",config_path:"C:/private/key"})).rejects.toThrow("Invalid report reader request");
    expect(tool).not.toHaveBeenCalled();
    await expect(api.request({action:"consistency-semantic-start",run_id:"20310101T000000-aabbccdd"})).rejects.toThrow();
    expect(tool).toHaveBeenCalledWith("mcp_financebuddy_reports_start_consistency_semantic",{run_id:"20310101T000000-aabbccdd"});
  });
  it("routes four-report workflows through enabled fixed tools and rejects arbitrary PDF image URLs", async () => {
    const tool = vi.fn(async () => JSON.stringify({data_url:"https://attacker.example/page.png"}));
    const api = new FinanceReaderApi(tool);
    await expect(api.request({action:"consistency-page",run_id:"20310101T000000-aabbccdd",slot:"esg_en",page:1})).rejects.toThrow("Invalid consistency PDF");
    expect(tool).toHaveBeenCalledWith("mcp_financebuddy_reports_read_consistency_page",{run_id:"20310101T000000-aabbccdd",slot:"esg_en",page:1});
    await expect(api.request({action:"consistency-read",run_id:"../escape"})).rejects.toThrow("Invalid report reader request");
  });
  it("refuses untrusted upload paths before invoking the business tool", async () => {
    const tool=vi.fn();const api=new FinanceReaderApi(tool);
    await expect(api.request({action:"consistency-build",fiscal_year:"2031/32",documents:["esg_zh","esg_en","annual_zh","annual_en"].map(slot=>({slot,path:"C:/private/report.pdf"}))})).rejects.toThrow("已上載");
    expect(tool).not.toHaveBeenCalled();
  });
  it("routes reversible drafts through fixed authenticated resources", async () => {
    const { api, fetchFn } = setup();
    const opened = (await api.request({ action: "open", review_path: path })) as any;
    const value = {
      expected_revision: 0,
      check_id: "BASIS",
      operation: "accept",
      replacement: "Verified wording.",
      facts_confirmed: true,
    };
    await api.request({ action: "draft-save", handle: opened.handle, value });
    expect(fetchFn).toHaveBeenLastCalledWith(
      "http://127.0.0.1:60939/api/drafts",
      expect.objectContaining({ method: "POST", body: JSON.stringify(value) }),
    );
    expect(await api.request({ action: "draft-export", handle: opened.handle })).toHaveProperty(
      "text",
      "Draft text",
    );
    await expect(
      api.request({
        action: "draft-save",
        handle: opened.handle,
        value: { ...value, source_path: "secrets" },
      }),
    ).rejects.toThrow();
  });
  it("opens only through the installed MCP tool and returns opaque handles, not upstream URLs", async () => {
    const { api, tool, fetchFn } = setup();
    const result = (await api.request({ action: "open", review_path: path })) as any;
    expect(tool).toHaveBeenCalledWith("mcp_financebuddy_reports_open_c2_reader", {
      review_path: path,
    });
    expect(result.handle).toMatch(/^[a-f0-9-]{36}$/);
    expect(result).not.toHaveProperty("reader_url");
    const image = await api.request({ action: "page", handle: result.handle, page: 1 });
    expect(image).toHaveProperty("data_url", expect.stringMatching(/^data:image\/png;base64,/));
    expect(fetchFn).toHaveBeenLastCalledWith(
      "http://127.0.0.1:60939/api/page/1.png",
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it.each([
    "http://169.254.169.254",
    "http://localhost:60939",
    "http://127.0.0.1:60939/evil",
    "http://127.0.0.1:99999",
    "https://127.0.0.1:60939",
    "http://127.0.0.1:60939@evil.test",
  ])("rejects non-protocol reader address %s", async (address) => {
    const { api, fetchFn } = setup(address);
    await expect(api.request({ action: "open", review_path: path })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    "../../secrets.json",
    "outputs/c2-reviews/../../secrets/review.json",
    "D:/report.json",
    "outputs/c2-reviews/business-review/review.json?url=evil",
  ])("rejects arbitrary paths %s", async (review_path) => {
    const { api, tool } = setup();
    await expect(api.request({ action: "open", review_path })).rejects.toThrow();
    expect(tool).not.toHaveBeenCalled();
  });
  it("refuses unknown handles and generic forwarding", async () => {
    const { api, tool } = setup();
    await expect(
      api.request({ action: "page", handle: crypto.randomUUID(), page: 1 }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(api.request({ action: "fetch", url: "http://evil.test" })).rejects.toThrow();
    expect(tool).not.toHaveBeenCalled();
  });
  it("preserves 409 note conflicts and only forwards the fixed note endpoint", async () => {
    const { api, fetchFn } = setup();
    const result = (await api.request({ action: "open", review_path: path })) as any;
    const value = {
      expected_revision: 0,
      check_id: "check",
      decision: "needs_data",
      note: "Need source",
    };
    await expect(
      api.request({ action: "save", handle: result.handle, value }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchFn).toHaveBeenLastCalledWith(
      "http://127.0.0.1:60939/api/decisions",
      expect.objectContaining({
        body: JSON.stringify(value),
        headers: { "Content-Type": "application/json", "X-Reader-Request": "1" },
      }),
    );
  });
  it("rejects revision mismatches before issuing a handle", async () => {
    const { api, fetchFn } = setup();
    fetchFn.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/api/health")
          ? { app: "financebuddy-review-reader", review_sha256: "b".repeat(64) }
          : String(url).endsWith("/api/review")
            ? review
            : notes,
      ),
    );
    await expect(api.request({ action: "open", review_path: path })).rejects.toThrow(
      "revision mismatch",
    );
  });
  it("does not substitute a same-named review from a different attachment workspace", async () => {
    const { api, fetchFn } = setup();
    await expect(
      api.request({
        action: "open",
        review_path: path,
        artifact_path: "/another-workspace/" + path,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("verifies that page responses are PNG bytes", async () => {
    const { api, fetchFn } = setup();
    const result = (await api.request({ action: "open", review_path: path })) as any;
    fetchFn.mockResolvedValue(
      new Response("<script>evil</script>", { headers: { "Content-Type": "image/png" } }),
    );
    await expect(api.request({ action: "page", handle: result.handle, page: 1 })).rejects.toThrow(
      "Invalid PDF page",
    );
  });
});
