# Archon Efficient Harness

An Archon-owned coding workflow that runs OMP with native hashline edits, dependency-step command batching, RTK output reduction, bounded GitNexus scouting, agentmemory lifecycle capture, and a terse Caveman-derived output policy.

## Install

```bash
bun install --frozen-lockfile
bun run install:harness
```

The installer downloads and verifies the pinned Archon release, writes a dedicated Archon home under `~/.local/share/archon-harness/archon`, and installs the global `archon-efficient` workflow there. It reads OMP's default model but does not modify OMP auth, extensions, or settings. OMP 17.1.6 already defaults to hashline; the installer does not override `edit.mode`.

If OMP has no `modelRoles.default`, provide a model explicitly. Thinking is stored separately and passed to OMP's `--thinking` flag:

```bash
bun run install:harness -- --model xai-oauth/grok-4.5 --thinking minimal
```

The equivalent suffix form, `--model xai-oauth/grok-4.5:minimal`, is accepted. Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `auto`. Malformed or conflicting selectors fail before installation; literal colon-bearing model IDs remain valid. Archon receives the base `provider/model` for workflow metadata and title fallback; OMP receives the base model and thinking level independently.

On the verified OMP 17.1.6 installation, Grok 4.5 advertises levels from `minimal` through `xhigh`, not literal `off`. Use `minimal` for the cheapest supported Grok canary, and recheck with `omp models xai-oauth --json` after OMP catalog updates.

## Run

```bash
bun src/cli.ts chat --cwd /absolute/path/to/repo "Fix the failing tests"
```

Read-only Grok canary after installing with `--thinking minimal`:

```bash
bun src/cli.ts chat --cwd /absolute/path/to/repo \
  "Read-only canary. Report the repository name and current branch. Do not edit files or run tests."
```

Every run enters Archon first. The `archon-efficient` workflow performs deterministic preflight checks, launches this checkout's pinned OMP 17.1.6 binary with the extension explicitly loaded, and refuses completion unless the audit contains activation evidence for every always-on module. Archon's embedded Pi provider is intentionally not used: Archon v0.6.0 embeds Pi 0.80.6, whose edit tool predates hashline.

OMP's final response is captured by the workflow and printed after Archon completes. Archon may still fail to resolve extension-provided models for its optional title generation; that produces `title.generate_failed` followed by `title.fallback_set` and does not prevent OMP from using its authenticated provider.

## Verify

```bash
bun run check
bun src/cli.ts doctor
bun src/cli.ts smoke --cwd /path/to/indexed/repo
bun run test:e2e:no-model
```

`smoke` updates the local GitNexus index and starts or reuses the harness-managed local agentmemory service. It does not call a paid model. A real `chat` run does.

`test:e2e:no-model` runs the installed Archon DAG with isolated temporary Archon and OMP agent directories and substitutes `tests/fixtures/fake-omp.ts` through `HARNESS_OMP`. It retains the real home directory so GitNexus can load its installed LadybugDB extension. The fixture loads the real harness extension and exercises its lifecycle without making a model request; it is not used by `chat`. Archon v0.6.0 still attempts fire-and-forget AI title generation before each new workflow conversation and exposes no disable switch. The integration test configures a nonexistent provider and proves the attempt fails during local model resolution before authentication or network dispatch.

## State and trust boundaries

- Harness runtime state: `~/.local/share/archon-harness/`
- OMP configuration: existing `~/.omp/agent/config.yml`, read-only
- Repository index: GitNexus-managed local state
- Memory: agentmemory-managed state under `~/.local/share/archon-harness/services/agentmemory`
- GitNexus is PolyForm Noncommercial. Do not use this integration commercially without an appropriate license.
- No upstream source is patched. Tura batching is independently implemented; restricted upstream code is not copied.
