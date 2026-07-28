import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dataRoot, harnessRoot } from "../paths.ts";

const defaultBaseUrl = "http://127.0.0.1:3111";
const managedRuntimeVersion = 2;

interface ManagedRuntime {
  version: number;
  wrapperPid: number;
  enginePid: number;
  mode: "synthetic";
}

interface ProcessIdentity {
  command: string;
  cwd?: string;
  parentPid: number;
}

export interface ServiceStatus {
  ok: boolean;
  detail: string;
  started: boolean;
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/agentmemory/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function managedPorts(baseUrl: string): {
  rest: number;
  streams: number;
  viewer: number;
  engine: number;
} {
  const parsed = new URL(baseUrl);
  const rest = Number.parseInt(parsed.port || "3111", 10);
  if (!Number.isSafeInteger(rest) || rest < 1 || rest > 9_512) {
    throw new Error(`Unsupported agentmemory REST port: ${parsed.port || "3111"}`);
  }
  return { rest, streams: rest + 1, viewer: rest + 2, engine: rest + 46_023 };
}

export function managedAgentMemoryEnvironment(
  baseUrl: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ports = managedPorts(baseUrl);
  const environment: Record<string, string> = {
    CI: "1",
    AGENTMEMORY_URL: baseUrl,
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
    III_REST_PORT: String(ports.rest),
    III_STREAMS_PORT: String(ports.streams),
    III_VIEWER_PORT: String(ports.viewer),
    III_ENGINE_PORT: String(ports.engine),
    III_ENGINE_URL: `ws://127.0.0.1:${ports.engine}`,
    III_TELEMETRY_ENABLED: "false",
  };
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG"] as const) {
    if (source[key]) environment[key] = source[key];
  }
  if (source.AGENTMEMORY_SECRET) environment.AGENTMEMORY_SECRET = source.AGENTMEMORY_SECRET;
  return environment;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const probe = Bun.spawn(["ps", "-p", String(pid), "-o", "ppid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [command, exitCode] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  const match = command.trim().match(/^(\d+)\s+(.+)$/s);
  const parentPid = match?.[1];
  const processCommand = match?.[2];
  if (exitCode !== 0 || !parentPid || !processCommand) return undefined;
  const cwdProbe = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [cwdOutput] = await Promise.all([new Response(cwdProbe.stdout).text(), cwdProbe.exited]);
  return {
    command: processCommand,
    parentPid: Number.parseInt(parentPid, 10),
    cwd: cwdOutput
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1),
  };
}

async function directChildPids(pid: number): Promise<number[]> {
  const probe = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  return stdout
    .split("\n")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function managedEngineIdentity(
  pid: number,
  serviceDir: string,
): Promise<ProcessIdentity | undefined> {
  const identity = await processIdentity(pid);
  const canonicalServiceDir = await realpath(serviceDir);
  return basename(identity?.command.split(/\s+/, 1)[0] ?? "") === "iii" &&
    identity?.cwd === canonicalServiceDir
    ? identity
    : undefined;
}

async function currentManagedRuntime(
  serviceDir: string,
  executable: string,
  expectedWrapperPid?: number,
): Promise<ManagedRuntime | undefined> {
  const runtimePath = join(serviceDir, "runtime.json");
  const parsed = await readJson(runtimePath);
  let wrapperPid: number | undefined;
  let enginePid: number | undefined;
  let version = 0;
  let engineRecorded = false;
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    version = typeof record.version === "number" ? record.version : 0;
    wrapperPid =
      typeof record.wrapperPid === "number"
        ? record.wrapperPid
        : typeof record.pid === "number"
          ? record.pid
          : undefined;
    engineRecorded = typeof record.enginePid === "number";
    enginePid = engineRecorded ? (record.enginePid as number) : undefined;
  }
  wrapperPid = expectedWrapperPid ?? wrapperPid ?? (await readPid(join(serviceDir, "pid")));
  if (!wrapperPid) return undefined;
  const wrapper = await processIdentity(wrapperPid);
  if (wrapper && !wrapper.command.includes(executable)) return undefined;
  if (!wrapper && !(version >= managedRuntimeVersion && engineRecorded)) return undefined;

  enginePid ??= await readPid(join(homedir(), ".agentmemory", "iii.pid"));
  let engine = enginePid ? await managedEngineIdentity(enginePid, serviceDir) : undefined;
  if (!engine && wrapper) {
    for (const candidate of await directChildPids(wrapperPid)) {
      const identity = await managedEngineIdentity(candidate, serviceDir);
      if (identity) {
        enginePid = candidate;
        engine = identity;
        break;
      }
    }
  }
  if (!enginePid || !engine) return undefined;
  if (wrapper && engine.parentPid !== wrapperPid) return undefined;
  return { version, wrapperPid, enginePid, mode: "synthetic" };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processIdentity(pid))) return true;
    await Bun.sleep(100);
  }
  return !(await processIdentity(pid));
}

