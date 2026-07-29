import { mkdir, open, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { archonBinary, dataRoot, harnessRoot, managedArchonHome } from "./paths.ts";
import { profileModelEnvironment, type ManagedProfiles } from "./profile.ts";
import { readManagedProfiles } from "./runtime.ts";
import { injectWorkflowBadges, workflowBadgeScript } from "./ui-badges.ts";

export interface UiInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  url: string;
  backendUrl: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface UiProxy {
  url: string;
  stop: () => Promise<void>;
}

interface ReadinessOptions {
  timeoutMs: number;
  intervalMs: number;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  exited: () => boolean;
}

function passthroughEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (source[key]) environment[key] = source[key];
  }
  return environment;
}

export function buildUiInvocation(
  port: number,
  profiles: ManagedProfiles,
  backendPort: number,
  source: NodeJS.ProcessEnv = process.env,
): UiInvocation {
  for (const [name, value] of [
    ["UI", port],
    ["backend", backendPort],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`${name} port must be an integer between 1 and 65535, got: ${value}`);
    }
  }
  if (port === backendPort) throw new Error("UI and backend ports must differ");
  const root = harnessRoot();
  const runtimeDir = join(dataRoot(), "ui-runtime");
  const omp = profiles.profiles["omp-native"];
  const pi = profiles.profiles["pi-modular"];
  const ompEnvironment = profileModelEnvironment["omp-native"];
  const piEnvironment = profileModelEnvironment["pi-modular"];
  return {
    executable: archonBinary(),
    args: ["serve", "--port", String(backendPort)],
    cwd: runtimeDir,
    env: {
      ...passthroughEnvironment(source),
      ARCHON_HOME: managedArchonHome(),
      ARCHON_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      HOST: "127.0.0.1",
      CLAUDE_USE_GLOBAL_AUTH: "true",
      HARNESS_ROOT: root,
      HARNESS_BUN: process.execPath,
      ...(source.HARNESS_OMP ? { HARNESS_OMP: source.HARNESS_OMP } : {}),
      HARNESS_PI: source.HARNESS_PI || join(root, "node_modules", ".bin", "pi"),
      [ompEnvironment.model]: omp.model,
      ...(pi ? { [piEnvironment.model]: pi.model } : {}),
      AGENTMEMORY_URL: source.AGENTMEMORY_URL || "http://127.0.0.1:3111",
      ...(omp.thinking ? { [ompEnvironment.thinking]: omp.thinking } : {}),
      ...(pi?.thinking ? { [piEnvironment.thinking]: pi.thinking } : {}),
    },
    url: `http://127.0.0.1:${port}`,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    stdoutLog: join(dataRoot(), "logs", "ui-server.stdout.log"),
    stderrLog: join(dataRoot(), "logs", "ui-server.stderr.log"),
  };
}

export async function waitForUiReadiness(
  url: string,
  options: Partial<ReadinessOptions> & Pick<ReadinessOptions, "exited">,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const fetchFn = options.fetch ?? fetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.exited()) throw new Error("Archon Web exited before readiness");
    try {
      const response = await fetchFn(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The listener may not exist yet.
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Archon Web did not become healthy within ${timeoutMs}ms`);
}

export async function findAvailableLoopbackPort(excludedPort?: number): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("Could not allocate a loopback port"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePort(address.port)));
      });
    });
    if (port !== excludedPort) return port;
  }
}

function proxyHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of ["connection", "content-length", "host", "transfer-encoding"]) {
    copy.delete(name);
  }
  return copy;
}

function loopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function startUiProxy(port: number, backendUrl: string): UiProxy {
  const backend = new URL(backendUrl);
  if (!loopbackAddress(backend.hostname)) {
    throw new Error(`Archon Web backend must be loopback-only, got: ${backend.hostname}`);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request, bunServer) {
      const peer = bunServer.requestIP(request);
      if (peer && !loopbackAddress(peer.address)) return new Response("Forbidden", { status: 403 });
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === "/__archon-harness-badges.js") {
        return new Response(workflowBadgeScript(), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8",
          },
        });
      }
      const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, backend);
      const response = await fetch(target, {
        method: request.method,
        headers: proxyHeaders(request.headers),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      const headers = proxyHeaders(response.headers);
      if (headers.get("content-type")?.includes("text/html")) {
        headers.delete("content-encoding");
        return new Response(injectWorkflowBadges(await response.text()), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

export function uiDotenvPaths(invocation: UiInvocation): string[] {
  return [join(managedArchonHome(), ".env"), join(invocation.cwd, ".archon", ".env")];
}

async function assertNeutralEnvironment(invocation: UiInvocation): Promise<void> {
  const candidates = uiDotenvPaths(invocation);
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      throw new Error(`Refusing to start Archon Web with an overriding dotenv file: ${candidate}`);
    }
  }
}

async function logTail(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).slice(-2_000).trim();
  } catch {
    return "unavailable";
  }
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = Bun.spawn([command, url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
}

export async function runUi(port = 3090, shouldOpen = true): Promise<number> {
  const backendPort = await findAvailableLoopbackPort(port);
  const invocation = buildUiInvocation(port, await readManagedProfiles(), backendPort);
  await assertNeutralEnvironment(invocation);
  await Promise.all([
    mkdir(invocation.cwd, { recursive: true }),
    mkdir(join(dataRoot(), "logs"), { recursive: true }),
  ]);
  const [stdoutLog, stderrLog] = await Promise.all([
    open(invocation.stdoutLog, "w"),
    open(invocation.stderrLog, "w"),
  ]);
  const child = Bun.spawn([invocation.executable, ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: "ignore",
    stdout: stdoutLog.fd,
    stderr: stderrLog.fd,
  });
  let proxy: UiProxy | undefined;
  const stop = (): void => {
    void proxy?.stop();
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    try {
      await waitForUiReadiness(invocation.backendUrl, { exited: () => child.exitCode !== null });
      proxy = startUiProxy(port, invocation.backendUrl);
    } catch (error) {
      child.kill("SIGTERM");
      await child.exited;
      const detail = await logTail(invocation.stderrLog);
      throw new Error(`${String(error)}. Server log: ${invocation.stderrLog}\n${detail}`);
    }
    process.stdout.write(`Archon Web: ${invocation.url}\nPress Ctrl-C to stop.\n`);
    if (shouldOpen) await openBrowser(invocation.url);
    return await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await proxy?.stop();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    await Promise.all([stdoutLog.close(), stderrLog.close()]);
  }
}
