# Handoff: Teleport session import

Branch: `feat/teleport-session-import`  
Base: current `origin/main` (`5719e8ac4`)  
Working tree: **dirty / uncommitted** (intentionally — next agent owns the first commit)

## What this is

“Teleport” lets T3 Code **discover, import, and launch** external provider sessions (Codex / Cursor / OpenCode) into T3 threads.

Related issue: https://github.com/pingdotgg/t3code/issues/207

## What’s already in the working tree

### New modules

- `packages/contracts/src/teleport.ts` (+ tests) — schemas, errors, RPC payloads
- `apps/server/src/teleport/**` — discovery, history import, resume cursors, CLI commands, `TeleportService`
- `apps/server/src/provider/openCodeResume.ts`
- `apps/web/src/components/teleport/**` — import dialog, actions, form helpers, chat integration hook

### Wired into existing code

- Contracts RPC (`WS_METHODS` + `WsRpcGroup`) and exports
- Server `ws.ts` / `server.ts` TeleportService registration (adapted to current auth model)
- Provider adapters / session runtimes: `strictResume` plumbing (Codex, OpenCode, Cursor/ACP)
- `externalLauncher`: terminal launch helpers for “teleport out”
- Web: `ChatView` / `ChatHeader` / `NoActiveThreadState` hooks for import UI

## Critical rebase gaps (do these first)

Main moved ~645 commits since the original WIP. Conflicts were resolved mechanically; several intentional gaps remain:

1. **Client RPC facade is gone.** `#2978` deleted `apps/web/src/environmentApi.ts` and `apps/web/src/rpc/wsRpcClient.ts`.  
   Teleport UI still calls `readEnvironmentApi(...).teleport.*` in:
   - `apps/web/src/components/teleport/useTeleportChatIntegration.tsx`
   - `apps/web/src/components/teleport/TeleportImportDialog.tsx`  
     **Port to** `@t3tools/client-runtime/rpc` (`request(WS_METHODS.teleport…)`) or a new `apps/web/src/state/teleport.ts` atom helper. See `apps/web/src/cloud/linkEnvironment.ts` for a current pattern.

2. **Browser tests were deleted** with the connection rewrite. Dropped:
   - `ChatView.browser.tsx`
   - `ProviderModelPicker.browser.tsx`  
     Keep unit tests under `*.test.ts(x)` only.

3. **`localApi.test.ts` teleport coverage was dropped** because it depended on `createEnvironmentApi`. Re-add against the new RPC/atom path.

4. **`TeleportService.test.ts` mock may be incomplete** vs current `ExternalLauncherShape` (needs `resolveAvailableEditors` and any other new methods).

5. **ACP `strictResume`:** HEAD already fails hard on resume failure (no soft fallback). Field is threaded for API parity; don’t reintroduce old fallback behavior without checking current ACP semantics.

6. **Model picker “warning = selectable” tweak** was largely superseded by `isProviderInstancePickerReady` on main — don’t re-litigate unless teleport specifically needs it.

## Contribution constraints

`CONTRIBUTING.md` still says the project is not actively accepting contributions and large feature PRs are least likely to land. Prefer:

- Issue-first alignment on `#207` / roadmap
- Small, reviewable PR(s) if possible (contracts + server discovery vs UI vs provider resume)
- Clear before/after UX notes if UI ships

## Typecheck inventory (after rebase; not green)

Clean `origin/main` server typecheck: **passes**.  
This branch: **fails**. Logs under `.git/teleport-recovery/typecheck-*.log`.

### Contracts (~15 errors)

- Fixed mechanically during prep: `Schema.Defect` → `Schema.Defect()` (Effect Schema API on main).
- Remaining: TaggedError / decoder mismatches in `teleport.test.ts` — align with current contracts error-test patterns.

### Web (~16 errors, teleport-focused)

- `readEnvironmentApi` / missing `environmentApi` module (see Critical gap #1)
- `EnvironmentProject.cwd` → use current `workspaceRoot` (or equivalent)
- `session.orchestrationStatus` → use current session status fields
- `ChatView.logic.ts`: conflict resolution left a bad `isProviderDriverKind` call; prep pass retargeted to `isKnownProviderDriverKind`

### Server (hundreds of errors; many cascade / Effect context noise)

Teleport-specific hotspots for the next agent:

- `TeleportService.test.ts`: mocks missing `resolveAvailableEditors`, `latestSequence`, `getThreadDetailSnapshot`, `settledOverride`/`settledAt`
- `TeleportService.ts`: `crypto.randomUUID()` lint/type rules → prefer Effect `Random`
- `ws.ts` teleport handlers: missing `EnvironmentAuthorizationError` in Effect error channel (match neighboring RPC handlers)
- Adapter tests: missing `assert` / `node:fs` imports; duplicate object keys in `OpenCodeAdapter.test.ts`
- `providerStatusCache.ts`: missing `Cause` import
- `orchestration/decider.ts` + `server.test.ts`: wiring drift from new Teleport command / service arity

## Suggested next-agent workflow

1. Read this file + skim `packages/contracts/src/teleport.ts` and `apps/server/src/teleport/Layers/TeleportService.ts`
2. Fix the client RPC port (`readEnvironmentApi` → current runtime)
3. Run `bun fmt`, `bun lint`, `bun typecheck` and fix rebase fallout only
4. Run targeted `bun run test` for teleport / contracts / affected adapters
5. Commit (you own the first commit) and open a contribution PR when ready

## Recovery snapshots

If anything is lost, originals are under:

- `.git/teleport-recovery/teleport-wip-tracked.patch`
- `.git/teleport-recovery/teleport-untracked.tar.gz`
- `.git/teleport-recovery/wip-versions/`
- Old local branch with pre-rebase WIP commit: `codex/teleport` @ `3aef43acf`

## Explicit non-goals for the prep pass (already done)

- Rebased onto current main
- Conflicts resolved enough to apply
- Left uncommitted for the next agent
- Did **not** finish the product feature or open a PR
