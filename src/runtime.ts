import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_EDIT_MODE } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { agentMemoryAdapter } from "./adapters/agentmemory.ts";
import { gitNexusAdapter } from "./adapters/gitnexus.ts";
import { rtkAdapter } from "./adapters/rtk.ts";
import { recordAudit, writeEvidence } from "./audit.ts";
import { smokeBatch } from "./batch.ts";
import type { CheckResult } from "./contracts.ts";
import { modelSelectionSchema, type ModelSelection } from "./model.ts";
import { archonBinary, auditPath, harnessRoot, managedArchonHome, runLogPath } from "./paths.ts";
import { ensureAgentMemory } from "./services/agentmemory.ts";

export interface ArchonInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  auditFile: string;
  finalResponseFile: string;
  archonStdoutLog: string;
  archonStderrLog: string;
  ompStderrLog: string;
}

export interface ArchonExecutionResult {
  exitCode: number;
  response?: string;
  logs: {
    stdout: string;
    stderr: string;
    omp: string;
  };
}

const managedConfigSchema = z.object({
  assistants: z.object({ pi: z.object({ model: z.string().min(1) }) }),
});

const managedRuntimeSchema = z.object({ omp: modelSelectionSchema });

async function readManagedModel(): Promise<ModelSelection> {
  const archonHome = managedArchonHome();
  try {
    const config = managedRuntimeSchema.parse(
      parse(await readFile(join(archonHome, "harness.yaml"), "utf8")),
    );
    return config.omp;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const legacy = managedConfigSchema.parse(
      parse(await readFile(join(archonHome, "config.yaml"), "utf8")),
    );
    return { model: legacy.assistants.pi.model };
  }
}

export function buildArchonInvocation(
  message: string,
  cwd: string,
  runId: string = crypto.randomUUID(),
  omp?: ModelSelection,
): ArchonInvocation {
  const root = harnessRoot();
  const auditFile = auditPath(runId);
  const finalResponseFile = join(dirname(auditFile), "responses", `${runId}.txt`);
  const archonStdoutLog = runLogPath(runId, "archon-stdout");
  const archonStderrLog = runLogPath(runId, "archon-stderr");
  const ompStderrLog = runLogPath(runId, "omp-stderr");
  return {
    executable: archonBinary(),
    args: ["workflow", "run", "archon-efficient", message, "--cwd", resolve(cwd), "--no-worktree"],
    cwd: resolve(cwd),
    env: {
      ARCHON_HOME: managedArchonHome(),
      HARNESS_ROOT: root,
      HARNESS_BUN: process.execPath,
      HARNESS_OMP: process.env.HARNESS_OMP || join(root, "node_modules", ".bin", "omp"),
      HARNESS_EXTENSION: join(root, "src", "extension", "index.ts"),
      HARNESS_AUDIT_PATH: auditFile,
      HARNESS_FINAL_RESPONSE: finalResponseFile,
      HARNESS_OMP_LOG: ompStderrLog,
      AGENTMEMORY_URL: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
      CI: "1",
      ...(omp ? { HARNESS_OMP_MODEL: omp.model } : {}),
      ...(omp?.thinking ? { HARNESS_OMP_THINKING: omp.thinking } : {}),
    },
    auditFile,
    finalResponseFile,
    archonStdoutLog,
    archonStderrLog,
    ompStderrLog,
  };
}

export async function printFinalResponse(
  path: string,
  write: (value: string) => unknown = (value) => process.stdout.write(value),
): Promise<void> {
  const response = (await readFile(path, "utf8")).trim();
  if (!response) throw new Error("OMP completed without a final response");
  write(`${response}\n`);
}

export async function executeArchonInvocation(
  invocation: ArchonInvocation,
): Promise<ArchonExecutionResult> {
  await Promise.all([
    mkdir(dirname(invocation.finalResponseFile), { recursive: true }),
    mkdir(dirname(invocation.archonStdoutLog), { recursive: true }),
    mkdir(dirname(invocation.archonStderrLog), { recursive: true }),
    mkdir(dirname(invocation.ompStderrLog), { recursive: true }),
  ]);
  const [stdoutLog, stderrLog] = await Promise.all([
    open(invocation.archonStdoutLog, "w"),
    open(invocation.archonStderrLog, "w"),
  ]);
  let exitCode: number;
  try {
    const child = Bun.spawn([invocation.executable, ...invocation.args], {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      stdin: "inherit",
      stdout: stdoutLog.fd,
      stderr: stderrLog.fd,
    });
    exitCode = await child.exited;
  } finally {
    await Promise.all([stdoutLog.close(), stderrLog.close()]);
  }
  return {
    exitCode,
    ...(exitCode === 0
      ? { response: (await readFile(invocation.finalResponseFile, "utf8")).trim() }
      : {}),
    logs: {
      stdout: invocation.archonStdoutLog,
      stderr: invocation.archonStderrLog,
      omp: invocation.ompStderrLog,
    },
  };
}

