import { describe, expect, test } from "bun:test";
import lock from "../../upstreams.lock.json";

describe("upstream compatibility lock", () => {
  test("contains every always-on source", () => {
    expect(Object.keys(lock.upstreams).sort()).toEqual([
      "agentmemory",
      "archon",
      "gitnexus",
      "omp",
      "rtk",
      "tura",
    ]);
  });

  test("keeps restricted licenses behind process or clean-room boundaries", () => {
    expect(lock.upstreams.tura.integration).toContain("clean-room");
    expect(lock.upstreams.gitnexus.integration).toContain("external CLI");
  });

  test("pins immutable commits", () => {
    for (const upstream of Object.values(lock.upstreams)) {
      expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
