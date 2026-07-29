import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redactRecord } from "./redaction.ts";
import type { HarnessProfile } from "./profile.ts";

export const harnessModules = [
  "archon",
  "batching",
  "omp",
  "pi",
  "hashline",
  "concise",
  "rtk",
  "gitnexus",
  "agentmemory",
] as const;

const auditEntrySchema = z.object({
  timestamp: z.string(),
  module: z.enum(harnessModules),
  event: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

export type HarnessModule = (typeof harnessModules)[number];

export const requiredActivationEvents: Record<
  HarnessProfile,
  Partial<Record<HarnessModule, string>>
> = {
  "omp-native": {
    archon: "workflow_preflight",
    batching: "tool_registered",
    omp: "session_started",
    hashline: "runtime_verified",
    concise: "policy_injected",
    gitnexus: "context_injected",
  },
  "pi-modular": {
    archon: "workflow_preflight",
    batching: "tool_registered",
    pi: "session_started",
    hashline: "runtime_verified",
    concise: "policy_injected",
    rtk: "rewrite_verified",
    gitnexus: "context_injected",
    agentmemory: "session_started",
  },
};

export async function recordAudit(
  module: HarnessModule,
  event: string,
  evidence: Record<string, unknown> = {},
  path = process.env.HARNESS_AUDIT_PATH,
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const entry = auditEntrySchema.parse({
    timestamp: new Date().toISOString(),
    module,
    event,
    evidence: redactRecord(evidence),
  });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readAudit(path: string): Promise<z.infer<typeof auditEntrySchema>[]> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => auditEntrySchema.parse(JSON.parse(line)));
}

export async function writeEvidence(
  auditFile: string,
  artifactsDir: string,
  profile: HarnessProfile,
): Promise<string> {
  const entries = await readAudit(auditFile);
  const active = new Set(entries.map((entry) => `${entry.module}:${entry.event}`));
  const required = requiredActivationEvents[profile];
  const missing = Object.entries(required).filter(
    ([module, event]) => !active.has(`${module}:${event}`),
  );
  if (missing.length > 0)
    throw new Error(
      `Harness activations missing from audit: ${missing
        .map(([module, event]) => `${module}:${event}`)
        .join(", ")}`,
    );
  const evidencePath = join(artifactsDir, "evidence.json");
  const evidence = {
    valid: true,
    profile,
    modules: Object.keys(required),
    activations: required,
    auditEntries: entries.length,
    auditFile,
  };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}
