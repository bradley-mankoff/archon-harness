import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExtensions as loadOmpExtensions } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_EDIT_MODE } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { parse } from "yaml";
import { z } from "zod";

const workflowBoundarySchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.literal("pi"),
  evidence_policy: z.object({ required: z.literal(true) }),
  worktree: z.object({ enabled: z.literal(false) }),
  nodes: z.array(
    z.object({
      id: z.string(),
      bash: z.string(),
      depends_on: z.array(z.string()).optional(),
      timeout: z.number().optional(),
    }),
  ),
});

describe("runtime extensions", () => {
  test("OMP loads only shared batch and GitNexus additions over native tools", async () => {
    const loaded = await loadOmpExtensions(
      [join(process.cwd(), "src", "extension", "omp.ts")],
      process.cwd(),
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    expect([...(extension?.tools.keys() ?? [])].sort()).toEqual(["code_scout", "command_batch"]);
    expect([...(extension?.handlers.keys() ?? [])]).toEqual(
      expect.arrayContaining(["session_start", "before_agent_start"]),
    );
    expect(DEFAULT_EDIT_MODE).toBe("hashline");
  });

  test("Pi loads strict hashline and modular harness tools without ambient extensions", async () => {
    const child = Bun.spawn(
      ["node", join(process.cwd(), "scripts", "verify-pi-extensions.mjs"), process.cwd()],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      extensions: 2,
      tools: [
        "code_scout",
        "command_batch",
        "memory_search",
        "read",
        "replace",
        "undo_last_replace",
      ],
    });
  });
});

describe("Archon profile workflows", () => {
  for (const [name, profile] of [
    ["archon-efficient", "omp-native"],
    ["archon-efficient-omp", "omp-native"],
    ["archon-efficient-pi", "pi-modular"],
  ] as const) {
    test(`${name} keeps Archon as the evidence-gated owner`, async () => {
      const content = await readFile(join(process.cwd(), "config", `${name}.yaml`), "utf8");
      const workflow = workflowBoundarySchema.parse(parse(content));
      expect(workflow.name).toBe(name);
      expect(workflow.description).toContain(profile === "omp-native" ? "OMP" : "Pi modular");

      const preflight = workflow.nodes.find((node) => node.id === "preflight");
      const agent = workflow.nodes.find((node) => node.id === "agent");
      const postflight = workflow.nodes.find((node) => node.id === "postflight");
      expect(preflight?.bash).toContain(`--profile ${profile}`);
      expect(agent?.bash).toContain(`--profile ${profile}`);
      expect(postflight?.bash).toContain(`--profile ${profile}`);
      expect(agent?.bash).toContain("internal agent");
      expect(agent?.bash).toContain("$ARTIFACTS_DIR");
      expect(postflight?.depends_on).toEqual(["agent"]);
    });
  }
});