export async function runArchon(message: string, cwd: string): Promise<number> {
  const result = await runArchonCaptured(message, cwd);
  if (result.exitCode === 0) {
    process.stdout.write(`${result.response}\n`);
  } else {
    process.stderr.write(
      `Archon workflow failed (exit ${result.exitCode}). Logs: ${result.logs.stderr}, ${result.logs.omp}\n`,
    );
  }
  return result.exitCode;
}

export async function runArchonCaptured(
  message: string,
  cwd: string,
): Promise<ArchonExecutionResult> {
  const invocation = buildArchonInvocation(
    message,
    cwd,
    crypto.randomUUID(),
    await readManagedModel(),
  );
  return executeArchonInvocation(invocation);
}

function requireCheck(check: CheckResult): void {
  if (!check.ok) throw new Error(`${check.name}: ${check.detail}`);
}

export async function preflight(cwd: string): Promise<Record<string, unknown>> {
  const canonicalCwd = resolve(cwd);
  await recordAudit("archon", "workflow_preflight", { cwd: canonicalCwd });

  const service = await ensureAgentMemory();
  if (!service.ok) throw new Error(service.detail);
  await recordAudit("agentmemory", "service_ready", { detail: service.detail });

  const batch = await smokeBatch(canonicalCwd);
  requireCheck(batch);
  await recordAudit("batching", "dependency_steps_executed", batch.evidence ?? {});

  const rtk = await rtkAdapter.smoke(canonicalCwd);
  requireCheck(rtk);
  await recordAudit("rtk", "rewrite_verified", rtk.evidence ?? {});

  const index = await gitNexusAdapter.ensureIndex(canonicalCwd);
  requireCheck(index);
  await recordAudit("gitnexus", "index_ready", index.evidence ?? {});

  if (DEFAULT_EDIT_MODE !== "hashline") {
    throw new Error(`OMP DEFAULT_EDIT_MODE is ${DEFAULT_EDIT_MODE}, expected hashline`);
  }
  await recordAudit("hashline", "upstream_default_verified", { mode: DEFAULT_EDIT_MODE });

  const policy = await readFile(join(harnessRoot(), "prompts", "caveman-full.md"), "utf8");
  if (!policy.includes("Always-on output policy")) throw new Error("Caveman policy is missing");
  await recordAudit("caveman", "policy_verified", { bytes: Buffer.byteLength(policy) });

  return {
    cwd: canonicalCwd,
    agentmemory: service.detail,
    batching: batch.detail,
    rtk: rtk.detail,
    gitnexus: index.detail,
    hashline: DEFAULT_EDIT_MODE,
  };
}

export async function postflight(artifactsDir: string): Promise<string> {
  const auditFile = process.env.HARNESS_AUDIT_PATH;
  if (!auditFile) throw new Error("HARNESS_AUDIT_PATH is not set");
  return writeEvidence(auditFile, resolve(artifactsDir));
}

export async function doctor(cwd: string): Promise<CheckResult[]> {
  const results = await Promise.all([
    rtkAdapter.doctor(),
    gitNexusAdapter.doctor(),
    agentMemoryAdapter.doctor(),
  ]);
  const binary = archonBinary();
  try {
    const child = Bun.spawn([binary, "version"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    results.unshift({ name: "archon", ok: exitCode === 0, detail: (stdout || stderr).trim() });
  } catch (error) {
    results.unshift({ name: "archon", ok: false, detail: String(error) });
  }
  results.push({
    name: "hashline",
    ok: DEFAULT_EDIT_MODE === "hashline",
    detail: `OMP DEFAULT_EDIT_MODE=${DEFAULT_EDIT_MODE}`,
  });
  const omp = Bun.spawn([join(harnessRoot(), "node_modules", ".bin", "omp"), "--version"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [ompStdout, ompStderr, ompExitCode] = await Promise.all([
    new Response(omp.stdout).text(),
    new Response(omp.stderr).text(),
    omp.exited,
  ]);
  results.push({
    name: "omp",
    ok: ompExitCode === 0 && /17\.1\.6/.test(ompStdout),
    detail: (ompStdout || ompStderr).trim(),
  });
  return results;
}
