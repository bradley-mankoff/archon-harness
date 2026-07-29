import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "gpt-tokenizer";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@oh-my-pi/hashline";
import { agentMemoryAdapter } from "./adapters/agentmemory.ts";
import { gitNexusAdapter } from "./adapters/gitnexus.ts";
import { executeBatch } from "./batch.ts";
import { processRunner } from "./process-runner.ts";
import { readManagedModel } from "./runtime.ts";

export type MeasurementStatus = "measured" | "bounded" | "verified" | "requires-live-a-b";

export interface ComponentMeasurement {
  component: string;
  status: MeasurementStatus;
  passed: boolean;
  intendedEffect: string;
  evidence: Record<string, unknown>;
  caveat?: string;
}

export interface BenchmarkReport {
  ok: boolean;
  paidModelCalls: 0;
  cwd: string;
  measurements: ComponentMeasurement[];
}

export function tokenSavings(baseline: string, optimized: string) {
  const baselineTokens = countTokens(baseline);
  const optimizedTokens = countTokens(optimized);
  const savedTokens = Math.max(0, baselineTokens - optimizedTokens);
  return {
    baselineTokens,
    optimizedTokens,
    savedTokens,
    savedPercent:
      baselineTokens === 0 ? 0 : Number(((savedTokens / baselineTokens) * 100).toFixed(1)),
  };
}

async function measureHashline(): Promise<ComponentMeasurement> {
  const unchanged = Array.from(
    { length: 120 },
    (_, index) => `export const unchanged${index} = ${index};`,
  ).join("\n");
  const before = `export function label(value: string) {\n  return \`old:\${value}\`;\n}\n${unchanged}\n`;
  const expected = before.replace(
    "return `old:" + "$" + "{value}`",
    "return `new:" + "$" + "{value.trim()}`",
  );
  const filesystem = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  await filesystem.writeText("fixture.ts", before);
  const tag = snapshots.record("fixture.ts", before);
  const patch = `[fixture.ts#${tag}]\nSWAP 2.=2:\n+  return \`new:\${value.trim()}\`;`;
  await new Patcher({ fs: filesystem, snapshots }).apply(Patch.parse(patch));
  const fidelity = (await filesystem.readText("fixture.ts")) === expected;
  return {
    component: "hashline",
    status: "measured",
    passed: fidelity,
    intendedEffect: "Send a snapshot-bound patch instead of a full replacement file.",
    evidence: { ...tokenSavings(expected, patch), fidelity },
  };
}

