import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function harnessRoot(): string {
  return resolve(process.env.HARNESS_ROOT || sourceRoot);
}

export function dataRoot(): string {
  return resolve(
    process.env.ARCHON_HARNESS_DATA ||
      join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "archon-harness"),
  );
}

export function managedArchonHome(): string {
  return join(dataRoot(), "archon");
}

export function ompAgentDir(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"));
}

export function archonBinary(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return join(harnessRoot(), ".archon-harness", "bin", `archon-${platform}-${arch}`);
}

export function auditPath(runId: string): string {
  return join(dataRoot(), "audits", `${runId}.jsonl`);
}
