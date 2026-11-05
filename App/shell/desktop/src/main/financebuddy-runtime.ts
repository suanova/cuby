import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SETUP_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const SETUP_ERRORS = {
  payload_invalid: "The bundled payload failed its integrity check.",
  workspace_conflict: "The active workspace contains conflicting FinanceBuddy files.",
  config_changed: "The active Cuby configuration changed during setup. Restart Cuby to retry.",
  config_invalid: "The active Cuby configuration could not be validated.",
  runtime_missing: "A required bundled FinanceBuddy runtime file is missing.",
  install_failed: "The bundled installer could not complete setup."
};

interface BundledFinanceBuddyOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  configPath: string;
  agentWorkspace: string;
}

function setupDiagnostic(stdout: string): string | undefined {
  try {
    const code: unknown = JSON.parse(stdout)?.error_code;
    if (typeof code === "string" && Object.hasOwn(SETUP_ERRORS, code)) {
      return `[${code}]. ${SETUP_ERRORS[code as keyof typeof SETUP_ERRORS]}`;
    }
  } catch {
    // The installer may fail before it can emit its structured receipt.
  }
  return undefined;
}

/** Materialize the optional Windows bundle in the exact workspace selected for this boot. */
export async function prepareBundledFinanceBuddy(options: BundledFinanceBuddyOptions): Promise<boolean> {
  if (options.platform !== "win32" || !options.isPackaged) return false;

  const runtimeRoot = join(options.resourcesPath, "financebuddy-runtime");
  if (!existsSync(runtimeRoot)) return false;

  const python = join(runtimeRoot, "python", "python.exe");
  const installer = join(runtimeRoot, "payload", "install_packaged.py");
  if (!existsSync(python)) throw new Error("Bundled FinanceBuddy setup failed [runtime_missing]. Missing python/python.exe.");
  if (!existsSync(installer)) throw new Error("Bundled FinanceBuddy setup failed [runtime_missing]. Missing payload/install_packaged.py.");

  const args = ["-B", "-X", "utf8", installer, "--config", options.configPath, "--workspace", options.agentWorkspace];
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATH"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  await new Promise<void>((resolveSetup, rejectSetup) => {
    try {
      execFile(python, args, {
        cwd: runtimeRoot,
        env,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: SETUP_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: OUTPUT_LIMIT_BYTES
      }, (error, stdout) => {
        if (!error) {
          resolveSetup();
          return;
        }
        // Child output can contain configuration details. Only these diagnostics reach startup logs.
        const diagnostic = setupDiagnostic(stdout);
        if (diagnostic) {
          rejectSetup(new Error(`Bundled FinanceBuddy setup failed ${diagnostic}`));
        } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          rejectSetup(new Error("Bundled FinanceBuddy setup exceeded its diagnostic output limit."));
        } else if (error.killed && error.signal === "SIGKILL") {
          rejectSetup(new Error("Bundled FinanceBuddy setup timed out after 120 seconds."));
        } else if (typeof error.code === "number") {
          rejectSetup(new Error(`Bundled FinanceBuddy setup failed (exit code ${error.code}).`));
        } else if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") {
          rejectSetup(new Error(`Could not launch bundled FinanceBuddy setup (${error.code}).`));
        } else {
          rejectSetup(new Error("Bundled FinanceBuddy setup could not complete."));
        }
      });
    } catch {
      rejectSetup(new Error("Could not launch bundled FinanceBuddy setup."));
    }
  });
  return true;
}