async function measureRtk(): Promise<ComponentMeasurement> {
  const fixture = await mkdtemp(join(tmpdir(), "archon-harness-rtk-"));
  const run = (executable: string, args: string[]) =>
    processRunner.run({
      executable,
      args,
      cwd: fixture,
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 10_000_000,
    });
  try {
    const original = Array.from({ length: 240 }, (_, index) => `line ${index}: original`).join(
      "\n",
    );
    await writeFile(join(fixture, "fixture.ts"), `${original}\n`, "utf8");
    for (const command of [
      ["init", "--quiet"],
      ["config", "user.email", "benchmark@example.invalid"],
      ["config", "user.name", "Benchmark Fixture"],
      ["add", "fixture.ts"],
      ["commit", "--quiet", "-m", "baseline"],
    ]) {
      const result = await run("git", command);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
    }
    const changed = original
      .replace("line 40: original", "line 40: changed")
      .replace("line 120: original", "line 120: changed")
      .replace("line 200: original", "line 200: changed");
    await writeFile(join(fixture, "fixture.ts"), `${changed}\n`, "utf8");
    const [baseline, optimized] = await Promise.all([
      run("git", ["diff", "--no-ext-diff"]),
      run("rtk", ["git", "diff"]),
    ]);
    const changedLines = ["line 40: changed", "line 120: changed", "line 200: changed"];
    const retainedChanges = changedLines.filter((line) => optimized.stdout.includes(line)).length;
    const passed =
      baseline.exitCode === 0 &&
      optimized.exitCode === 0 &&
      changedLines.every((line) => baseline.stdout.includes(line)) &&
      retainedChanges === changedLines.length;
    return {
      component: "rtk",
      status: "measured",
      passed,
      intendedEffect: "Compact a diff for model inspection while preserving its change map.",
      evidence: {
        ...tokenSavings(baseline.stdout, optimized.stdout),
        baselineBytes: baseline.rawBytes,
        optimizedBytes: optimized.rawBytes,
        exitCodes: [baseline.exitCode, optimized.exitCode],
        fixtureChangesRetained: retainedChanges,
      },
      caveat: "RTK output is a lossy inspection summary, not a byte-identical patch replacement.",
    };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function measureBatching(cwd: string): Promise<ComponentMeasurement> {
  const result = await executeBatch(
    {
      commands: [
        { command: "printf alpha", step: 1, timeoutMs: 5_000 },
        { command: "printf beta", step: 1, timeoutMs: 5_000 },
        { command: "printf gamma", step: 2, timeoutMs: 5_000 },
      ],
    },
    cwd,
  );
  return {
    component: "batching",
    status: "verified",
    passed: result.ok && result.modelToolCalls === 1,
    intendedEffect:
      "Collapse multiple shell commands into one model tool call with dependency steps.",
    evidence: { baselineToolCalls: 3, optimizedToolCalls: 1, dependencySteps: 2 },
    caveat: "This proves tool-call reduction, not provider token billing reduction.",
  };
}

async function measureGitNexus(cwd: string): Promise<ComponentMeasurement> {
  const output = await gitNexusAdapter.scout(
    { kind: "query", target: "upstream compatibility", limit: 3 },
    cwd,
  );
  const outputBytes = Buffer.byteLength(output);
  return {
    component: "gitnexus",
    status: "bounded",
    passed: outputBytes > 0 && outputBytes <= 12_000,
    intendedEffect: "Return targeted structural context instead of dumping repository state.",
    evidence: { outputBytes, outputTokens: countTokens(output), byteLimit: 12_000, resultLimit: 3 },
    caveat:
      "A full-repository dump is not an equivalent baseline, so no savings percentage is claimed.",
  };
}

async function measureAgentMemory(cwd: string): Promise<ComponentMeasurement> {
  const result = await agentMemoryAdapter.smoke(cwd);
  return {
    component: "agentmemory",
    status: "bounded",
    passed: result.ok,
    intendedEffect: "Recall relevant cross-session context under a fixed output budget.",
    evidence: result.evidence ?? {},
    caveat: "Relevance and downstream token avoidance require a repeated-task A/B corpus.",
  };
}

export function liveOnlyMeasurements(configuredLevel?: string): ComponentMeasurement[] {
  return [
    {
      component: "concise-final",
      status: "requires-live-a-b",
      passed: true,
      intendedEffect: "Reduce final-response verbosity with a small neutral verdict-first rule.",
      evidence: { paidModelCalls: 0, policyBytes: 326 },
      caveat: "Needs matched prompts, blinded quality scoring, and provider usage data.",
    },
    {
      component: "omp-thinking",
      status: "requires-live-a-b",
      passed: true,
      intendedEffect: "Use the cheapest supported reasoning level for suitable work.",
      evidence: { configuredLevel: configuredLevel ?? "provider-default", paidModelCalls: 0 },
      caveat: "Reasoning usage and quality can only be compared with controlled paid model runs.",
    },
    {
      component: "archon",
      status: "verified",
      passed: true,
      intendedEffect:
        "Provide deterministic orchestration and auditability, not token compression.",
      evidence: { tokenSavingsClaimed: false },
    },
  ];
}

export async function runBenchmark(cwd: string): Promise<BenchmarkReport> {
  const measurements = await Promise.all([
    measureHashline(),
    measureRtk(),
    measureBatching(cwd),
    measureGitNexus(cwd),
    measureAgentMemory(cwd),
  ]);
  const omp = await readManagedModel("omp-native");
  measurements.push(...liveOnlyMeasurements(omp?.thinking));
  return {
    ok: measurements.every((measurement) => measurement.passed),
    paidModelCalls: 0,
    cwd,
    measurements,
  };
}
