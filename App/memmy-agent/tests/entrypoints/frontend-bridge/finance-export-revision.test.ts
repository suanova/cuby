import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FinanceRequestSchema } from "@memmy/local-api-contracts";
import { FinanceReaderApi } from "../../../src/entrypoints/frontend-bridge/finance-reader-api.js";

const run = "20310101T000000-aabbccdd";
const request = { action: "consistency-draft-export", run_id: run, expected_revision: 2 } as const;

describe("revision-bound consistency exports", () => {
  it("requires an explicit nonnegative integer revision in the request contract", () => {
    expect(FinanceRequestSchema.safeParse(request).success).toBe(true);
    expect(FinanceRequestSchema.safeParse({ ...request, slot: "esg_en" }).success).toBe(true);
    for (const expected_revision of [undefined, null, true, -1, 1.5, "2"])
      expect(FinanceRequestSchema.safeParse({ ...request, expected_revision }).success).toBe(false);
  });

  it("forwards the selected revision and exposes a backend conflict without a download grant", async () => {
    const tool = vi.fn(async () => ({ status: "revision_conflict", revision: 3, expected_revision: 2 }));
    const api = new FinanceReaderApi(tool);
    await expect(api.request(request)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/重新載入/) });
    expect(tool).toHaveBeenCalledExactlyOnceWith("mcp_financebuddy_reports_edit_consistency_draft", {
      operation: "export", run_id: run, expected_revision: 2,
    });
    expect(() => api.download("not-granted")).toThrow(/下載已過期/);
  });

  it.each([1, 3])("rejects a backend returning revision %s instead of the requested revision", async revision => {
    const tool = vi.fn(async () => ({ status: "ready", revision }));
    const api = new FinanceReaderApi(tool);
    await expect(api.request(request)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/重新載入/) });
  });

  it("grants and downloads the exact matching revision with existing byte/hash integrity", async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const workspace = fs.mkdtempSync(path.join(tempRoot, "fb-export-revision-"));
    try {
      const folder = path.join(workspace, "outputs", "consistency", run, "exports", "r2");
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, "esg_en-revised.pdf");
      const bytes = Buffer.from("%PDF-1.7\nTEST ONLY download-integrity fixture\n");
      fs.writeFileSync(file, bytes);
      const result = { status: "ready", revision: 2, accepted: 0, file_path: file,
        file_name: "esg_en-revised.pdf", mime: "application/pdf", bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), layout_notice: "TEST ONLY" };
      const tool = vi.fn(async () => result);
      const api = new FinanceReaderApi(tool, fetch, undefined, undefined, workspace);
      const receipt = await api.request({ ...request, slot: "esg_en" }) as { revision: number; download_id: string };
      expect(receipt.revision).toBe(2);
      expect(api.download(receipt.download_id).data).toEqual(bytes);
      fs.writeFileSync(file, Buffer.from("%PDF-1.7\nchanged"));
      expect(() => api.download(receipt.download_id)).toThrow(/匯出檔案已變更/);
    } finally {
      if (path.dirname(workspace) !== tempRoot || !path.basename(workspace).startsWith("fb-export-revision-"))
        throw new Error("Unexpected temporary test path");
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
