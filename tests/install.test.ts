import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { installHarness, resolveModelSelection } from "../src/install.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("installer", () => {
  test("resolves the OMP default model without changing its config", () => {
    const content = "modelRoles:\n  default: openai/gpt-test:high\nextensions:\n  - /old.ts\n";
    expect(resolveModelSelection(content)).toEqual({ model: "openai/gpt-test", thinking: "high" });
    expect(resolveModelSelection(content, "anthropic/claude-test:xhigh")).toEqual({
      model: "anthropic/claude-test",
      thinking: "xhigh",
    });
    expect(resolveModelSelection("", "openai/gpt-test", "minimal")).toEqual({
      model: "openai/gpt-test",
      thinking: "minimal",
    });
  });

  test("validates model and thinking syntax before installation", () => {
    expect(() => resolveModelSelection("", "openai/gpt-test::xhigh")).toThrow(
      "empty model segment",
    );
    expect(resolveModelSelection("", "openrouter/arcee-ai/trinity-mini:free")).toEqual({
      model: "openrouter/arcee-ai/trinity-mini:free",
    });

    expect(
      resolveModelSelection("", "openrouter/anthropic/claude-3.7-sonnet:thinking:high"),
    ).toEqual({
      model: "openrouter/anthropic/claude-3.7-sonnet:thinking",
      thinking: "high",
    });

    expect(() => resolveModelSelection("", "openai/gpt-test:minimal", "off")).toThrow(
      "Conflicting thinking levels",
    );
  });

  test("installs Pi without a model rather than inheriting the OMP default", async () => {
    const root = await mkdtemp(join(tmpdir(), "archon-harness-install-"));
    temporaryPaths.push(root);
    const ompDir = join(root, "omp");
    await Bun.write(
      join(ompDir, "config.yml"),
      "modelRoles:\n  default: deepseek/deepseek-v4-pro:max\n",
    );
    const binary = join(root, "archon");
    await Bun.write(binary, "#!/bin/sh\necho 'Archon CLI v0.6.0'\n");
    await chmod(binary, 0o755);

    const result = await installHarness({
      paths: {
        root: process.cwd(),
        binary,
        archonHome: join(root, "home"),
        ompDir,
      },
    });

    expect(result.profiles).toEqual({
      "omp-native": { model: "deepseek/deepseek-v4-pro", thinking: "max" },
    });
    expect(parse(await readFile(join(root, "home", "config.yaml"), "utf8"))).toMatchObject({
      assistants: { pi: { model: "archon-harness/no-title" } },
    });
  });

  test("rejects an unconfigured Pi default profile", async () => {
    await expect(
      installHarness({
        ompModel: "deepseek/deepseek-v4-pro:high",
        defaultProfile: "pi-modular",
      }),
    ).rejects.toThrow("pi-modular default profile requires --pi-model");
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
      piModel: "openai/pi-test:off",
      forceDownload: true,
      fetch: fetchStub,
      paths: { root: process.cwd(), binary, archonHome, ompDir },
    });

    expect(result).toMatchObject({
      downloaded: true,
      defaultProfile: "omp-native",
      profiles: {
        "omp-native": { model: "openai/gpt-test", thinking: "xhigh" },
        "pi-modular": { model: "openai/pi-test", thinking: "off" },
      },
    });
    expect(await readFile(join(ompDir, "config.yml"), "utf8")).toBe(
      "modelRoles:\n  default: openai/gpt-test:xhigh\n",
    );
    expect(parse(await readFile(join(archonHome, "config.yaml"), "utf8"))).toMatchObject({
      defaultAssistant: "pi",
      assistants: { pi: { model: "openai/pi-test" } },
    });
    expect(parse(await readFile(join(archonHome, "harness.yaml"), "utf8"))).toEqual({
      defaultProfile: "omp-native",
      profiles: {
        "omp-native": { model: "openai/gpt-test", thinking: "xhigh" },
        "pi-modular": { model: "openai/pi-test", thinking: "off" },
      },
    });
    for (const name of ["archon-efficient", "archon-efficient-omp", "archon-efficient-pi"]) {
      expect(await Bun.file(join(archonHome, "workflows", `${name}.yaml`)).exists()).toBeTrue();
    }
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
