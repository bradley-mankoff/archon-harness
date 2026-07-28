import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordAudit,
  harnessModules,
  requiredActivationEvents,
  writeEvidence,
} from "../src/audit.ts";
import { buildArchonInvocation } from "../src/runtime.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("audit gate", () => {
  test("fails closed when any always-on module lacks activation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
    temporaryPaths.push(root);
    const audit = join(root, "audit.jsonl");
    await recordAudit("archon", "started", {}, audit);
    await expect(writeEvidence(audit, join(root, "artifacts"))).rejects.toThrow(
      "archon:workflow_preflight",
    );
  });

  test("rejects a module line that is not its required activation event", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
    temporaryPaths.push(root);
    const audit = join(root, "audit.jsonl");
    for (const module of harnessModules) {
      await recordAudit(
        module,
        module === "caveman" ? "policy_verified" : requiredActivationEvents[module],
        {},
        audit,
      );
    }
    await expect(writeEvidence(audit, join(root, "artifacts"))).rejects.toThrow(
      "caveman:policy_injected",
    );
  });

  test("writes evidence only after all modules activated and redacts secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
    temporaryPaths.push(root);
    const audit = join(root, "audit.jsonl");
    for (const module of harnessModules) {
      await recordAudit(
        module,
        requiredActivationEvents[module],
        {
          token: "ghp_abcdefghijklmnopqrstuvwxyz",
        },
        audit,
      );
    }
    const evidencePath = await writeEvidence(audit, join(root, "artifacts"));
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(evidence).toMatchObject({
      valid: true,
      modules: [...harnessModules],
      activations: requiredActivationEvents,
    });
    expect(await readFile(audit, "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("Archon invocation", () => {
  test("enters Archon first and supplies pinned direct OMP boundaries", () => {
    const invocation = buildArchonInvocation("fix it", process.cwd(), "run-1", "openai/gpt-test");
    expect(invocation.args).toEqual([
      "workflow",
      "run",
      "archon-efficient",
      "fix it",
      "--cwd",
      process.cwd(),
      "--no-worktree",
    ]);
    expect(invocation.env.HARNESS_OMP).toEndWith("node_modules/.bin/omp");
    expect(invocation.env.HARNESS_EXTENSION).toEndWith("src/extension/index.ts");
    expect(invocation.env.HARNESS_OMP_MODEL).toBe("openai/gpt-test");
    expect(invocation.env.HARNESS_AUDIT_PATH).toEndWith("run-1.jsonl");
  });
});
