import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@oh-my-pi/hashline";

describe("hashline differential", () => {
  test("applies a snapshot-bound edit to the expected fixture", async () => {
    const before = await readFile(
      join(process.cwd(), "tests", "fixtures", "edit-before.ts"),
      "utf8",
    );
    const expected = await readFile(
      join(process.cwd(), "tests", "fixtures", "edit-after.ts"),
      "utf8",
    );
    const filesystem = new InMemoryFilesystem();
    const snapshots = new InMemorySnapshotStore();
    await filesystem.writeText("fixture.ts", before);
    const tag = snapshots.record("fixture.ts", before);
    const patch = Patch.parse(
      `[fixture.ts#${tag}]\nSWAP 2.=2:\n+  return \`new:\${value.trim()}\`;`,
    );

    await new Patcher({ fs: filesystem, snapshots }).apply(patch);

    expect(await filesystem.readText("fixture.ts")).toBe(expected);
  });
});
