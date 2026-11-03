# Changelog

## 1.0.2 — 2026-11-03

Dock-click fix.

- The beacon is now an ordinary regular app launched with `open -n -g`, not a
  background agent (`LSUIElement`) that promotes itself to a regular app at
  runtime. A promoted tile is a Dock item LaunchServices cannot reopen: clicking it
  made macOS reveal the bundle in Finder instead of activating the app, so the click
  never reached the helper and Harness was never brought to the front.
- The helper reacts to activation from the first moment — the old 1.2 s launch
  guard could swallow a fast click — retries raising the target a few times before
  giving up, and logs the activation outcome (`switching to target`, `activating
  target`, `finishing reason`).
- The helper is copied once to
  `~/Library/Application Support/dsh-dock-attention/DSH Attention.app`, with the
  quarantine flag stripped, an ad-hoc signature and a LaunchServices registration.
  The Dock tile therefore belongs to one stable app bundle instead of a file inside
  `node_modules`, which also prevents App Translocation for zip installs. The copy
  is refreshed when the shipped binary changes.
- `runtime/request.json` and `runtime/helper.log` moved next to the installed helper
  (`~/Library/Application Support/dsh-dock-attention/runtime/`); the plugin passes
  both paths to the helper explicitly. The old in-package `runtime/` directory is no
  longer used.
- `tests/helper.test.mjs` guards the bundle against `LSUIElement` coming back, keeps
  the committed bundle's `Info.plist` in sync with `src/helper/Info.plist`, and pins
  the stable install location.

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
