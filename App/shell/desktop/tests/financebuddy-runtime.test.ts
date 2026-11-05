import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareBundledFinanceBuddy } from "../src/main/financebuddy-runtime.js";

const { execFile, existsSync } = vi.hoisted(() => ({ execFile: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:fs", () => ({ existsSync }));

const options = {
  platform: "win32" as const,
  isPackaged: true,
  resourcesPath: resolve("TEST ONLY Cuby & app", "resources"),
  configPath: resolve("TEST ONLY active profile", "config.yaml"),
  agentWorkspace: resolve("TEST ONLY chosen workspace & reports")
};
const runtimeRoot = join(options.resourcesPath, "financebuddy-runtime");
const python = join(runtimeRoot, "python", "python.exe");
const installer = join(runtimeRoot, "payload", "install_packaged.py");

type Callback = (error: unknown, stdout: string, stderr: string) => void;

function complete(error: unknown, stdout = "", stderr = "") {
  execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    queueMicrotask(() => callback(error, stdout, stderr));
  });
}

describe("bundled Windows FinanceBuddy startup", () => {
  beforeEach(() => {
    execFile.mockReset();
    existsSync.mockReset();
    existsSync.mockImplementation((file: string) => [runtimeRoot, python, installer].includes(file));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("skips development, other platforms and packages without the optional bundle", async () => {
    await expect(prepareBundledFinanceBuddy({ ...options, isPackaged: false })).resolves.toBe(false);
    await expect(prepareBundledFinanceBuddy({ ...options, platform: "darwin" })).resolves.toBe(false);
    expect(existsSync).not.toHaveBeenCalled();
    existsSync.mockReturnValue(false);
    await expect(prepareBundledFinanceBuddy(options)).resolves.toBe(false);
    expect(existsSync).toHaveBeenCalledExactlyOnceWith(runtimeRoot);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    [python, "Missing python/python.exe"],
    [installer, "Missing payload/install_packaged.py"]
  ])("reports a partial bundle before launching %s", async (missing, message) => {
    existsSync.mockImplementation((file: string) => file !== missing);
    await expect(prepareBundledFinanceBuddy(options)).rejects.toThrow(message);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("waits for setup and passes the exact active paths as direct argv", async () => {
    vi.stubEnv("CUBY_CONFIG", "TEST ONLY stale config override");
    vi.stubEnv("CUBY_AGENT_WORKSPACE", "TEST ONLY stale workspace override");
    vi.stubEnv("PYTHONPATH", "TEST ONLY other Python modules");
    vi.stubEnv("OPENAI_API_KEY", "TEST ONLY unneeded environment value");
    let finish: Callback | undefined;
    execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Callback) => { finish = callback; });
    let ready = false;
    const setup = prepareBundledFinanceBuddy(options).then(result => { ready = result; });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(python, [
      "-B", "-X", "utf8", installer, "--config", options.configPath, "--workspace", options.agentWorkspace
    ], expect.objectContaining({ cwd: runtimeRoot, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 }), expect.any(Function));
    const env = execFile.mock.calls[0]?.[2].env;
    expect(env).not.toHaveProperty("CUBY_CONFIG");
    expect(env).not.toHaveProperty("CUBY_AGENT_WORKSPACE");
    expect(env).not.toHaveProperty("PYTHONPATH");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    finish?.(null, "", "");
    await setup;
    expect(ready).toBe(true);
  });

  it("uses an allowlisted error code and discards installer details", async () => {
    complete({ code: 3, message: "TEST ONLY raw process error" }, JSON.stringify({ error_code: "config_changed", detail: "TEST ONLY private config" }), "TEST ONLY private stderr");
    await expect(prepareBundledFinanceBuddy(options)).rejects.toThrow(/^Bundled FinanceBuddy setup failed \[config_changed\]\. The active Cuby configuration changed during setup\. Restart Cuby to retry\.$/);
  });

  it.each(["TEST ONLY arbitrary stdout", JSON.stringify({ error_code: "unknown", detail: "TEST ONLY private config" })])("reports only the exit code for non-protocol output", async (stdout) => {
    complete({ code: 5, message: "TEST ONLY raw process error" }, stdout, "TEST ONLY private stderr");
    await expect(prepareBundledFinanceBuddy(options)).rejects.toThrow(/^Bundled FinanceBuddy setup failed \(exit code 5\)\.$/);
  });

  it("reports a bounded timeout separately from an output overflow", async () => {
    complete({ code: null, killed: true, signal: "SIGKILL" });
    await expect(prepareBundledFinanceBuddy(options)).rejects.toThrow("timed out after 120 seconds");
    complete({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" });
    await expect(prepareBundledFinanceBuddy(options)).rejects.toThrow("exceeded its diagnostic output limit");
  });
});
