# Changelog

## 1.0.1 — 2026-10-30

Packaging release; no behavior changes.

- The published package now also ships `tools/`, `tests/`, `src/`, `docs/` and
  `CHANGELOG.md`, so `node tools/self-check.mjs` and the helper build script work from
  an installed plugin directory too.
## 1.0.0 — 2026-10-30

First public release.

- Host plugin watches `session/event` for approvals, agent questions and finished /
  failed / blocked turns.
- Bounces a Dock icon only when the Harness window is not frontmost; completely
  silent while the window has focus, for subagent sessions (unless enabled) and
  inside the debounce window.
- Ships the universal (arm64 + x86_64), ad-hoc signed **DSH Attention** beacon app:
  starts as a background agent, promotes itself to a regular app so a Dock tile
  appears, bounces via AppKit `requestUserAttention`, opens Harness on click, and
  disappears when the user returns or the time budget runs out.
- Configuration: per-kind switches, `critical` / `informational` modes, time budget,
  debounce, optional sound, browser bundle-id overrides for `dsh web`.
- 18 `node:test` unit tests and an end-to-end `tools/self-check.mjs`.
- macOS only. The beacon is a separate Dock tile because Electron main-process Dock
  APIs are unreachable from Host plugins; see the README for the full explanation.
