import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redactRecord } from "./redaction.ts";

export const harnessModules = [
  "archon",
  "batching",
  "omp",
  "hashline",
  "caveman",
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

export const requiredActivationEvents: Record<HarnessModule, string> = {
  archon: "workflow_preflight",
  batching: "dependency_steps_executed",
  omp: "extension_session_started",
  hashline: "extension_default_verified",
  caveman: "policy_injected",
  rtk: "rewrite_verified",
  gitnexus: "index_ready",
  agentmemory: "session_started",
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

export async function writeEvidence(auditFile: string, artifactsDir: string): Promise<string> {
  const entries = await readAudit(auditFile);
  const active = new Set(entries.map((entry) => `${entry.module}:${entry.event}`));
  const missing = harnessModules.filter(
    (module) => !active.has(`${module}:${requiredActivationEvents[module]}`),
  );
  if (missing.length > 0)
    throw new Error(
      `Harness activations missing from audit: ${missing
        .map((module) => `${module}:${requiredActivationEvents[module]}`)
        .join(", ")}`,
    );
  const evidencePath = join(artifactsDir, "evidence.json");
  const evidence = {
    valid: true,
    modules: harnessModules,
    activations: requiredActivationEvents,
    auditEntries: entries.length,
    auditFile,
  };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}
