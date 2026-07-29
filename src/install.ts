import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import lock from "../upstreams.lock.json";
import { applyThinkingOverride, parseModelSelection } from "./model.ts";
import { archonBinary, harnessRoot, managedArchonHome, ompAgentDir } from "./paths.ts";
import { harnessProfileSchema, type HarnessProfile, type ManagedProfiles } from "./profile.ts";

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
  workflows: string[];
  defaultProfile: HarnessProfile;
  profiles: ManagedProfiles["profiles"];
  runtimeConfig: string;
  downloaded: boolean;
}

export interface InstallOptions {
  model?: string;
  ompModel?: string;
  piModel?: string;
  thinking?: string;
  defaultProfile?: string;
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

async function readOmpConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function resolveModelSelection(content: string, explicit?: string, thinking?: string) {
  const configured = ompConfigSchema.parse(content ? parse(content) : {}).modelRoles?.default;
  const rawModel = explicit ?? configured;
  if (!rawModel) {
    throw new Error(
      "No model configured. Pass --model <provider/model> or set modelRoles.default in OMP config.",
    );
  }
  return applyThinkingOverride(parseModelSelection(rawModel), thinking);
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
  const sharedModel = options.model ?? process.env.HARNESS_MODEL;
  const piModel = options.piModel ?? sharedModel ?? process.env.HARNESS_PI_MODEL;
  const thinking = options.thinking ?? process.env.HARNESS_THINKING;
  const profiles: ManagedProfiles["profiles"] = {
    "omp-native": resolveModelSelection(
      ompContent,
      options.ompModel ?? sharedModel ?? process.env.HARNESS_OMP_MODEL,
      thinking,
    ),
    ...(piModel ? { "pi-modular": resolveModelSelection("", piModel, thinking) } : {}),
  };
  const defaultProfile = harnessProfileSchema.parse(options.defaultProfile ?? "omp-native");
  if (defaultProfile === "pi-modular" && !profiles["pi-modular"]) {
    throw new Error("The pi-modular default profile requires --pi-model <provider/model>");
  }
  const workflowNames = ["archon-efficient", "archon-efficient-omp", "archon-efficient-pi"];
  const workflows = workflowNames.map((name) =>
    join(paths.archonHome, "workflows", `${name}.yaml`),
  );
  const runtimeConfig = join(paths.archonHome, "harness.yaml");

  let downloaded = false;
  if (options.forceDownload || !(await binaryInstalled(paths.binary))) {
    await downloadArchon(paths.binary, options.fetch ?? fetch);
    if (!(await binaryInstalled(paths.binary))) {
      throw new Error(`Downloaded Archon binary failed its version check: ${paths.binary}`);
    }
    downloaded = true;
  }

  await mkdir(dirname(workflows[0] as string), { recursive: true });
  await Promise.all(
    workflowNames.map((name, index) =>
      copyFile(join(paths.root, "config", `${name}.yaml`), workflows[index] as string),
    ),
  );

  const config = {
    botName: "Archon Harness",
    defaultAssistant: "pi",
    assistants: {
      pi: {
        model: profiles["pi-modular"]?.model ?? "archon-harness/no-title",
        enableExtensions: true,
        interactive: false,
      },
    },
  };
  await mkdir(paths.archonHome, { recursive: true });
  const configPath = join(paths.archonHome, "config.yaml");
  const temporary = `${configPath}.tmp`;
  const runtimeTemporary = `${runtimeConfig}.tmp`;
  await writeFile(temporary, stringify(config), "utf8");
  await writeFile(runtimeTemporary, stringify({ defaultProfile, profiles }), "utf8");
  await rename(temporary, configPath);
  await rename(runtimeTemporary, runtimeConfig);
  await rm(`${paths.binary}.tmp`, { force: true });

  return {
    binary: paths.binary,
    archonHome: paths.archonHome,
    ompConfig: ompConfigPath,
    workflows,
    defaultProfile,
    profiles,
    runtimeConfig,
    downloaded,
  };
}
