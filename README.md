# Archon Efficient Harness

An Archon-owned comparison harness with two isolated coding profiles: pinned OMP with native hashline, and official Pi with strict hashline, RTK, and agentmemory. Both use dependency-step batching, bounded GitNexus scouting, and the same concise final-response policy.

## Install

```bash
bun install --frozen-lockfile
bun run install:harness -- --omp-model deepseek/deepseek-v4-pro:high
```

The installer downloads and verifies pinned Archon, writes a dedicated Archon home under `~/.local/share/archon-harness/archon`, and installs `archon-efficient-omp`, `archon-efficient-pi`, plus the OMP-compatible `archon-efficient` alias. It reads OMP's default model but does not modify OMP auth, extensions, or settings. OMP 17.1.6 already defaults to hashline; the installer does not override `edit.mode`.

The installer may use OMP's configured default for `omp-native`, but it deliberately refuses to copy
that default into `pi-modular`. OMP 17.1.6 exposes `deepseek/deepseek-v4-pro`; official Pi 0.82.1 does
not. The Pi harness and its extensions are still installed and covered by the model-free lifecycle test.
To run real Pi inference, choose a model from `pi --list-models` and reinstall with both selectors:

```bash
bun run install:harness -- \
  --omp-model deepseek/deepseek-v4-pro:high \
  --pi-model provider/model:thinking
```

Use `--model` only after confirming that both runtime catalogs expose the same selector. Thinking can be
given as the model suffix or with `--thinking`; valid levels are `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`, and `auto`. Malformed or conflicting selectors fail before installation. The
managed manifest stores each configured profile's base model and thinking level independently.

On the verified OMP catalog, DeepSeek V4 Pro accepts `high` and `max`, not `off` or `minimal`. Recheck
with `omp models deepseek --json` after catalog updates. CLI selection of an unconfigured `pi-modular`
profile fails before Archon starts; a browser workflow fails before Pi starts. Neither path uses an
ambient provider default.

## Run

```bash
bun src/cli.ts chat --cwd /absolute/path/to/repo "Fix the failing tests"
# Only after installing an explicit Pi model:
bun src/cli.ts chat --profile pi-modular --cwd /absolute/path/to/repo "Fix the failing tests"
```

Read-only canaries after installation:

```bash
bun src/cli.ts chat --cwd /absolute/path/to/repo \
  "Read-only canary. Report the repository name and current branch. Do not edit files or run tests."
```

Every run enters Archon first and refuses completion unless its profile-specific audit is complete. `omp-native` launches pinned OMP 17.1.6 with native hashline, batching without RTK, GitNexus, and no agentmemory. `pi-modular` launches official Pi 0.82.1 with `pi-hashline-edit-pro`, RTK-backed batching, GitNexus, and agentmemory. Neither profile uses Archon's embedded Pi model loop.

Successful `chat` runs print only the selected agent's final response. Archon orchestration output, title fallback diagnostics, and agent progress remain under `~/.local/share/archon-harness/logs/<run-id>.*.log`. A failed run prints one concise error with the Archon and agent log paths.

## Browser UI

```bash
bun run ui
```

This starts a loopback-only presentation proxy at `http://127.0.0.1:3090`, starts pinned Archon Web on a private ephemeral loopback port, and opens the public URL. Use
`bun run ui -- --no-open` to leave the browser closed, or add `--port 39090` to choose another local
port. Keep the terminal open; `Ctrl-C` shuts down the server. The launcher uses a credential-minimal
environment, exports only configured profile model selections, disables Archon telemetry, rejects Archon-owned dotenv files that could override that
environment, verifies health before opening the browser, and never starts Slack, Telegram, or GitHub
adapters. Server logs are under `~/.local/share/archon-harness/logs/ui-server.*.log`.

The picker preserves Archon's workflow API and IDs, then adds presentation-only badges: `OMP harness`,
`Pi modular`, `Claude required`, or `Inherited provider`. Use `archon-efficient-omp` for native OMP
without RTK or memory, and `archon-efficient-pi` for the modular Pi stack with both. The
`archon-efficient` alias remains OMP-native for compatibility. Browser runs derive audit, response,
and agent-log paths from Archon's unique run artifact directory, so parallel runs do not collide.

Archon Web supports multiple registered repositories, parallel background runs, live DAG/tool
progress, conversation rename, and soft deletion. Archon v0.6.0 exposes neither a separate archive
operation nor a hard-purge conversation API; those two lifecycle features remain honest upstream
gaps. The UI comparison and integration rationale are in [`docs/ui-options.md`](docs/ui-options.md).

This repository runs **OMP**, a coding-focused fork of Pi, rather than stock Pi. OMP 17.1.6 ships
hashline as its native default edit mode. Stock Pi can add hashline behavior through third-party Pi
packages, but does not ship OMP's native implementation.

## Measure components

```bash
bun src/cli.ts benchmark --cwd /path/to/indexed/repo
```

The benchmark makes zero paid model calls. The harness-managed agentmemory daemon is forced into local synthetic/noop mode, binds its REST, stream, viewer, and engine surfaces to loopback, and receives a strict environment allowlist, so ambient provider keys and unrelated shell credentials never cross that process boundary. The report includes tokenizer-derived fixture savings for hashline and RTK, command-call reduction for batching, hard output budgets for GitNexus and agentmemory, and explicit `requires-live-a-b` results for the concise final-response policy and reasoning levels. It does not collapse unlike mechanisms into one invented savings percentage. Archon is measured as an orchestration/audit boundary and makes no token-savings claim.

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
bun src/cli.ts benchmark --cwd /path/to/indexed/repo
bun run test:e2e:no-model
```

`smoke` updates the local GitNexus index and starts or reuses the harness-managed local agentmemory service. It does not call a paid model. A real `chat` run does.

The paid provider canary was run only through `omp-native`: DeepSeek V4 Pro/high returned the expected
response and all five agent-side activation events completed. The official Pi catalog has no DeepSeek
provider, so Pi is validated model-free rather than through a credential bridge or an unwanted provider.

`test:e2e:no-model` runs the public `chat` command through both installed profile DAGs against separate temporary Git repositories and isolated GitNexus registries. It substitutes `tests/fixtures/fake-omp.ts` and `tests/fixtures/fake-pi.ts` only for the agent executables. The fixtures load the real profile extensions; Pi also loads the strict hashline package and uses a bounded in-process agentmemory API. No model request is made. The matrix proves that all six DAG nodes complete, profile-specific audit contracts are satisfied, stdout contains only each final answer, stderr is empty, and Archon's title fallback plus agent progress remain in run logs. Archon v0.6.0's title attempt fails during local model resolution before authentication or network dispatch.

## State and trust boundaries

- Harness runtime state: `~/.local/share/archon-harness/`
- OMP configuration: existing `~/.omp/agent/config.yml`, read-only
- Repository index: GitNexus-managed local state
- Memory: agentmemory-managed state under `~/.local/share/archon-harness/services/agentmemory`
- GitNexus is PolyForm Noncommercial. Do not use this integration commercially without an appropriate license.
- No upstream source is patched. Tura batching is independently implemented; restricted upstream code is not copied.
