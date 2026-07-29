import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { parseOmpRunnerArgs, runOmpNative } from "../src/omp-runner.ts";

describe("isolated OMP SDK runner", () => {
  test("parses the bounded single-shot invocation", () => {
    expect(
      parseOmpRunnerArgs([
        "--cwd",
        "/repo",
        "--config",
        "/config.yml",
        "--extension",
        "/extension.ts",
        "--max-time-ms",
        "900000",
        "--model",
        "deepseek/deepseek-v4-pro",
        "--thinking",
        "high",
        "--",
        "read only",
      ]),
    ).toEqual({
      cwd: "/repo",
      config: "/config.yml",
      extension: "/extension.ts",
      maxTimeMs: 900000,
      model: "deepseek/deepseek-v4-pro",
      thinking: "high",
      message: "read only",
    });
  });

  test("loads only the explicit harness extension without calling a provider", async () => {
    const extension = join(process.cwd(), "src", "extension", "omp.ts");
    let sessionOptions: CreateAgentSessionOptions | undefined;
    let printOptions: Parameters<typeof runPrintMode>[1] | undefined;
    const session = { dispose: async () => undefined } as unknown as AgentSession;

    await runOmpNative(
      {
        cwd: process.cwd(),
        config: join(process.cwd(), "config", "omp-native.yml"),
        extension,
        model: "deepseek/deepseek-v4-pro",
        thinking: "high",
        maxTimeMs: 900_000,
        message: "probe",
      },
      {
        now: () => 1_000,
        loadSettings: async () => ({ get: () => undefined }) as unknown as Settings,
        createSession: async (options) => {
          sessionOptions = options;
          return {
            session,
            extensionsResult: {
              extensions: [
                { resolvedPath: extension },
                { resolvedPath: "<inline-0>" },
                { resolvedPath: "<inline-1>" },
              ],
              errors: [],
            },
          } as unknown as Pick<CreateAgentSessionResult, "session" | "extensionsResult">;
        },
        print: (async (_session, options) => {
          printOptions = options;
        }) as typeof runPrintMode,
      },
    );

    expect(sessionOptions).toMatchObject({
      cwd: resolve(process.cwd()),
      modelPattern: "deepseek/deepseek-v4-pro",
      thinkingLevel: "high",
      deadline: 901_000,
      additionalExtensionPaths: [resolve(extension)],
      disableExtensionDiscovery: true,
      skills: [],
      rules: [],
      autoApprove: false,
    });
    expect(sessionOptions?.sessionManager?.getSessionFile()).toBeUndefined();
    expect(printOptions).toEqual({ mode: "text", initialMessage: "probe" });
  });

  test("rejects any additional source-backed extension", async () => {
    const extension = join(process.cwd(), "src", "extension", "omp.ts");
    const session = { dispose: async () => undefined } as unknown as AgentSession;

    await expect(
      runOmpNative(
        {
          cwd: process.cwd(),
          config: join(process.cwd(), "config", "omp-native.yml"),
          extension,
          maxTimeMs: 900_000,
          message: "probe",
        },
        {
          now: () => 1_000,
          loadSettings: async () => ({ get: () => undefined }) as unknown as Settings,
          createSession: async () =>
            ({
              session,
              extensionsResult: {
                extensions: [
                  { resolvedPath: extension },
                  { resolvedPath: "/ambient/extension.ts" },
                ],
                errors: [],
              },
            }) as unknown as Pick<CreateAgentSessionResult, "session" | "extensionsResult">,
          print: (async () => undefined) as typeof runPrintMode,
        },
      ),
    ).rejects.toThrow("OMP extension isolation failed");
  });
});
