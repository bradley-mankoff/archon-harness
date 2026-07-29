#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = resolve(process.argv[2] || process.cwd());
const neutralRoot = await mkdtemp(join(tmpdir(), "archon-harness-pi-loader-"));
try {
  const loaded = await discoverAndLoadExtensions(
    [
      join(root, "node_modules", "pi-hashline-edit-pro", "index.ts"),
      join(root, "src", "extension", "pi.ts"),
    ],
    neutralRoot,
    join(neutralRoot, "agent"),
  );
  if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
  const tools = [...new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]))].sort();
  const expected = [
    "code_scout",
    "command_batch",
    "memory_search",
    "read",
    "replace",
    "undo_last_replace",
  ];
  if (JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error(`Pi extension tools differ: ${JSON.stringify(tools)}`);
  }
  process.stdout.write(`${JSON.stringify({ extensions: loaded.extensions.length, tools })}\n`);
} finally {
  await rm(neutralRoot, { recursive: true, force: true });
}
