import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { harnessRoot } from "../src/paths.ts";
import { managedAgentMemoryEnvironment } from "../src/services/agentmemory.ts";

describe("managed agentmemory service", () => {
  test("uses a strict synthetic-mode environment without ambient credentials", () => {
    const environment = managedAgentMemoryEnvironment("http://127.0.0.1:3111", {
      HOME: "/home/test",
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
      GEMINI_API_KEY: "must-not-pass",
      OPENAI_API_KEY: "must-not-pass",
      DATABASE_PASSWORD: "must-not-pass",
      AGENTMEMORY_SECRET: "memory-only-secret",
    });

    expect(environment).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
      CI: "1",
      AGENTMEMORY_URL: "http://127.0.0.1:3111",
      AGENTMEMORY_PROVIDER: "noop",
      AGENTMEMORY_AUTO_COMPRESS: "false",
      AGENTMEMORY_INJECT_CONTEXT: "false",
      AGENTMEMORY_ALLOW_AGENT_SDK: "false",
      AGENTMEMORY_REFLECT: "false",
      AGENTMEMORY_DROP_STALE_INDEX: "true",
      AGENTMEMORY_III_CONFIG: join(harnessRoot(), "config", "agentmemory-iii.yaml"),
      AGENTMEMORY_VIEWER_HOST: "127.0.0.1",
      CONSOLIDATION_ENABLED: "false",
      GRAPH_EXTRACTION_ENABLED: "false",
      EMBEDDING_PROVIDER: "local",
      III_REST_PORT: "3111",
      III_STREAMS_PORT: "3112",
      III_VIEWER_PORT: "3113",
      III_ENGINE_PORT: "49134",
      III_ENGINE_URL: "ws://127.0.0.1:49134",
      III_TELEMETRY_ENABLED: "false",
      AGENTMEMORY_SECRET: "memory-only-secret",
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-pass");
  });

  test("derives an isolated loopback port quartet", () => {
    expect(managedAgentMemoryEnvironment("http://127.0.0.1:3211", {})).toMatchObject({
      III_REST_PORT: "3211",
      III_STREAMS_PORT: "3212",
      III_VIEWER_PORT: "3213",
      III_ENGINE_PORT: "49234",
      III_ENGINE_URL: "ws://127.0.0.1:49234",
    });
  });

  test("pins every configured listener to loopback", async () => {
    const config = parse(
      await readFile(join(harnessRoot(), "config", "agentmemory-iii.yaml"), "utf8"),
    ) as { workers: Array<{ name: string; config?: Record<string, unknown> }> };
    const manager = config.workers.find((worker) => worker.name === "iii-worker-manager");
    const http = config.workers.find((worker) => worker.name === "iii-http");
    const stream = config.workers.find((worker) => worker.name === "iii-stream");

    expect(manager?.config).toMatchObject({
      host: "127.0.0.1",
      port: "$" + "{III_ENGINE_PORT:49134}",
    });
    expect(http?.config?.host).toBe("127.0.0.1");
    expect(stream?.config?.host).toBe("127.0.0.1");
    expect(config.workers.some((worker) => worker.name === "iii-exec")).toBe(false);
  });
});
