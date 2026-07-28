import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { requiredActivationEvents } from "../../src/audit.ts";
import { archonBinary, harnessRoot } from "../../src/paths.ts";

const evidenceSchema = z.object({
  valid: z.literal(true),
  modules: z.array(z.string()),
  activations: z.record(z.string(), z.string()),
  auditEntries: z.number().int().positive(),
});

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "archon-harness-e2e-"));
  try {
    const archonHome = join(root, "archon");
    const agentDir = join(root, "omp-agent");
    const workflows = join(archonHome, "workflows");
    const auditFile = join(root, "audit.jsonl");
    await Promise.all([
      mkdir(workflows, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await copyFile(
      join(harnessRoot(), "config", "archon-efficient.yaml"),
      join(workflows, "archon-efficient.yaml"),
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

    const child = Bun.spawn(
      [
        archonBinary(),
        "workflow",
        "run",
        "archon-efficient",
        "no-model integration probe",
        "--cwd",
        harnessRoot(),
        "--no-worktree",
      ],
      {
        cwd: harnessRoot(),
        env: {
          ARCHON_HOME: archonHome,
          ARCHON_HARNESS_DATA: join(homedir(), ".local", "share", "archon-harness"),
          ARCHON_TELEMETRY_DISABLED: "1",
          DO_NOT_TRACK: "1",
          PI_CODING_AGENT_DIR: agentDir,
          PATH: process.env.PATH || "/usr/bin:/bin",
          SHELL: "/bin/zsh",
          TMPDIR: root,
          HARNESS_ROOT: harnessRoot(),
          HARNESS_BUN: process.execPath,
          HARNESS_OMP: join(harnessRoot(), "tests", "fixtures", "fake-omp.ts"),
          HARNESS_EXTENSION: join(harnessRoot(), "src", "extension", "index.ts"),
          HARNESS_AUDIT_PATH: auditFile,
          AGENTMEMORY_URL: "http://127.0.0.1:3111",
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
    if (exitCode !== 0) throw new Error(`Archon E2E failed (${exitCode}):\n${stderr}\n${stdout}`);
    if (!stderr.includes("[postflight] Completed"))
      throw new Error("Archon did not complete postflight");
    if (!stdout.includes("title.generate_failed") || !stdout.includes("title.fallback_set")) {
      throw new Error(
        `Archon's title path did not fail closed and apply its fallback:\n${stdout.slice(0, 4_000)}`,
      );
    }
    if (stdout.includes("title.generate_completed")) {
      throw new Error("Archon made an unexpected successful title-model call");
    }

    const evidenceMatch = stdout.match(/"evidence":\s*"([^"]+\/evidence\.json)"/);
    const evidencePath = evidenceMatch?.[1];
    if (!evidencePath) throw new Error("Archon did not report an evidence artifact");
    const evidence = evidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8")));
    if (JSON.stringify(evidence.activations) !== JSON.stringify(requiredActivationEvents)) {
      throw new Error("Evidence activation contract does not match the harness contract");
    }

    const runs = JSON.parse(
      await new Response(
        Bun.spawn(
          [archonBinary(), "workflow", "runs", "--cwd", harnessRoot(), "--json", "--limit", "1"],
          {
            env: {
              ARCHON_HOME: archonHome,
              PI_CODING_AGENT_DIR: agentDir,
              PATH: process.env.PATH || "",
            },
            stdout: "pipe",
          },
        ).stdout,
      ).text(),
    );
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
      .parse(runs).runs[0];
    if (!latest) throw new Error("Archon did not persist the completed run");

    process.stdout.write(
      `${JSON.stringify({ ok: true, nodesCompleted: 3, auditEntries: evidence.auditEntries, evidencePath })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await run();
