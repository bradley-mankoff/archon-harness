import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import lock from "../upstreams.lock.json";
import { archonBinary, harnessRoot, managedArchonHome, ompAgentDir } from "./paths.ts";

const ompConfigSchema = z
  .object({
    modelRoles: z.object({ default: z.string().min(1).optional() }).optional(),
  })
  .passthrough();

export interface InstallPaths {
  root: string;
  binary: string;
  archonHome: string;
  ompDir: string;
}

export interface InstallResult {
  binary: string;
  archonHome: string;
  ompConfig: string;
  workflow: string;
  model: string;
  downloaded: boolean;
}

export interface InstallOptions {
  model?: string;
  forceDownload?: boolean;
  fetch?: typeof fetch;
  paths?: InstallPaths;
}

function defaultPaths(): InstallPaths {
  return {
    root: harnessRoot(),
    binary: archonBinary(),
    archonHome: managedArchonHome(),
    ompDir: ompAgentDir(),
  };
}

function modelWithoutEffort(model: string): string {
  return model.replace(/:(?:minimal|low|medium|high|xhigh)$/i, "");
}

async function readOmpConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function resolvePiModel(content: string, explicit?: string): string {
  if (explicit) return modelWithoutEffort(explicit);
  const configured = ompConfigSchema.parse(content ? parse(content) : {}).modelRoles?.default;
  if (!configured) {
    throw new Error(
      "No Pi model configured. Pass --model <provider/model> or set modelRoles.default in OMP config.",
    );
  }
  return modelWithoutEffort(configured);
}

function releaseAssetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (!new Set(["darwin", "linux"]).has(os) || !new Set(["arm64", "x64"]).has(arch)) {
    throw new Error(`Unsupported Archon binary platform: ${process.platform}/${process.arch}`);
  }
  return `archon-${os}-${arch}`;
}

function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (match?.[2] === asset) return match[1]?.toLowerCase() ?? "";
  }
  throw new Error(`Release checksums do not contain ${asset}`);
}

async function downloadArchon(binary: string, fetchFn: typeof fetch): Promise<void> {
  const version = lock.upstreams.archon.version;
  const asset = releaseAssetName();
  const base = `https://github.com/coleam00/Archon/releases/download/${version}`;
  const [checksumsResponse, binaryResponse] = await Promise.all([
    fetchFn(`${base}/checksums.txt`),
    fetchFn(`${base}/${asset}`),
  ]);
  if (!checksumsResponse.ok)
    throw new Error(`Archon checksums download: HTTP ${checksumsResponse.status}`);
  if (!binaryResponse.ok) throw new Error(`Archon binary download: HTTP ${binaryResponse.status}`);
  const expected = expectedChecksum(await checksumsResponse.text(), asset);
  const bytes = new Uint8Array(await binaryResponse.arrayBuffer());
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Archon checksum mismatch for ${asset}`);

  await mkdir(dirname(binary), { recursive: true });
  const temporary = `${binary}.tmp`;
  await writeFile(temporary, bytes);
  await chmod(temporary, 0o755);
  await rename(temporary, binary);
}

async function binaryInstalled(binary: string): Promise<boolean> {
  try {
    const child = Bun.spawn([binary, "version"], { stdout: "pipe", stderr: "pipe" });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 && output.includes(lock.upstreams.archon.version.replace(/^v/, ""));
  } catch {
    return false;
  }
}

export async function installHarness(options: InstallOptions = {}): Promise<InstallResult> {
  const paths = options.paths ?? defaultPaths();
  const ompConfigPath = join(paths.ompDir, "config.yml");
  const ompContent = await readOmpConfig(ompConfigPath);
  const model = resolvePiModel(ompContent, options.model ?? process.env.HARNESS_PI_MODEL);
  const workflowSource = join(paths.root, "config", "archon-efficient.yaml");
  const workflow = join(paths.archonHome, "workflows", "archon-efficient.yaml");

  let downloaded = false;
  if (options.forceDownload || !(await binaryInstalled(paths.binary))) {
    await downloadArchon(paths.binary, options.fetch ?? fetch);
    if (!(await binaryInstalled(paths.binary))) {
      throw new Error(`Downloaded Archon binary failed its version check: ${paths.binary}`);
    }
    downloaded = true;
  }

  await mkdir(dirname(workflow), { recursive: true });
  await copyFile(workflowSource, workflow);

  const config = {
    botName: "Archon Harness",
    defaultAssistant: "pi",
    assistants: {
      pi: {
        model,
        enableExtensions: true,
        interactive: false,
      },
    },
  };
  await mkdir(paths.archonHome, { recursive: true });
  const configPath = join(paths.archonHome, "config.yaml");
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, stringify(config), "utf8");
  await rename(temporary, configPath);
  await rm(`${paths.binary}.tmp`, { force: true });

  return {
    binary: paths.binary,
    archonHome: paths.archonHome,
    ompConfig: ompConfigPath,
    workflow,
    model,
    downloaded,
  };
}
