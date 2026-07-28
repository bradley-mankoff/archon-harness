# UI Options

Research date: 2026-07-28

## Decision

Use the built-in [Archon Web UI](https://archon.diy/adapters/web/) as the future browser surface.
Archon already owns this harness's project and workflow boundary, so its UI can expose workflow
selection and execution evidence without introducing a second agent runtime.

Do not wire a Pi-only or OpenCode UI directly to OMP. That would provide a pleasant chat surface but
bypass Archon, its deterministic DAG, and the postflight evidence gate.

## Requirement fit

| Candidate | Text prompts | Workflow choice | Parallel repositories/sessions | Live execution | Rename/delete/archive | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| [Archon Web](https://archon.diy/adapters/web/) | Yes | Native workflow picker | Projects plus background workflow runs | DAG nodes, tool cards, status, artifacts | Rename and delete; archive not documented | Best architecture fit |
| [PI WEB](https://github.com/jmfederico/pi-web) | Yes | Pi sessions, not Archon workflows | Strong project/workspace/session model | Agent and workspace supervision | Session management; lifecycle details vary | Strong product, wrong runtime boundary |
| [Pi Web](https://github.com/ct-jyjntc/pi-web) | Yes | Pi agent controls, not Archon workflows | Project-grouped sessions and worktrees | Streaming tools, Git, files, terminals | Rename, delete, export; no archive claim | Feature-rich, wrong runtime boundary |
| [Firstpick Pi Web UI](https://pi.dev/packages/@firstpick/pi-package-webui) | Yes | Pi tabs/extensions, not Archon DAGs | Multi-tab sessions with isolated CWDs | Streaming output and tool state | Durable tabs; not the Archon run lifecycle | Useful Pi package, wrong owner |
| [OpenCode Web](https://opencode.ai/docs/web/) | Yes | OpenCode agents/modes | Multiple sessions and working directories | Streaming session state | Session management | Replaces the runtime rather than adapting it |
| Open WebUI / LibreChat / OpenHands | Yes | Their own agents or presets | Varies | Generic agent/tool views | Varies | Too much unrelated platform or too little Archon evidence |

## Integration constraints

1. The pinned Archon v0.6.0 binary includes `archon serve` and a checksum-verified web artifact.
2. The server defaults to `0.0.0.0`; the harness wrapper must force `HOST=127.0.0.1` and verify the
   listener before reporting readiness.
3. Archon loads user and repository `.archon/.env` files with override precedence. The wrapper must
   prevent those files from reintroducing platform tokens or changing the bind address.
4. The web server can run multiple background workflows, but the current workflow writes CLI-owned
   audit, response, and OMP log paths. Browser runs need unique paths derived from each Archon run's
   artifact directory.
5. Archon exposes many bundled workflows, but only `archon-efficient` currently launches pinned OMP
   with hashline, batching, RTK, GitNexus, agentmemory, Caveman policy, and the evidence gate. The UI
   must initially filter to harness-compatible workflows, or additional workflows must be authored
   against the same boundary.
6. Conversation rename and deletion are documented. Full archival is not documented in v0.6.0 and
   should be treated as a separate lifecycle feature rather than relabeling delete.

## Pi, OMP, and hashline

OMP is a fork of Pi, and this repository imports `@oh-my-pi/pi-coding-agent` 17.1.6. OMP ships
`@oh-my-pi/hashline` and defaults its edit mode to hashline. Stock Pi has third-party hashline
extensions in the [Pi package catalog](https://pi.dev/packages), but those are separate packages and
not the implementation used by this harness.

## Recommended implementation sequence

1. Define two or more named harness-compatible workflows; a picker with one safe choice is theater.
2. Add a loopback-only Archon Web launcher with a strict environment and bounded readiness check.
3. Make every workflow run allocate audit, response, and OMP logs from its own artifact directory.
4. Add UI contract tests for workflow filtering, project switching, parallel runs, node/tool events,
   rename, deletion, and explicit archive behavior.
5. Only then expose the browser command as supported.
