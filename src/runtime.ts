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
import {
  harnessProfileSchema,
  type HarnessProfile,
  managedProfilesSchema,
  type ManagedProfiles,
  profileModelEnvironment,
  profileWorkflow,
} from "./profile.ts";
import { ensureAgentMemory } from "./services/agentmemory.ts";
import { processRunner } from "./process-runner.ts";

export interface ArchonInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  profile: HarnessProfile;
  auditFile: string;
  finalResponseFile: string;
  archonStdoutLog: string;
  archonStderrLog: string;
  agentStderrLog: string;
}

export interface ArchonExecutionResult {
  exitCode: number;
  profile?: HarnessProfile;
  response?: string;
  logs: {
    stdout: string;
    stderr: string;
    agent: string;
  };
}

const legacyRuntimeSchema = z.object({ omp: modelSelectionSchema });

export async function readManagedProfiles(): Promise<ManagedProfiles> {
  const path = join(managedArchonHome(), "harness.yaml");
  const raw = parse(await readFile(path, "utf8"));
  const current = managedProfilesSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = legacyRuntimeSchema.parse(raw).omp;
  return {
    defaultProfile: "omp-native",
    profiles: { "omp-native": legacy },
  };
}

export async function readManagedModel(
  profile: HarnessProfile = "omp-native",
): Promise<ModelSelection | undefined> {
  return (await readManagedProfiles()).profiles[profile];
}

function requireProfileModel(profile: HarnessProfile, model?: ModelSelection): ModelSelection {
  if (model) return model;
  throw new Error(
    `No model configured for ${profile}. Re-run install:harness with --${profile === "omp-native" ? "omp" : "pi"}-model <provider/model>.`,
  );
}

export function buildArchonInvocation(
  message: string,
  cwd: string,
  runId: string = crypto.randomUUID(),
  profile: HarnessProfile = "omp-native",
  model?: ModelSelection,
): ArchonInvocation {
  const root = harnessRoot();
  const auditFile = auditPath(runId);
  const finalResponseFile = join(dirname(auditFile), "responses", `${runId}.txt`);
  const archonStdoutLog = runLogPath(runId, "archon-stdout");
  const archonStderrLog = runLogPath(runId, "archon-stderr");
  const agentStderrLog = runLogPath(runId, "agent-stderr");
  const modelEnvironment = profileModelEnvironment[profile];
  return {
    executable: archonBinary(),
    args: [
      "workflow",
      "run",
      profileWorkflow[profile],
      message,
      "--cwd",
      resolve(cwd),
      "--no-worktree",
    ],
    cwd: resolve(cwd),
    profile,
    env: {
      ARCHON_HOME: managedArchonHome(),
      ARCHON_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      TITLE_GENERATION_MODEL: "archon-harness/no-title",
      HARNESS_ROOT: root,
      HARNESS_BUN: process.execPath,
      ...(process.env.HARNESS_OMP ? { HARNESS_OMP: process.env.HARNESS_OMP } : {}),
      HARNESS_PI: process.env.HARNESS_PI || join(root, "node_modules", ".bin", "pi"),
      HARNESS_AUDIT_PATH: auditFile,
      HARNESS_FINAL_RESPONSE: finalResponseFile,
      HARNESS_AGENT_LOG: agentStderrLog,
      AGENTMEMORY_URL: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
      CI: "1",
      ...(model ? { [modelEnvironment.model]: model.model } : {}),
      ...(model?.thinking ? { [modelEnvironment.thinking]: model.thinking } : {}),
    },
    auditFile,
    finalResponseFile,
    archonStdoutLog,
    archonStderrLog,
    agentStderrLog,
  };
}

