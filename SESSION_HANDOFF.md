# Archon Harness - Operational Handoff

## Working stopping point

The repository provides two isolated Archon-owned profiles:

- `omp-native`: OMP 17.1.6, native hashline, dependency-step batching, GitNexus, and concise final output.
- `pi-modular`: official Pi 0.82.1, strict hashline, RTK-backed batching, GitNexus, agentmemory, and the same final policy.

Both use three-node Archon DAGs (`preflight`, `agent`, `postflight`) and profile-specific audit gates.
The browser picker exposes both workflows without bypassing Archon.

## Model boundary

Install the verified paid path with:

```bash
bun install --frozen-lockfile
bun run install:harness -- --omp-model deepseek/deepseek-v4-pro:high
```

OMP's catalog exposes DeepSeek V4 Pro at `high` and `max`. Official Pi 0.82.1 does not expose a
DeepSeek provider, so installation leaves Pi's model unset unless `--pi-model` is supplied explicitly.
CLI selection of unconfigured Pi fails before Archon starts; the browser workflow fails before Pi starts.
Do not add a credential-copying provider shim merely to make the profiles look symmetrical.

## Validation evidence

- Both model-free profile DAGs complete: six nodes total, seven OMP audit entries, and ten Pi audit entries.
- The OMP paid canary completed with `deepseek/deepseek-v4-pro:high` and all five agent-side activation events.
- Official Pi's binary, package root, strict hashline extension, harness extension, RTK path, memory lifecycle, response capture, and postflight gate are exercised without a model request.
- GitNexus repairs only its generated FTS state, once, after the explicit corruption diagnostic.
- The UI is loopback-only, strips ambient credentials, and preserves upstream workflow API identifiers.

## Routine commands

```bash
bun run check
bun src/cli.ts doctor
bun src/cli.ts smoke --cwd /absolute/path/to/indexed/repo
bun src/cli.ts benchmark --cwd /absolute/path/to/indexed/repo
bun run test:e2e:no-model
bun run ui -- --no-open
```

`doctor`, `smoke`, `benchmark`, and `test:e2e:no-model` make no paid model calls. A real `chat` does.
See `README.md` for installation, use, UI, Slack, and trust boundaries; see `architect.md` for invariants.

## Remaining honest gaps

- Real Pi inference requires an explicit model available in official Pi's catalog.
- Archon v0.6.0 has soft deletion but no distinct conversation archive or hard-purge API.
- GitNexus is PolyForm Noncommercial and needs an appropriate license for commercial use.
