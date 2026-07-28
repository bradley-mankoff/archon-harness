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

Successful `chat` runs print only OMP's final response. Archon orchestration output, its optional title fallback warning, and OMP progress are retained under `~/.local/share/archon-harness/logs/<run-id>.*.log`. A failed run prints one concise error with the Archon and OMP log paths. The title warning still exists inside Archon v0.6.0 because its embedded Pi catalog cannot resolve extension-provided models; it is diagnostic noise, not an OMP failure, and no longer reaches the user-facing terminal stream.

## Measure components

```bash
bun src/cli.ts benchmark --cwd /path/to/indexed/repo
```

The benchmark makes zero paid model calls. The harness-managed agentmemory daemon is forced into local synthetic/noop mode, binds its REST, stream, viewer, and engine surfaces to loopback, and receives a strict environment allowlist, so ambient provider keys and unrelated shell credentials never cross that process boundary. The report includes tokenizer-derived fixture savings for hashline and RTK, command-call reduction for batching, hard output budgets for GitNexus and agentmemory, and explicit `requires-live-a-b` results for Caveman response policy and OMP reasoning level. It does not collapse unlike mechanisms into one invented savings percentage. Archon is measured as an orchestration/audit boundary and makes no token-savings claim.

## Slack Socket Mode

The optional Slack bridge uses Socket Mode, so it needs no public HTTP endpoint. It accepts messages only from one configured Slack user in one configured DM or private channel and always runs against one canonical repository. Tokens remain environment-only and are never printed by `slack check`.

Create and install a workspace-approved Slack app manually, enable Socket Mode, and configure:

- app-level token with `connections:write` (`xapp-...`);
- bot token with `chat:write` and the history scope required by the selected surface (`im:history` for a DM or `groups:history` for a private channel);
- bot event subscription `message.im` or `message.groups`;
- invite the app to the private channel when using one.

Then set the local process environment:

```bash
export SLACK_APP_TOKEN='xapp-...'
export SLACK_BOT_TOKEN='xoxb-...'
export ARCHON_SLACK_USER_ID='U...'
export ARCHON_SLACK_CHANNEL_ID='D...' # or G... for a private channel
export ARCHON_SLACK_CWD='/absolute/path/to/personal/repo'

bun src/cli.ts slack check
bun src/cli.ts slack start
```

The bridge serializes requests through the same Archon/OMP path, replies in the originating thread, and writes bridge errors to `~/.local/share/archon-harness/logs/slack-bridge.log`. Do not use the GitNexus-backed bridge for employer work without a commercial GitNexus license, regardless of whether the employer permits personal Slack use.

## Verify

```bash
bun run check
bun src/cli.ts doctor
bun src/cli.ts smoke --cwd /path/to/indexed/repo
bun run test:e2e:no-model
```

`smoke` updates the local GitNexus index and starts or reuses the harness-managed local agentmemory service. It does not call a paid model. A real `chat` run does.

`test:e2e:no-model` runs the public `chat` command through the installed Archon DAG with isolated temporary Archon and OMP agent directories and substitutes `tests/fixtures/fake-omp.ts` through `HARNESS_OMP`. It retains the real home directory so GitNexus can load its installed LadybugDB extension. The fixture loads the real harness extension and exercises its lifecycle without making a model request; it is not used by normal `chat`. The test proves stdout contains only the final answer, stderr is empty, and Archon's title fallback plus OMP progress remain in run logs. Archon v0.6.0's title attempt fails during local model resolution before authentication or network dispatch.

## State and trust boundaries

- Harness runtime state: `~/.local/share/archon-harness/`
- OMP configuration: existing `~/.omp/agent/config.yml`, read-only
- Repository index: GitNexus-managed local state
- Memory: agentmemory-managed state under `~/.local/share/archon-harness/services/agentmemory`
- GitNexus is PolyForm Noncommercial. Do not use this integration commercially without an appropriate license.
- No upstream source is patched. Tura batching is independently implemented; restricted upstream code is not copied.
