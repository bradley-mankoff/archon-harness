import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { requiredActivationEvents } from "../../src/audit.ts";
import { archonBinary, harnessRoot } from "../../src/paths.ts";
import type { HarnessProfile } from "../../src/profile.ts";

const evidenceSchema = z.object({
  valid: z.literal(true),
  profile: z.enum(["omp-native", "pi-modular"]),
  activations: z.record(z.string(), z.string()),
  auditEntries: z.number().int().positive(),
});

interface ProfileResult {
  profile: HarnessProfile;
  auditEntries: number;
  evidencePath: string;
}

async function readLogTail(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).slice(-4_000);
  } catch (error) {
    return `<unavailable: ${String(error)}>`;
  }
}

async function runChecked(executable: string, args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Archon Harness Fixture",
      GIT_AUTHOR_EMAIL: "fixture@archon-harness.invalid",
      GIT_COMMITTER_NAME: "Archon Harness Fixture",
      GIT_COMMITTER_EMAIL: "fixture@archon-harness.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
}

function startMemoryFixture(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/agentmemory/health") return Response.json({ ok: true });
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const body = (await request.json()) as { sessionId?: string };
      if (path === "/agentmemory/session/start") {
        return Response.json({
          session: { id: body.sessionId ?? "fixture", status: "active" },
          context: "",
        });
      }
      if (path === "/agentmemory/smart-search") {
        return Response.json({ lessons: [], mode: "compact", results: [] });
      }
      if (path === "/agentmemory/observe" || path === "/agentmemory/session/end") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function runProfile(profile: HarnessProfile): Promise<ProfileResult> {
  const root = await mkdtemp(join(tmpdir(), `archon-harness-e2e-${profile}-`));
  const memory = profile === "pi-modular" ? startMemoryFixture() : undefined;
  try {
    const archonHome = join(root, "archon");
    const workflows = join(archonHome, "workflows");
    const repository = join(root, "repository");
    await Promise.all([
      mkdir(workflows, { recursive: true }),
      mkdir(join(repository, "src"), { recursive: true }),
    ]);
    await writeFile(
      join(repository, "src", "probe.ts"),
      "export function noModelIntegrationProbe(): string { return 'ready'; }\n",
      "utf8",
    );
    await runChecked("git", ["init", "-q"], repository);
    await runChecked("git", ["add", "src/probe.ts"], repository);
    await runChecked("git", ["commit", "-qm", "Add integration probe"], repository);

    const workflow = profile === "omp-native" ? "archon-efficient-omp" : "archon-efficient-pi";
    await copyFile(
      join(harnessRoot(), "config", `${workflow}.yaml`),
      join(workflows, `${workflow}.yaml`),
    );
    await writeFile(
      join(archonHome, "config.yaml"),
      stringify({
        botName: "Archon Harness Integration",
        defaultAssistant: "pi",
        assistants: {
          pi: { model: "no-model/no-model", enableExtensions: true, interactive: false },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(archonHome, "harness.yaml"),
      stringify({
        defaultProfile: profile,
        profiles: {
          "omp-native": { model: "no-model/no-model", thinking: "off" },
          "pi-modular": { model: "no-model/no-model", thinking: "off" },
        },
      }),
      "utf8",
    );

    const child = Bun.spawn(
      [
        process.execPath,
        join(harnessRoot(), "src", "cli.ts"),
        "chat",
        "--profile",
        profile,
        "--cwd",
        repository,
        "no-model integration probe",
      ],
      {
        cwd: harnessRoot(),
        env: {
          ARCHON_HARNESS_DATA: root,
          HOME: homedir(),
          GITNEXUS_HOME: join(root, "gitnexus-home"),
          PATH: process.env.PATH || "/usr/bin:/bin",
          SHELL: "/bin/zsh",
          TMPDIR: root,
          HARNESS_ROOT: harnessRoot(),
          HARNESS_BUN: process.execPath,
          HARNESS_OMP: join(harnessRoot(), "tests", "fixtures", "fake-omp.ts"),
          HARNESS_PI: join(harnessRoot(), "tests", "fixtures", "fake-omp.ts"),
          ...(profile === "pi-modular" ? { HARNESS_FAKE_PI: "1" } : {}),
          AGENTMEMORY_URL: memory?.url.origin ?? "http://127.0.0.1:3111",
          ARCHON_TELEMETRY_DISABLED: "1",
          DO_NOT_TRACK: "1",
          CI: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 300_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timeout));

    const logDir = join(root, "logs");
    const logFiles = await readdir(logDir).catch(() => []);
    const logPath = (suffix: string) =>
      join(logDir, logFiles.find((path) => path.endsWith(suffix)) ?? "missing");
    const archonStdoutPath = logPath(".archon-stdout.log");
    const archonStderrPath = logPath(".archon-stderr.log");
    const agentLogPath = logPath(".agent-stderr.log");

    if (exitCode !== 0) {
      const [archonStdout, archonStderr, agentStderr] = await Promise.all([
        readLogTail(archonStdoutPath),
        readLogTail(archonStderrPath),
        readLogTail(agentLogPath),
      ]);
      throw new Error(
        `${profile} E2E failed (${exitCode}):\nCLI stderr:\n${stderr}\nCLI stdout:\n${stdout}\nArchon stdout:\n${archonStdout}\nArchon stderr:\n${archonStderr}\nAgent stderr:\n${agentStderr}`,
      );
    }

    const expectedResponse =
      profile === "omp-native"
        ? "no-model OMP lifecycle completed\n"
        : "no-model Pi lifecycle completed\n";
    if (stdout !== expectedResponse || stderr !== "") {
      throw new Error(
        `${profile} terminal was not response-only:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }

    const [archonStdout, archonStderr, agentStderr] = await Promise.all([
      readFile(archonStdoutPath, "utf8"),
      readFile(archonStderrPath, "utf8"),
      readFile(agentLogPath, "utf8"),
    ]);
    if (!archonStderr.includes("[postflight] Completed")) {
      throw new Error(`${profile} did not complete postflight`);
    }
    if (
      !archonStdout.includes("title.generate_failed") ||
      !archonStdout.includes("title.fallback_set")
    ) {
      throw new Error(`${profile} title path did not fail closed and apply its fallback`);
    }
    if (archonStdout.includes("title.generate_completed")) {
      throw new Error(`${profile} made an unexpected successful title-model call`);
    }
    if (agentStderr !== "Working...\n") {
      throw new Error(`${profile} progress was not retained in the agent log`);
    }

    const evidenceMatch = archonStdout.match(/"evidence":\s*"([^"]+\/evidence\.json)"/);
    const evidencePath = evidenceMatch?.[1];
    if (!evidencePath) throw new Error(`${profile} did not report an evidence artifact`);
    const evidence = evidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8")));
    if (
      evidence.profile !== profile ||
      JSON.stringify(evidence.activations) !== JSON.stringify(requiredActivationEvents[profile])
    ) {
      throw new Error(`${profile} evidence does not match its activation contract`);
    }

    const runsChild = Bun.spawn(
      [archonBinary(), "workflow", "runs", "--cwd", repository, "--json", "--limit", "1"],
      {
        env: {
          ARCHON_HOME: archonHome,
          GITNEXUS_HOME: join(root, "gitnexus-home"),
          PATH: process.env.PATH || "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [runsOutput, runsError, runsExit] = await Promise.all([
      new Response(runsChild.stdout).text(),
      new Response(runsChild.stderr).text(),
      runsChild.exited,
    ]);
    if (runsExit !== 0) throw new Error(`${profile} run lookup failed: ${runsError}`);
    const latest = z
      .object({
        runs: z.array(
          z.object({
            status: z.literal("completed"),
            metadata: z.object({
              node_counts: z.object({ completed: z.literal(3), failed: z.literal(0) }),
            }),
          }),
        ),
      })
      .parse(JSON.parse(runsOutput)).runs[0];
    if (!latest) throw new Error(`${profile} did not persist the completed run`);

    return { profile, auditEntries: evidence.auditEntries, evidencePath };
  } finally {
    if (memory) await memory.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

const profiles = await Promise.all([runProfile("omp-native"), runProfile("pi-modular")]);
process.stdout.write(`${JSON.stringify({ ok: true, nodesCompleted: 6, profiles })}\n`);
