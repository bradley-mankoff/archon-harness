import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAudit, requiredActivationEvents, writeEvidence } from "../src/audit.ts";
import type { HarnessProfile } from "../src/profile.ts";
import {
  type ArchonInvocation,
  buildArchonInvocation,
  buildProfileAgentInvocation,
  executeArchonInvocation,
} from "../src/runtime.ts";

const temporaryPaths: string[] = [];
const profiles: HarnessProfile[] = ["omp-native", "pi-modular"];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("profile audit gate", () => {
  for (const profile of profiles) {
    test(`${profile} fails closed when required activation evidence is absent`, async () => {
      const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
      temporaryPaths.push(root);
      const audit = join(root, "audit.jsonl");
      await recordAudit("archon", "started", {}, audit);
      await expect(writeEvidence(audit, join(root, "artifacts"), profile)).rejects.toThrow(
        "archon:workflow_preflight",
      );
    });

    test(`${profile} writes only its own module contract`, async () => {
      const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
      temporaryPaths.push(root);
      const audit = join(root, "audit.jsonl");
      const required = requiredActivationEvents[profile];
      for (const [module, event] of Object.entries(required)) {
        await recordAudit(
          module as keyof typeof required,
          event,
          { token: "ghp_abcdefghijklmnopqrstuvwxyz" },
          audit,
        );
      }
      const evidencePath = await writeEvidence(audit, join(root, "artifacts"), profile);
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      expect(evidence).toMatchObject({
        valid: true,
        profile,
        modules: Object.keys(required),
        activations: required,
      });
      expect(await readFile(audit, "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
      if (profile === "omp-native") {
        expect(evidence.modules).not.toContain("rtk");
        expect(evidence.modules).not.toContain("agentmemory");
        expect(evidence.modules).not.toContain("pi");
      } else {
        expect(evidence.modules).not.toContain("omp");
      }
    });
  }

  test("rejects a plausible but incorrect activation event", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-audit-"));
    temporaryPaths.push(root);
    const audit = join(root, "audit.jsonl");
    for (const [module, event] of Object.entries(requiredActivationEvents["omp-native"])) {
      await recordAudit(
        module as keyof (typeof requiredActivationEvents)["omp-native"],
        module === "concise" ? "policy_verified" : event,
        {},
        audit,
      );
    }
    await expect(writeEvidence(audit, join(root, "artifacts"), "omp-native")).rejects.toThrow(
      "concise:policy_injected",
    );
  });
});

describe("profile invocation", () => {
  test("selects distinct Archon workflows and model variables", () => {
    const omp = buildArchonInvocation("fix it", process.cwd(), "run-omp", "omp-native", {
      model: "openai/omp-test",
      thinking: "minimal",
    });
    const pi = buildArchonInvocation("fix it", process.cwd(), "run-pi", "pi-modular", {
      model: "openai/pi-test",
      thinking: "low",
    });
    expect(omp.args[2]).toBe("archon-efficient-omp");
    expect(pi.args[2]).toBe("archon-efficient-pi");
    expect(omp.env.HARNESS_OMP_PROFILE_MODEL).toBe("openai/omp-test");
    expect(omp.env.HARNESS_OMP_PROFILE_THINKING).toBe("minimal");
    expect(omp.env.HARNESS_PI_PROFILE_MODEL).toBeUndefined();
    expect(pi.env.HARNESS_PI_PROFILE_MODEL).toBe("openai/pi-test");
    expect(pi.env.HARNESS_PI_PROFILE_THINKING).toBe("low");
    expect(pi.env.HARNESS_OMP_PROFILE_MODEL).toBeUndefined();
    expect(omp.env.TITLE_GENERATION_MODEL).toBe("archon-harness/no-title");
    expect(omp.env.HARNESS_AGENT_LOG).toBe(omp.agentStderrLog);
  });

  test("isolates each agent runtime and its extensions", () => {
    const environment = {
      HARNESS_OMP: "/fake/omp",
      HARNESS_PI: "/fake/pi",
      HARNESS_OMP_PROFILE_MODEL: "openai/omp-test",
      HARNESS_PI_PROFILE_MODEL: "openai/pi-test",
    };
    const omp = buildProfileAgentInvocation(
      "omp-native",
      process.cwd(),
      "/tmp/artifacts",
      "probe",
      environment,
    );
    const pi = buildProfileAgentInvocation(
      "pi-modular",
      process.cwd(),
      "/tmp/artifacts",
      "probe",
      environment,
    );
    expect(omp.executable).toBe("/fake/omp");
    expect(omp.args).toContain("--no-rules");
    expect(omp.args.join(" ")).toContain("src/extension/omp.ts");
    expect(omp.args.join(" ")).not.toContain("pi-hashline-edit-pro");
    expect(omp.args).toContain("openai/omp-test");
    expect(pi.executable).toBe("/fake/pi");
    expect(pi.args).toContain("--offline");
    expect(pi.args).toContain("--no-context-files");
    expect(pi.args.join(" ")).toContain("pi-hashline-edit-pro/index.ts");
    expect(pi.args.join(" ")).toContain("src/extension/pi.ts");
    expect(pi.args.join(" ")).not.toContain("src/extension/omp.ts");
    expect(pi.args).toContain("openai/pi-test");
    expect(pi.args).not.toContain("--");
    expect(pi.args.at(-1)).toBe("probe");
    expect(pi.env.PI_PACKAGE_DIR).toEndWith("node_modules/@earendil-works/pi-coding-agent");
    expect(omp.env.PI_PACKAGE_DIR).toBeUndefined();
  });

  test("fails before launch when a profile model is absent", () => {
    expect(() =>
      buildProfileAgentInvocation("pi-modular", process.cwd(), "/tmp/artifacts", "probe", {
        HARNESS_PI: "/fake/pi",
      }),
    ).toThrow("No model configured for pi-modular");
  });

  test("uses the isolated SDK runner for production OMP", () => {
    const omp = buildProfileAgentInvocation(
      "omp-native",
      process.cwd(),
      "/tmp/artifacts",
      "probe",
      {
        HARNESS_BUN: "/fake/bun",
        HARNESS_OMP_PROFILE_MODEL: "deepseek/deepseek-v4-pro",
        HARNESS_OMP_PROFILE_THINKING: "high",
      },
    );

    expect(omp.executable).toBe("/fake/bun");
    expect(omp.args[0]).toEndWith("src/omp-runner.ts");
    expect(omp.args).toContain("--max-time-ms");
    expect(omp.args).toContain("900000");
    expect(omp.args).toContain("deepseek/deepseek-v4-pro");
    expect(omp.args).toContain("high");
    expect(omp.args).not.toContain("--no-extensions");
  });
});

describe("captured Archon execution", () => {
  test("captures orchestration noise and returns only the final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-captured-run-"));
    temporaryPaths.push(root);
    const invocation: ArchonInvocation = {
      executable: "/bin/sh",
      args: [
        "-c",
        'printf "archon info\\n"; printf "archon warning\\n" >&2; printf "Working...\\n" > "$HARNESS_AGENT_LOG"; printf "final answer\\n" > "$HARNESS_FINAL_RESPONSE"',
      ],
      cwd: root,
      env: {
        HARNESS_FINAL_RESPONSE: join(root, "response.txt"),
        HARNESS_AGENT_LOG: join(root, "agent.log"),
      },
      profile: "omp-native",
      auditFile: join(root, "audit.jsonl"),
      finalResponseFile: join(root, "response.txt"),
      archonStdoutLog: join(root, "archon.stdout.log"),
      archonStderrLog: join(root, "archon.stderr.log"),
      agentStderrLog: join(root, "agent.log"),
    };

    const result = await executeArchonInvocation(invocation);

    expect(result).toMatchObject({ exitCode: 0, profile: "omp-native", response: "final answer" });
    expect(await readFile(invocation.archonStdoutLog, "utf8")).toBe("archon info\n");
    expect(await readFile(invocation.archonStderrLog, "utf8")).toBe("archon warning\n");
    expect(await readFile(invocation.agentStderrLog, "utf8")).toBe("Working...\n");
  });

  test("retains failure diagnostics without fabricating a response", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-failed-run-"));
    temporaryPaths.push(root);
    const invocation: ArchonInvocation = {
      executable: "/bin/sh",
      args: ["-c", 'printf "failed detail\\n" >&2; exit 7'],
      cwd: root,
      env: {},
      profile: "pi-modular",
      auditFile: join(root, "audit.jsonl"),
      finalResponseFile: join(root, "response.txt"),
      archonStdoutLog: join(root, "archon.stdout.log"),
      archonStderrLog: join(root, "archon.stderr.log"),
      agentStderrLog: join(root, "agent.log"),
    };

    const result = await executeArchonInvocation(invocation);

    expect(result).toMatchObject({ exitCode: 7, logs: { stderr: invocation.archonStderrLog } });
    expect(result.response).toBeUndefined();
    expect(await readFile(invocation.archonStderrLog, "utf8")).toBe("failed detail\n");
  });
});
