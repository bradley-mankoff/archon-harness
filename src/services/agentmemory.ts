import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot, harnessRoot } from "../paths.ts";

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

export async function ensureAgentMemory(
  baseUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
): Promise<ServiceStatus> {
  if (await healthy(baseUrl)) return { ok: true, detail: `healthy at ${baseUrl}`, started: false };

  const serviceDir = join(dataRoot(), "services", "agentmemory");
  await mkdir(serviceDir, { recursive: true });
  const stdoutPath = join(serviceDir, "stdout.log");
  const stderrPath = join(serviceDir, "stderr.log");
  const executable = join(harnessRoot(), "node_modules", ".bin", "agentmemory");
  const child = Bun.spawn([executable, "--tools", "core"], {
    cwd: serviceDir,
    env: { ...process.env, CI: "1", AGENTMEMORY_URL: baseUrl },
    stdin: "ignore",
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  child.unref();
  await writeFile(join(serviceDir, "pid"), `${child.pid}\n`, "utf8");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await healthy(baseUrl)) {
      return { ok: true, detail: `started pid ${child.pid} at ${baseUrl}`, started: true };
    }
    if (child.exitCode !== null) {
      const stderr = await Bun.file(stderrPath).text();
      throw new Error(
        `agentmemory exited ${child.exitCode} before readiness: ${stderr.slice(-2_000)}`,
      );
    }
    await Bun.sleep(250);
  }

  child.kill("SIGTERM");
  throw new Error(
    `agentmemory did not become healthy within 30s; logs: ${stdoutPath}, ${stderrPath}`,
  );
}