export async function executeArchonInvocation(
  invocation: ArchonInvocation,
): Promise<ArchonExecutionResult> {
  await Promise.all([
    mkdir(dirname(invocation.finalResponseFile), { recursive: true }),
    mkdir(dirname(invocation.archonStdoutLog), { recursive: true }),
    mkdir(dirname(invocation.archonStderrLog), { recursive: true }),
    mkdir(dirname(invocation.agentStderrLog), { recursive: true }),
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
    profile: invocation.profile,
    ...(exitCode === 0
      ? { response: (await readFile(invocation.finalResponseFile, "utf8")).trim() }
      : {}),
    logs: {
      stdout: invocation.archonStdoutLog,
      stderr: invocation.archonStderrLog,
      agent: invocation.agentStderrLog,
    },
  };
}

export async function runArchon(
  message: string,
  cwd: string,
  profile?: HarnessProfile,
): Promise<number> {
  const result = await runArchonCaptured(message, cwd, profile);
  if (result.exitCode === 0) {
    process.stdout.write(`${result.response}\n`);
  } else {
    process.stderr.write(
      `Archon workflow failed (exit ${result.exitCode}). Logs: ${result.logs.stderr}, ${result.logs.agent}\n`,
    );
  }
  return result.exitCode;
}

export async function runArchonCaptured(
  message: string,
  cwd: string,
  requestedProfile?: HarnessProfile,
): Promise<ArchonExecutionResult> {
  const managed = await readManagedProfiles();
  const profile = requestedProfile ?? managed.defaultProfile;
  const model = requireProfileModel(profile, managed.profiles[profile]);
  return executeArchonInvocation(
    buildArchonInvocation(message, cwd, crypto.randomUUID(), profile, model),
  );
}

function requireCheck(check: CheckResult): void {
  if (!check.ok) throw new Error(`${check.name}: ${check.detail}`);
}

function piPackageEnvironment(root = harnessRoot()): Record<string, string> {
  return {
    PI_PACKAGE_DIR: join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
  };
}

async function verifyPiExtensions(_cwd: string): Promise<void> {
  const root = harnessRoot();
  const result = await processRunner.run({
    executable: process.env.HARNESS_NODE || "node",
    args: [join(root, "scripts", "verify-pi-extensions.mjs"), root],
    cwd: root,
    env: piPackageEnvironment(root),
    timeoutMs: 30_000,
    maxOutputBytes: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Pi extension verification failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function executableVersion(
  executable: string,
  expected: RegExp,
  name: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<CheckResult> {
  const child = Bun.spawn([executable, "--version"], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const detail = (stdout || stderr).trim();
  return { name, ok: exitCode === 0 && expected.test(detail), detail };
}

export async function preflight(
  profileInput: HarnessProfile,
  cwd: string,
): Promise<Record<string, unknown>> {
  const profile = harnessProfileSchema.parse(profileInput);
  const canonicalCwd = resolve(cwd);
  await recordAudit("archon", "workflow_preflight", { cwd: canonicalCwd, profile });

  const batch = await smokeBatch(canonicalCwd, profile === "pi-modular");
  requireCheck(batch);

  const index = await gitNexusAdapter.ensureIndex(canonicalCwd);
  requireCheck(index);
  await recordAudit("gitnexus", "index_ready", index.evidence ?? {});

  if (profile === "omp-native") {
    if (DEFAULT_EDIT_MODE !== "hashline") {
      throw new Error(`OMP DEFAULT_EDIT_MODE is ${DEFAULT_EDIT_MODE}, expected hashline`);
    }
    requireCheck(
      await executableVersion(
        process.env.HARNESS_OMP || join(harnessRoot(), "node_modules", ".bin", "omp"),
        /17\.1\.6/,
        "omp",
        canonicalCwd,
      ),
    );
  } else {
    const service = await ensureAgentMemory();
    if (!service.ok) throw new Error(service.detail);
    await recordAudit("agentmemory", "service_ready", { detail: service.detail });
    const rtk = await rtkAdapter.smoke(canonicalCwd);
    requireCheck(rtk);
    await recordAudit("rtk", "rewrite_verified", rtk.evidence ?? {});
    requireCheck(
      await executableVersion(
        process.env.HARNESS_PI || join(harnessRoot(), "node_modules", ".bin", "pi"),
        /0\.82\.1/,
        "pi",
        canonicalCwd,
        piPackageEnvironment(),
      ),
    );
    await verifyPiExtensions(canonicalCwd);
  }

  const policy = await readFile(join(harnessRoot(), "prompts", "concise-final.md"), "utf8");
  if (!policy.includes("Lead with the result")) throw new Error("Concise final policy is missing");
  return { cwd: canonicalCwd, profile, batching: batch.detail, gitnexus: index.detail };
}

function agentPaths(
  artifactsDir: string,
  environment: NodeJS.ProcessEnv,
): { response: string; stderr: string } {
  const root = join(resolve(artifactsDir), "harness");
  return {
    response: environment.HARNESS_FINAL_RESPONSE || join(root, "final-response.txt"),
    stderr: environment.HARNESS_AGENT_LOG || join(root, "agent-stderr.log"),
  };
}

export interface ProfileAgentInvocation {
  executable: string;
  args: string[];
  cwd: string;
  responseFile: string;
  stderrLog: string;
  env: Record<string, string>;
}

export function buildProfileAgentInvocation(
  profileInput: HarnessProfile,
  cwd: string,
  artifactsDir: string,
  message: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProfileAgentInvocation {
  const profile = harnessProfileSchema.parse(profileInput);
  const root = harnessRoot();
  const paths = agentPaths(artifactsDir, environment);
  const modelEnvironment = profileModelEnvironment[profile];
  const model = environment[modelEnvironment.model];
  const thinking = environment[modelEnvironment.thinking];
  if (!model) {
    throw new Error(
      `No model configured for ${profile}. Re-run install:harness with --${profile === "omp-native" ? "omp" : "pi"}-model <provider/model>.`,
    );
  }
  const ompOverride = environment.HARNESS_OMP;
  const args =
    profile === "omp-native" && ompOverride
      ? [
          "-p",
          "--no-title",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--cwd",
          resolve(cwd),
          "--max-time",
          "15m",
          "--config",
          join(root, "config", "omp-native.yml"),
          "--extension",
          join(root, "src", "extension", "omp.ts"),
        ]
      : profile === "omp-native"
        ? [
            join(root, "src", "omp-runner.ts"),
            "--cwd",
            resolve(cwd),
            "--max-time-ms",
            "900000",
            "--config",
            join(root, "config", "omp-native.yml"),
            "--extension",
            join(root, "src", "extension", "omp.ts"),
          ]
        : [
            "-p",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--offline",
            "--extension",
            join(root, "node_modules", "pi-hashline-edit-pro", "index.ts"),
            "--extension",
            join(root, "src", "extension", "pi.ts"),
          ];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (profile === "omp-native") args.push("--");
  args.push(message);
  return {
    executable:
      profile === "omp-native"
        ? ompOverride || environment.HARNESS_BUN || process.execPath
        : environment.HARNESS_PI || join(root, "node_modules", ".bin", "pi"),
    args,
    cwd: resolve(cwd),
    responseFile: paths.response,
    stderrLog: paths.stderr,
    env: profile === "pi-modular" ? piPackageEnvironment(root) : {},
  };
}

export async function runProfileAgent(
  profileInput: HarnessProfile,
  cwd: string,
  artifactsDir: string,
  message: string,
): Promise<number> {
  const invocation = buildProfileAgentInvocation(profileInput, cwd, artifactsDir, message);
  await Promise.all([
    mkdir(dirname(invocation.responseFile), { recursive: true }),
    mkdir(dirname(invocation.stderrLog), { recursive: true }),
  ]);
  const child = Bun.spawn([invocation.executable, ...invocation.args], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    stdin: "ignore",
    stdout: Bun.file(invocation.responseFile),
    stderr: Bun.file(invocation.stderrLog),
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) return exitCode;
  const response = (await readFile(invocation.responseFile, "utf8")).trim();
  if (!response) throw new Error(`${profileInput} completed without a final response`);
  process.stdout.write(`${response}\n`);
  return 0;
}

export async function postflight(profile: HarnessProfile, artifactsDir: string): Promise<string> {
  const auditFile = process.env.HARNESS_AUDIT_PATH;
  if (!auditFile) throw new Error("HARNESS_AUDIT_PATH is not set");
  return writeEvidence(auditFile, resolve(artifactsDir), harnessProfileSchema.parse(profile));
}

export async function doctor(cwd: string): Promise<CheckResult[]> {
  const root = harnessRoot();
  const results = await Promise.all([
    rtkAdapter.doctor(),
    gitNexusAdapter.doctor(),
    agentMemoryAdapter.doctor(),
    executableVersion(join(root, "node_modules", ".bin", "omp"), /17\.1\.6/, "omp", cwd),
    executableVersion(
      join(root, "node_modules", ".bin", "pi"),
      /0\.82\.1/,
      "pi",
      cwd,
      piPackageEnvironment(root),
    ),
  ]);
  try {
    await verifyPiExtensions(cwd);
    results.push({
      name: "pi-hashline",
      ok: true,
      detail: "strict read/replace extensions loaded",
    });
  } catch (error) {
    results.push({ name: "pi-hashline", ok: false, detail: String(error) });
  }
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
  return results;
}
