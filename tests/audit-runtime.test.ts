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
import {
  buildArchonInvocation,
  executeArchonInvocation,
  printFinalResponse,
} from "../src/runtime.ts";

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
    const invocation = buildArchonInvocation("fix it", process.cwd(), "run-1", {
      model: "openai/gpt-test",
      thinking: "minimal",
    });
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
    expect(invocation.env.HARNESS_OMP_THINKING).toBe("minimal");
    expect(invocation.env.HARNESS_AUDIT_PATH).toEndWith("run-1.jsonl");
    expect(invocation.env.HARNESS_FINAL_RESPONSE).toBe(invocation.finalResponseFile);
    expect(invocation.env.HARNESS_OMP_LOG).toBe(invocation.ompStderrLog);
    expect(invocation.archonStdoutLog).toEndWith("run-1.archon-stdout.log");
    expect(invocation.archonStderrLog).toEndWith("run-1.archon-stderr.log");
  });

  test("surfaces the captured OMP final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-response-"));
    temporaryPaths.push(root);
    const response = join(root, "response.txt");
    await Bun.write(response, "Repository: news\nBranch: main\n");
    let output = "";
    await printFinalResponse(response, (value) => {
      output += value;
    });
    expect(output).toBe("Repository: news\nBranch: main\n");
  });

  test("captures orchestration noise and returns only the final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-captured-run-"));
    temporaryPaths.push(root);
    const invocation = {
      executable: "/bin/sh",
      args: [
        "-c",
        'printf "archon info\\n"; printf "archon warning\\n" >&2; printf "Working...\\n" > "$HARNESS_OMP_LOG"; printf "final answer\\n" > "$HARNESS_FINAL_RESPONSE"',
      ],
      cwd: root,
      env: {
        HARNESS_FINAL_RESPONSE: join(root, "response.txt"),
        HARNESS_OMP_LOG: join(root, "omp.log"),
      },
      auditFile: join(root, "audit.jsonl"),
      finalResponseFile: join(root, "response.txt"),
      archonStdoutLog: join(root, "archon.stdout.log"),
      archonStderrLog: join(root, "archon.stderr.log"),
      ompStderrLog: join(root, "omp.log"),
    };

    const result = await executeArchonInvocation(invocation);

    expect(result).toMatchObject({ exitCode: 0, response: "final answer" });
    expect(await readFile(invocation.archonStdoutLog, "utf8")).toBe("archon info\n");
    expect(await readFile(invocation.archonStderrLog, "utf8")).toBe("archon warning\n");
    expect(await readFile(invocation.ompStderrLog, "utf8")).toBe("Working...\n");
  });

  test("retains failure diagnostics without fabricating a response", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-failed-run-"));
    temporaryPaths.push(root);
    const invocation = {
      executable: "/bin/sh",
      args: ["-c", 'printf "failed detail\\n" >&2; exit 7'],
      cwd: root,
      env: {},
      auditFile: join(root, "audit.jsonl"),
      finalResponseFile: join(root, "response.txt"),
      archonStdoutLog: join(root, "archon.stdout.log"),
      archonStderrLog: join(root, "archon.stderr.log"),
      ompStderrLog: join(root, "omp.log"),
    };

    const result = await executeArchonInvocation(invocation);

    expect(result).toMatchObject({ exitCode: 7, logs: { stderr: invocation.archonStderrLog } });
    expect(result.response).toBeUndefined();
    expect(await readFile(invocation.archonStderrLog, "utf8")).toBe("failed detail\n");
  });
});
