import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_EDIT_MODE } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { parse } from "yaml";
import { z } from "zod";

const workflowBoundarySchema = z.object({
  name: z.literal("archon-efficient"),
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

describe("OMP extension", () => {
  test("loads in the pinned OMP host and registers all optimized tools", async () => {
    const extensionPath = join(process.cwd(), "src", "extension", "index.ts");
    const loaded = await loadExtensions([extensionPath], process.cwd());

    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    expect(extension).toBeDefined();
    expect([...(extension?.tools.keys() ?? [])].sort()).toEqual([
      "code_scout",
      "command_batch",
      "memory_search",
    ]);
    expect([...(extension?.handlers.keys() ?? [])]).toEqual(
      expect.arrayContaining([
        "session_start",
        "before_agent_start",
        "tool_result",
        "session_shutdown",
      ]),
    );
    expect(DEFAULT_EDIT_MODE).toBe("hashline");
  });
});

describe("Archon workflow", () => {
  test("declares the Archon evidence boundary and launches direct OMP rather than embedded Pi", async () => {
    const content = await readFile(join(process.cwd(), "config", "archon-efficient.yaml"), "utf8");
    const workflow = workflowBoundarySchema.parse(parse(content));

    const agent = workflow.nodes.find((node) => node.id === "agent");
    expect(agent?.bash).toContain("$HARNESS_OMP");
    expect(agent?.bash).toContain('--extension "$HARNESS_EXTENSION"');
    expect(agent?.bash).toContain('--thinking "$HARNESS_OMP_THINKING"');
    expect(agent?.bash).toContain('> "$HARNESS_FINAL_RESPONSE"');
  });
});
