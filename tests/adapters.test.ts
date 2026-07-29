import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRequest, ProcessResult } from "../src/contracts.ts";
import { AgentMemoryAdapter } from "../src/adapters/agentmemory.ts";
import { GitNexusAdapter, gitNexusRegistryPath } from "../src/adapters/gitnexus.ts";
import { RtkAdapter } from "../src/adapters/rtk.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function processResult(stdout: string, exitCode = 0): ProcessResult {
  return {
    stdout,
    stderr: "",
    exitCode,
    durationMs: 1,
    timedOut: false,
    truncated: false,
    rawBytes: Buffer.byteLength(stdout),
    returnedBytes: Buffer.byteLength(stdout),
  };
}

describe("RTK adapter", () => {
  test("accepts RTK rewrite exit code 3 and never double-wraps", async () => {
    const calls: ProcessRequest[] = [];
    const adapter = new RtkAdapter({
      async run(request: ProcessRequest) {
        calls.push(request);
        return processResult("rtk git status\n", 3);
      },
    });

    expect(await adapter.rewrite("git status", process.cwd())).toEqual({
      command: "rtk git status",
      rewritten: true,
    });
    expect(await adapter.rewrite("rtk git status", process.cwd())).toEqual({
      command: "rtk git status",
      rewritten: false,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("agentmemory adapter", () => {
  test("doctor checks the installed binary without requiring a running daemon", async () => {
    let fetched = false;
    const adapter = new AgentMemoryAdapter(
      "http://127.0.0.1:1",
      (async () => {
        fetched = true;
        throw new Error("doctor must not probe the service");
      }) as unknown as typeof fetch,
      {
        async run() {
          return processResult("0.9.28\n");
        },
      },
    );

    expect(await adapter.doctor()).toEqual({ name: "agentmemory", ok: true, detail: "0.9.28" });
    expect(fetched).toBeFalse();
  });

  test("accepts a compact search hit identified by the smoke session", async () => {
    let sessionId = "";
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith("/session/start")) {
        sessionId = body.sessionId;
        return Response.json({ session: { id: sessionId, status: "active" }, context: "" });
      }
      if (path.endsWith("/smart-search")) {
        return Response.json({
          lessons: [],
          mode: "compact",
          results: [{ obsId: "obs-1", sessionId, score: 0.5 }],
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const adapter = new AgentMemoryAdapter("http://agentmemory.test", fetchStub);

    expect(await adapter.smoke(process.cwd())).toMatchObject({
      name: "agentmemory",
      ok: true,
    });
  });
});

describe("GitNexus adapter", () => {
  test("honors the supported isolated GitNexus home", () => {
    expect(gitNexusRegistryPath({ GITNEXUS_HOME: "/tmp/isolated-gitnexus" })).toBe(
      join("/tmp/isolated-gitnexus", "registry.json"),
    );
  });

  test("uses a canonical path when duplicate aliases would be ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-gitnexus-"));
    temporaryPaths.push(root);
    const repoA = join(root, "a");
    const repoB = join(root, "b");
    const nested = join(repoA, "src");
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(repoB, { recursive: true })]);
    const registry = join(root, "registry.json");
    await writeFile(
      registry,
      JSON.stringify([
        { name: "shared", path: repoA },
        { name: "shared", path: repoB },
      ]),
    );
    const calls: ProcessRequest[] = [];
    const adapter = new GitNexusAdapter(
      {
        async run(request: ProcessRequest) {
          calls.push(request);
          return processResult("bounded result");
        },
      },
      registry,
    );

    const canonicalRepoA = await realpath(repoA);
    expect(await adapter.resolveRepository(nested)).toBe(canonicalRepoA);
    await adapter.scout({ kind: "query", target: "owner", limit: 3 }, nested);
    expect(calls[0]?.args).toEqual(["query", "owner", "--repo", canonicalRepoA, "--limit", "3"]);
  });

  test("repairs an explicitly inconsistent FTS index and retries analysis once", async () => {
    const calls: ProcessRequest[] = [];
    const responses = [
      {
        ...processResult("", 1),
        stderr:
          "FTS index 'file_fts' is inconsistent: document is missing. Drop and recreate the FTS index.",
      },
      processResult("FTS repair complete"),
      processResult("Analysis complete"),
    ];
    const adapter = new GitNexusAdapter({
      async run(request: ProcessRequest) {
        calls.push(request);
        const response = responses.shift();
        if (!response) throw new Error("unexpected GitNexus invocation");
        return response;
      },
    });

    expect(await adapter.ensureIndex(process.cwd())).toMatchObject({
      ok: true,
      evidence: { repairedFts: true },
    });
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["analyze", "--embeddings"],
      ["analyze", "--repair-fts"],
      ["analyze", "--embeddings"],
    ]);
  });

  test("does not retry unrelated analysis failures", async () => {
    const calls: ProcessRequest[] = [];
    const adapter = new GitNexusAdapter({
      async run(request: ProcessRequest) {
        calls.push(request);
        return { ...processResult("", 1), stderr: "ordinary parse failure" };
      },
    });

    expect(await adapter.ensureIndex(process.cwd())).toMatchObject({
      ok: false,
      evidence: { repairedFts: false },
    });
    expect(calls).toHaveLength(1);
  });
});
