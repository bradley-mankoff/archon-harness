import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import type { CheckResult, HarnessAdapter } from "../contracts.ts";
import { processRunner } from "../process-runner.ts";

type ScoutKind = "query" | "context" | "impact";

export interface ScoutRequest {
  kind: ScoutKind;
  target: string;
  limit?: number;
}

const registrySchema = z.array(
  z.object({
    name: z.string().min(1),
    path: z.string().min(1),
  }),
);

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function gitNexusRegistryPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.GITNEXUS_HOME || join(homedir(), ".gitnexus"), "registry.json");
}

export class GitNexusAdapter implements HarnessAdapter {
  readonly name = "gitnexus";

  constructor(
    private readonly runner: Pick<typeof processRunner, "run"> = processRunner,
    private readonly registryPath = gitNexusRegistryPath(),
  ) {}

  async resolveRepository(cwd: string): Promise<string> {
    const registry = registrySchema.parse(JSON.parse(await readFile(this.registryPath, "utf8")));
    const canonicalCwd = await realpath(cwd);
    const matches = await Promise.all(
      registry.map(async (entry) => ({ ...entry, canonicalPath: await realpath(entry.path) })),
    );
    const selected = matches
      .filter((entry) => containsPath(entry.canonicalPath, canonicalCwd))
      .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
    if (!selected) {
      throw new Error(`GitNexus has no index registered for ${canonicalCwd}`);
    }
    const duplicateName = matches.some(
      (entry) => entry !== selected && entry.name.toLowerCase() === selected.name.toLowerCase(),
    );
    return duplicateName ? selected.canonicalPath : selected.name;
  }

  async ensureIndex(cwd: string): Promise<CheckResult> {
    const args = ["analyze", "--embeddings", "--skip-agents-md", "--index-only", cwd];
    const request = {
      executable: "gitnexus",
      args,
      cwd,
      env: { GITNEXUS_EMBEDDING_THREADS: "2" },
      timeoutMs: 180_000,
      maxOutputBytes: 30_000,
    };
    let result = await this.runner.run(request);
    let repairedFts = false;
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (
      result.exitCode !== 0 &&
      diagnostic.includes("FTS index '") &&
      diagnostic.includes("is inconsistent") &&
      diagnostic.includes("Drop and recreate the FTS index")
    ) {
      const repair = await this.runner.run({
        ...request,
        args: ["analyze", "--repair-fts", "--skip-agents-md", "--index-only", cwd],
      });
      if (repair.exitCode !== 0) {
        return {
          name: `${this.name}-index`,
          ok: false,
          detail: [repair.stdout, repair.stderr].filter(Boolean).join("\n").trim().slice(-2_000),
          evidence: {
            repairedFts: false,
            durationMs: result.durationMs + repair.durationMs,
            outputBytes: result.returnedBytes + repair.returnedBytes,
          },
        };
      }
      repairedFts = true;
      result = await this.runner.run(request);
    }
    return {
      name: `${this.name}-index`,
      ok: result.exitCode === 0,
      detail: [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(-2_000),
      evidence: { durationMs: result.durationMs, outputBytes: result.returnedBytes, repairedFts },
    };
  }

  async scout(request: ScoutRequest, cwd: string): Promise<string> {
    const limit = Math.min(Math.max(request.limit ?? 5, 1), 10);
    const repository = await this.resolveRepository(cwd);
    const args =
      request.kind === "query"
        ? ["query", request.target, "--repo", repository, "--limit", String(limit)]
        : request.kind === "context"
          ? ["context", request.target, "--repo", repository, "--limit", String(limit)]
          : [
              "impact",
              request.target,
              "--repo",
              repository,
              "--limit",
              String(limit),
              "--summary-only",
            ];
    const result = await this.runner.run({
      executable: "gitnexus",
      args,
      cwd,
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 12_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`GitNexus ${request.kind} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  async doctor(): Promise<CheckResult> {
    const result = await this.runner.run({
      executable: "gitnexus",
      args: ["--version"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      maxOutputBytes: 2_000,
    });
    return {
      name: this.name,
      ok: result.exitCode === 0 && result.stdout.trim() === "1.6.9",
      detail: result.stdout.trim() || result.stderr.trim(),
    };
  }

  async smoke(cwd: string): Promise<CheckResult> {
    const index = await this.ensureIndex(cwd);
    if (!index.ok) return index;
    const output = await this.scout(
      { kind: "query", target: "upstream compatibility", limit: 3 },
      cwd,
    );
    return {
      name: this.name,
      ok: output.length > 0 && Buffer.byteLength(output) <= 12_000,
      detail: `Structural query returned ${Buffer.byteLength(output)} bounded bytes.`,
      evidence: { boundedBytes: Buffer.byteLength(output), limitBytes: 12_000 },
    };
  }
}

export const gitNexusAdapter = new GitNexusAdapter();
