import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { installHarness, resolvePiModel } from "../src/install.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("installer", () => {
  test("resolves the OMP default model without changing its config", () => {
    const content = "modelRoles:\n  default: openai/gpt-test:high\nextensions:\n  - /old.ts\n";
    expect(resolvePiModel(content)).toEqual({ model: "openai/gpt-test", thinking: "high" });
    expect(resolvePiModel(content, "anthropic/claude-test:xhigh")).toEqual({
      model: "anthropic/claude-test",
      thinking: "xhigh",
    });
    expect(resolvePiModel("", "xai-oauth/grok-4.5", "minimal")).toEqual({
      model: "xai-oauth/grok-4.5",
      thinking: "minimal",
    });
  });

  test("validates model and thinking syntax before installation", () => {
    expect(() => resolvePiModel("", "xai-oauth/grok-4.5::xhigh")).toThrow("empty model segment");
    expect(resolvePiModel("", "openrouter/arcee-ai/trinity-mini:free")).toEqual({
      model: "openrouter/arcee-ai/trinity-mini:free",
    });
    expect(resolvePiModel("", "openrouter/anthropic/claude-3.7-sonnet:thinking:high")).toEqual({
      model: "openrouter/anthropic/claude-3.7-sonnet:thinking",
      thinking: "high",
    });
    expect(() => resolvePiModel("", "xai-oauth/grok-4.5:minimal", "off")).toThrow(
      "Conflicting thinking levels",
    );
  });

  test("verifies checksum and installs a runnable pinned Archon binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-install-"));
    temporaryPaths.push(root);
    const ompDir = join(root, "omp");
    const archonHome = join(root, "archon-home");
    const binary = join(root, "bin", "archon-test");
    await Bun.write(join(ompDir, "config.yml"), "modelRoles:\n  default: openai/gpt-test:xhigh\n");
    const executable = new TextEncoder().encode("#!/bin/sh\necho 'Archon CLI v0.6.0'\n");
    const hash = new Bun.CryptoHasher("sha256").update(executable).digest("hex");
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("checksums.txt")
        ? new Response(
            `${hash}  archon-${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}\n`,
          )
        : new Response(executable);
    }) as typeof fetch;

    const result = await installHarness({
      forceDownload: true,
      fetch: fetchStub,
      paths: { root: process.cwd(), binary, archonHome, ompDir },
    });

    expect(result).toMatchObject({
      downloaded: true,
      model: "openai/gpt-test",
      thinking: "xhigh",
    });
    expect(await readFile(join(ompDir, "config.yml"), "utf8")).toBe(
      "modelRoles:\n  default: openai/gpt-test:xhigh\n",
    );
    expect(parse(await readFile(join(archonHome, "config.yaml"), "utf8"))).toMatchObject({
      defaultAssistant: "pi",
      assistants: { pi: { model: "openai/gpt-test" } },
    });
    expect(parse(await readFile(join(archonHome, "harness.yaml"), "utf8"))).toEqual({
      omp: { model: "openai/gpt-test", thinking: "xhigh" },
    });
    expect(
      await Bun.file(join(archonHome, "workflows", "archon-efficient.yaml")).exists(),
    ).toBeTrue();
  });

  test("rejects a checksum mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-install-"));
    temporaryPaths.push(root);
    const ompDir = join(root, "omp");
    await Bun.write(join(ompDir, "config.yml"), "modelRoles:\n  default: openai/gpt-test\n");
    const fetchStub = (async (input: string | URL | Request) =>
      String(input).endsWith("checksums.txt")
        ? new Response(
            `${"0".repeat(64)}  archon-${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}\n`,
          )
        : new Response("bad")) as typeof fetch;

    await expect(
      installHarness({
        forceDownload: true,
        fetch: fetchStub,
        paths: {
          root: process.cwd(),
          binary: join(root, "archon"),
          archonHome: join(root, "home"),
          ompDir,
        },
      }),
    ).rejects.toThrow("checksum mismatch");
  });
});