async function stopManagedService(
  runtime: ManagedRuntime,
  serviceDir: string,
  executable: string,
  baseUrl: string,
): Promise<void> {
  const child = Bun.spawn([executable, "stop", "--force"], {
    cwd: serviceDir,
    env: managedAgentMemoryEnvironment(baseUrl),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) {
    throw new Error(
      `agentmemory stop failed (${exitCode}): ${(stderr || stdout).trim().slice(-2_000)}`,
    );
  }
  const [wrapperStopped, engineStopped] = await Promise.all([
    waitForExit(runtime.wrapperPid, 5_000),
    waitForExit(runtime.enginePid, 5_000),
  ]);
  if (!wrapperStopped || !engineStopped || (await healthy(baseUrl))) {
    throw new Error(
      `agentmemory did not stop cleanly (wrapper=${wrapperStopped}, engine=${engineStopped})`,
    );
  }
}

export async function ensureAgentMemory(
  baseUrl = process.env.AGENTMEMORY_URL || defaultBaseUrl,
): Promise<ServiceStatus> {
  const serviceDir = join(dataRoot(), "services", "agentmemory");
  const runtimePath = join(serviceDir, "runtime.json");
  const executable = join(harnessRoot(), "node_modules", ".bin", "agentmemory");
  if (await healthy(baseUrl)) {
    if (baseUrl !== defaultBaseUrl) {
      return { ok: true, detail: `healthy external service at ${baseUrl}`, started: false };
    }
    const runtime = await currentManagedRuntime(serviceDir, executable);
    if (!runtime) {
      return { ok: true, detail: `healthy unowned service at ${baseUrl}`, started: false };
    }
    if (runtime.version === managedRuntimeVersion) {
      return { ok: true, detail: `healthy synthetic service at ${baseUrl}`, started: false };
    }
    await stopManagedService(runtime, serviceDir, executable, baseUrl);
  }

  await mkdir(serviceDir, { recursive: true });
  const stdoutPath = join(serviceDir, "stdout.log");
  const stderrPath = join(serviceDir, "stderr.log");
  await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, "", "utf8")]);
  const child = Bun.spawn([executable, "--tools", "core"], {
    cwd: serviceDir,
    env: managedAgentMemoryEnvironment(baseUrl),
    stdin: "ignore",
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  child.unref();
  await writeFile(join(serviceDir, "pid"), `${child.pid}\n`, "utf8");

  const deadline = Date.now() + 30_000;
  let launchedRuntime: ManagedRuntime | undefined;
  while (Date.now() < deadline) {
    const runtime = await currentManagedRuntime(serviceDir, executable, child.pid);
    if (runtime?.wrapperPid === child.pid) launchedRuntime = runtime;
    if (await healthy(baseUrl)) {
      if (launchedRuntime) {
        const current: ManagedRuntime = { ...launchedRuntime, version: managedRuntimeVersion };
        await writeFile(runtimePath, `${JSON.stringify(current)}\n`, "utf8");
        return { ok: true, detail: `started pid ${child.pid} at ${baseUrl}`, started: true };
      }
    }
    if (child.exitCode !== null) {
      const stderr = await readFile(stderrPath, "utf8");
      if (launchedRuntime) {
        await stopManagedService(launchedRuntime, serviceDir, executable, baseUrl);
      }
      throw new Error(
        `agentmemory exited ${child.exitCode} before readiness: ${stderr.slice(-2_000)}`,
      );
    }
    await Bun.sleep(250);
  }

  if (launchedRuntime) await stopManagedService(launchedRuntime, serviceDir, executable, baseUrl);
  else child.kill("SIGTERM");
  throw new Error(
    `agentmemory did not become healthy within 30s; logs: ${stdoutPath}, ${stderrPath}`,
  );
}
