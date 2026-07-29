import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildUiInvocation,
  findAvailableLoopbackPort,
  startUiProxy,
  uiDotenvPaths,
  waitForUiReadiness,
} from "../src/ui.ts";
import { injectWorkflowBadges, workflowBadgeScript } from "../src/ui-badges.ts";

const managedProfiles = {
  defaultProfile: "omp-native" as const,
  profiles: {
    "omp-native": { model: "deepseek/deepseek-v4-pro", thinking: "high" as const },
    "pi-modular": { model: "openai/gpt-5.2", thinking: "low" as const },
  },
};

describe("Archon Web launcher", () => {
  test("forces loopback and does not inherit credentials or platform adapters", () => {
    const invocation = buildUiInvocation(39090, managedProfiles, 39091, {
      HOME: "/Users/tester",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      ANTHROPIC_API_KEY: "secret-anthropic",
      DATABASE_URL: "postgres://secret",
      GITHUB_TOKEN: "secret-github",
      SLACK_APP_TOKEN: "secret-slack-app",
      SLACK_BOT_TOKEN: "secret-slack-bot",
      TELEGRAM_BOT_TOKEN: "secret-telegram",
    });

    expect(invocation.args).toEqual(["serve", "--port", "39091"]);
    expect(invocation.url).toBe("http://127.0.0.1:39090");
    expect(invocation.backendUrl).toBe("http://127.0.0.1:39091");
    expect(invocation.env).toMatchObject({
      HOST: "127.0.0.1",
      ARCHON_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      CLAUDE_USE_GLOBAL_AUTH: "true",
      HARNESS_OMP_PROFILE_MODEL: "deepseek/deepseek-v4-pro",
      HARNESS_OMP_PROFILE_THINKING: "high",
      HARNESS_PI_PROFILE_MODEL: "openai/gpt-5.2",
      HARNESS_PI_PROFILE_THINKING: "low",
    });
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.DATABASE_URL).toBeUndefined();
    expect(invocation.env.GITHUB_TOKEN).toBeUndefined();
    expect(invocation.env.SLACK_APP_TOKEN).toBeUndefined();
    expect(invocation.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(invocation.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(uiDotenvPaths(invocation)).toEqual([
      join(invocation.env.ARCHON_HOME as string, ".env"),
      join(invocation.cwd, ".archon", ".env"),
    ]);
  });

  test("does not invent a Pi model when that profile is unconfigured", () => {
    const invocation = buildUiInvocation(
      39090,
      {
        defaultProfile: "omp-native",
        profiles: {
          "omp-native": { model: "deepseek/deepseek-v4-pro", thinking: "high" },
        },
      },
      39091,
      {},
    );

    expect(invocation.env.HARNESS_PI_PROFILE_MODEL).toBeUndefined();
    expect(invocation.env.HARNESS_PI_PROFILE_THINKING).toBeUndefined();
  });

  test("waits for a healthy server with a bounded probe", async () => {
    let attempts = 0;
    await waitForUiReadiness("http://127.0.0.1:39090", {
      timeoutMs: 100,
      intervalMs: 1,
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not ready");
        return new Response('{"status":"ok"}', { status: 200 });
      },
      exited: () => false,
    });
    expect(attempts).toBe(3);
  });

  test("fails readiness when the child exits", async () => {
    await expect(
      waitForUiReadiness("http://127.0.0.1:39090", {
        timeoutMs: 100,
        intervalMs: 1,
        fetch: async () => new Response("unavailable", { status: 503 }),
        exited: () => true,
      }),
    ).rejects.toThrow("exited before readiness");
  });

  test("injects the badge adapter before Archon's module bundle", () => {
    const html = injectWorkflowBadges(
      '<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head></html>',
    );
    expect(html.indexOf("/__archon-harness-badges.js")).toBeLessThan(
      html.indexOf("/assets/index.js"),
    );
    expect(workflowBadgeScript()).toContain('workflow.name === "archon-efficient-pi"');
    expect(workflowBadgeScript()).toContain('providers.includes("claude")');
  });

  test("proxies Archon unchanged except for HTML presentation", async () => {
    const backendPort = await findAvailableLoopbackPort();
    const publicPort = await findAvailableLoopbackPort(backendPort);
    const backend = Bun.serve({
      hostname: "127.0.0.1",
      port: backendPort,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/workflows") {
          return Response.json({ workflows: [{ workflow: { name: "archon-efficient-pi" } }] });
        }
        return new Response("<html><head></head><body>Archon</body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const proxy = startUiProxy(publicPort, `http://127.0.0.1:${backendPort}`);
    try {
      const html = await fetch(proxy.url).then((response) => response.text());
      expect(html).toContain("/__archon-harness-badges.js");
      const script = await fetch(`${proxy.url}/__archon-harness-badges.js`);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect(await script.text()).toContain("archon-harness-workflow-badge");
      expect(await fetch(`${proxy.url}/api/workflows`).then((response) => response.json())).toEqual(
        {
          workflows: [{ workflow: { name: "archon-efficient-pi" } }],
        },
      );
    } finally {
      await proxy.stop();
      await backend.stop(true);
    }
  });
});
