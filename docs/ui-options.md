# UI Options

Research date: 2026-07-28

## Decision

Use the built-in [Archon Web UI](https://archon.diy/adapters/web/) as the supported browser surface.
Archon already owns this harness's project and workflow boundary, so its UI can expose workflow
selection and execution evidence without introducing a second agent runtime.

Do not wire a Pi-only or OpenCode UI directly to OMP. That would provide a pleasant chat surface but
bypass Archon, its deterministic DAG, and the postflight evidence gate.

## Requirement fit

| Candidate | Text prompts | Workflow choice | Parallel repositories/sessions | Live execution | Rename/delete/archive | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| [Archon Web](https://archon.diy/adapters/web/) | Yes | Native workflow picker | Projects plus background workflow runs | DAG nodes, tool cards, status, artifacts | Rename and soft-delete; no archive or hard purge | Selected and implemented |
| [PI WEB](https://github.com/jmfederico/pi-web) | Yes | Pi sessions, not Archon workflows | Strong project/workspace/session model | Agent and workspace supervision | Session management; lifecycle details vary | Strong product, wrong runtime boundary |
| [Pi Web](https://github.com/ct-jyjntc/pi-web) | Yes | Pi agent controls, not Archon workflows | Project-grouped sessions and worktrees | Streaming tools, Git, files, terminals | Rename, delete, export; no archive claim | Feature-rich, wrong runtime boundary |
| [Firstpick Pi Web UI](https://pi.dev/packages/@firstpick/pi-package-webui) | Yes | Pi tabs/extensions, not Archon DAGs | Multi-tab sessions with isolated CWDs | Streaming output and tool state | Durable tabs; not the Archon run lifecycle | Useful Pi package, wrong owner |
| [OpenCode Web](https://opencode.ai/docs/web/) | Yes | OpenCode agents/modes | Multiple sessions and working directories | Streaming session state | Session management | Replaces the runtime rather than adapting it |
| Open WebUI / LibreChat / OpenHands | Yes | Their own agents or presets | Varies | Generic agent/tool views | Varies | Too much unrelated platform or too little Archon evidence |

## Implemented integration

1. The pinned Archon v0.6.0 binary includes `archon serve` and a checksum-verified web artifact.
2. `archon-harness ui` starts Archon on a private ephemeral loopback port, checks `/health` with a
   bounded readiness loop, and exposes a loopback-only presentation proxy on the requested public port.
3. The launcher passes only required system and harness variables, disables telemetry, and refuses to
   start when the managed Archon home's `.env` or the neutral runtime's `.archon/.env` could override
   them.
4. Each harness workflow falls back to unique audit, response, and agent log paths under each run's
   `$ARTIFACTS_DIR/harness/`; CLI-provided paths remain backward compatible.
5. The Web API exposes embedded, repository, and all three global harness workflows unchanged. A
   pre-bundle presentation script labels rendered picker options as `OMP harness`, `Pi modular`,
   `Claude required`, or `Inherited provider`; it does not rename workflow IDs or rewrite API JSON.
6. Conversation rename and soft deletion are implemented upstream. Archon v0.6.0 has no distinct
   archive operation or hard-purge conversation endpoint.

## Pi, OMP, and hashline

OMP is a fork of Pi, and this repository compares both current boundaries. `omp-native` uses
`@oh-my-pi/pi-coding-agent` 17.1.6 and its native default hashline mode without RTK or agentmemory.
`pi-modular` uses official Pi 0.82.1 with `pi-hashline-edit-pro` 0.18.0, RTK, and agentmemory. Both keep
Archon outside the model loop as the workflow and evidence owner.

## Remaining upstream gaps

1. Add distinct archive/unarchive semantics if they are still useful after soft deletion is evaluated.
2. Add an explicit hard-purge endpoint and confirmation flow if permanent conversation deletion is
   required.
3. Upstream Archon v0.6.0 still emits harmless packaged-default-path warnings in server logs even
   though `/api/workflows` correctly returns its embedded bundled definitions.
