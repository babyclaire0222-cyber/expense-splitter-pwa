# Tally — Offline-First Expense Splitter

A group expense-splitting Progressive Web App (PWA), built local-first: every read and write hits the browser's IndexedDB (via Dexie.js) first, then syncs to Supabase in the background whenever the network is available. Inspired by Splitwise/Splid.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | SvelteKit (TypeScript, Svelte 5 runes) |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Local storage | Dexie.js (IndexedDB wrapper) |
| Backend | Supabase (Postgres + Auth + Row Level Security) |
| PWA / offline | `@vite-pwa/sveltekit` (`injectManifest` strategy) + a hand-written service worker + `workbox-core`/`workbox-precaching`/`workbox-routing`/`workbox-strategies` |
| Testing | Vitest |
| Fonts | Fraunces (display/money), Instrument Sans (UI), IBM Plex Mono (data/system) |
| Deployment target | Vercel or Netlify (HTTPS required for service workers) |

## Core Architecture Concepts

### 1. Integer cents, always
Every monetary value is stored as an integer number of cents (`amountCents`, `shareCents`), never a float. `$15.99` is `1599`. This is enforced throughout `src/lib/ledger/` and the Postgres schema (`amount_cents integer`).

### 2. Zero-sum ledger
The sum of every member's net balance in a group must always equal exactly zero. This is asserted at three separate layers as defense-in-depth:
- **Split engine** (`splitEngine.ts`) — every computed split's shares must sum exactly to the expense total, or it throws.
- **Balance calculator** (`balances.ts`) — asserts the resulting net balances sum to zero, both before and after settlements are applied (see #8).
- **Postgres trigger** (`check_split_sum`, deferred, on `splits`) — a database-level backstop independent of application code.

### 3. Local-first read/write
Components never call Supabase directly for reads — they query Dexie via a `liveQuery`-based reactive wrapper (`src/lib/utils/liveQuery.svelte.ts`), so the UI updates instantly and works fully offline. Writes go through atomic helper functions in `src/lib/db/writeHelpers.ts` that write to Dexie *and* enqueue a sync-queue entry in a single transaction — so a write is never "lost" between the local save and the network push.

### 4. Background sync — the outbox pattern
`src/lib/sync/syncQueue.ts` + `syncEngine.ts` implement a classic outbox:
- Every local write enqueues a `SyncQueueEntry` (table, record ID, operation, JSON payload).
- `pushPendingChanges()` drains the queue in order whenever the browser comes online, with exponential backoff and a max-retry cap (`MAX_AUTO_ATTEMPTS = 5`) before requiring manual retry.
- `pullRemoteChanges()` fetches everything Postgres RLS allows the current user to see and `bulkPut`s it into Dexie — runs on app load, on reconnect, and on every successful sign-in (`onAuthStateChange` listener — see gotcha #4 below).
- **Splits are pushed as a single batched `upsert()`**, not one row at a time — see gotcha #1 for why.
- Push/pull both respect **unresolved conflicts** (see #7) — a conflicted row is never silently overwritten in either direction until the user resolves it.

### 5. Immutability / audit log
Edits and deletes never destructively overwrite financial data. Expenses and settlements use soft-delete (`deletedAt`), and every create/edit/delete of an expense writes an append-only `AuditLogEntry`. The Postgres `audit_log` table has no `UPDATE`/`DELETE` RLS policy at all — immutability is enforced at the database level, not just by convention. Splits have no soft-delete column at all — see gotcha #5 for how edits to a split allocation are handled instead.

### 6. Approval-gated group membership
Joining a group by code doesn't grant immediate access. `join_group_by_code()` (a `SECURITY DEFINER` Postgres function) inserts a `pending` membership row; the group creator must explicitly approve it before that member can see any group data. This is why the client never gets direct `SELECT` access to `groups.join_code` — code lookups are proxied through the RPC.

### 7. Offline-edit conflict detection (optimistic concurrency)
Every syncable table (`groups`, `members`, `expenses`, `settlements`) carries a server-managed `version` column, auto-incremented by a Postgres trigger on every update. Pushing an *update* is conditional — `UPDATE ... WHERE id = X AND version = <base>` — not a blind `upsert()`. If two devices edit the same row while both offline, whichever pushes second gets a 0-row result instead of silently clobbering the other's change; that's recorded as a `Conflict` (local Dexie table) and surfaced on `/groups/[groupId]/conflicts` for the user to resolve ("keep mine" / "keep theirs"). See `src/lib/db/types.ts`'s `Conflict` doc comment for the full design, including the deliberate scope limit on splits (gotcha #5).

### 8. Settlements — real payments outside of expenses
A `Settlement` records an actual payment between two members (e.g. cash handed over to square up a debt) — distinct from an `Expense`, which represents a shared cost. `computeGroupBalances()` takes settlements as an optional third argument and folds them into `netCents` after the expense-based balances are computed, preserving the zero-sum invariant. The `/groups/[groupId]/settle` page shows the debt-simplifier's suggested transfers with a "Mark as paid" button that calls `recordSettlementLocal()`.

Duplicate payments (two devices recording the same transfer) are guarded at two layers: a local heuristic warns before recording if a matching payment was made in roughly the last 5 minutes (catches the common accidental-double-tap case), and — since settlement inserts are pushed through `record_settlement_dedup()` rather than a plain insert — a server-side, advisory-lock-serialized check closes the harder case where two genuinely offline devices both record the same payment independently. See migration `0006_settlement_dedup.sql` and `pushSettlementInsert()` in `syncEngine.ts` for the full mechanism.

### 9. Cross-device conflict notifications
When someone resolves a conflict with "keep mine," a `sync_overrides` row is written directly to Postgres (best-effort, not through the outbox) describing what changed. Every *other* device picks this up on its next pull and shows a dismissible banner on the group's Balances page — distinct from an ordinary data refresh, so a member whose already-synced edit just got overridden actually finds out about it instead of the value silently changing underneath them. Dismissal is local-only (`SyncNotification.dismissedAt`); the underlying `sync_overrides` event is never deleted.

## ⚠️ Gotchas hit building this (read before extending)

### 1. RLS + upsert ordering
**Postgres RLS evaluates both INSERT and UPDATE (and an implicit SELECT for conflict detection) policies on any `INSERT ... ON CONFLICT DO UPDATE` statement — even when the row is a genuine first-time insert with no real conflict.**

We hit this hard: when a user creates a *new* group, our sync engine pushes it via `upsert()`. The group's `UPDATE` and `SELECT` RLS policies originally checked `is_group_creator()`/`is_approved_member()`, which look up the `members` table — but the creator's own membership row hasn't synced yet at that point (it's a separate queued entry). Circular dependency, silent 403.

**Fix:** any table using `upsert()` from the client needs its INSERT, UPDATE, *and* SELECT policies to all independently allow the "I own this row" case (e.g. `created_by = auth.uid()`), without depending on a lookup into another not-yet-synced table.

### 2. `splits` needs an UPDATE policy too, not just INSERT
The original migration gave `splits` `INSERT`/`SELECT` policies but no `UPDATE` — meaning editing an existing split silently failed (RLS default-deny). This blocked expense editing entirely, since `updateExpenseLocal()` updates existing split rows in place (see gotcha #5). Fixed in `0002_splits_update_policy.sql`.

### 3. SvelteKit SPA fallback + `vite preview` serves relative asset paths by default
`adapter-static`'s SPA fallback page is generated with **relative** asset paths (`../_app/immutable/...`) by default, which resolve correctly at `/` but break on any nested route (`/groups/<id>` → browser resolves against the wrong base, 404s on every JS chunk). Set `paths: { relative: false }` in the `sveltekit()` plugin config to force absolute paths.

**Separately:** `vite preview` does not reliably honor this for the SPA-fallback case in testing — it can still serve relative-path HTML for unmatched routes even with the config fixed, even though the real `build/index.html` on disk is correct. For genuine offline/deep-link testing, serve the `build/` folder with a real static server instead (`npx serve build -s -p 4173`), not `vite preview`.

### 4. `runFullSync()` at boot doesn't re-run after login
The sync engine's initial pull fires once when `hooks.client.ts` loads — before the user has necessarily signed in, so `pullRemoteChanges()` correctly finds no session and does nothing. Since the login page navigates via `goto('/')` (client-side, not a full reload), `hooks.client.ts` never re-executes, so **nothing re-triggers a pull after a successful sign-in** without this fix. Fixed by subscribing to `supabase.auth.onAuthStateChange()` inside `startSyncEngine()` and re-running `runFullSync()` on `SIGNED_IN`/`TOKEN_REFRESHED` — covers login, future signup, and session restore alike.

### 5. Splits don't get their own per-row conflict detection (accepted scope limit)
Editing an expense's split allocation always happens together with editing the expense itself (`updateExpenseLocal()`), so conflict detection is gated at the **parent expense's** level rather than per-split-row. A "keep mine" resolution re-pushes the local splits via the existing batched `upsert()` without an independent version check on the splits themselves.

This is deliberate, not an oversight: splits must be pushed as one atomic batch (see gotcha #1's sibling issue — the `check_split_sum` deferred trigger validates the *sum* at end-of-transaction, so pushing splits one row at a time causes it to reject every row except the last). Per-row conditional updates and atomic batching are in tension — PostgREST doesn't support per-row `WHERE` clauses in a batch `upsert()`. A full fix would need a Postgres RPC that does the conditional per-row check *and* the batching inside one PL/pgSQL transaction. Judged not worth the added complexity for this app's scale; see `Conflict`'s doc comment in `src/lib/db/types.ts` for the full reasoning if revisiting this.

### 6. Service worker: `generateSW` can't work for a pure SPA without prerendering
`@vite-pwa/sveltekit`'s `generateSW` strategy validates `navigateFallback` against its precache manifest at *build time* — but `adapter-static`'s fallback `index.html` isn't written until *after* the manifest is already generated (SvelteKit hands off to the adapter after Vite/the PWA plugin finish). For an app with no prerendered pages, there is **no** HTML file available when the manifest is built, so `navigateFallback` always throws `non-precached-url`, regardless of what URL it points at.

**Fix:** switched to the `injectManifest` strategy with a hand-written `src/service-worker.ts` (see `precacheAndRoute` there). It precaches JS/CSS/fonts normally (those files DO exist at manifest-generation time — only the adapter's HTML doesn't), and handles the SPA shell separately: caches it in a *runtime* cache the first time it's fetched (seeded proactively on the service worker's own `install` event — see next gotcha), then serves that cached copy for every subsequent navigation, including deep links that were never precached.

### 7. A service worker can never intercept the navigation that installs it
The shell-caching approach above has a subtlety: if you only cache the shell lazily on the first *live navigation* that passes through the worker, and the user's actual first visit happens to be `/login` with everything after that being client-side routing (normal for an SPA), the shell (`/`) may never get cached at all — confirmed via a real offline test that threw an uncaught rejection with nothing to fall back to. Fixed by seeding the shell cache proactively in the service worker's own `install` event handler, which fires right after the script downloads (normally while still online), rather than waiting for a navigation to trigger it.

### 8. `workbox-build`'s `injectManifest` requires the literal string `self.__WB_MANIFEST` to appear **exactly once**
It does a literal find-and-replace, not AST-aware parsing. Referencing it twice (e.g. in a defensive ternary like `Array.isArray(self.__WB_MANIFEST) ? self.__WB_MANIFEST : []`) breaks the production build with an assertion error. Assign it to a variable first if you need to reference it more than once.

### 9. `self.__WB_MANIFEST` is only real in a production build
In `npm run dev`, SvelteKit's native service-worker feature still compiles and serves `src/service-worker.ts` — independent of `@vite-pwa/sveltekit`'s own `devOptions.enabled` setting — but the `injectManifest` transform that replaces `self.__WB_MANIFEST` with a real array only runs during `vite build`. The raw placeholder reaching `precacheAndRoute()` in dev mode crashes it. Guard with `Array.isArray(self.__WB_MANIFEST) ? self.__WB_MANIFEST : []` (see gotcha #8 for the one-reference caveat).

### 10. TypeScript's Supabase client needs literal table names, not `string`
A helper function that picks a table name at runtime via a typed return of `string` breaks every `.from()` call's overload resolution, even though each branch of the ternary returns a valid literal — the explicit `: string` annotation widens it. Either let TypeScript infer the literal union return type, or (for genuinely runtime-determined table access across several different tables, like the generic conflict-resolution code in `syncEngine.ts`) cast at one narrow, well-documented boundary rather than fighting the type system at every call site.

### 11. `injectManifest` fails on remote Linux CI builds specifically — never on local Windows builds
Beyond gotchas #6–#9 (which cover getting `injectManifest` working *at all*), there's a separate, harder issue: it fails deterministically on cold Linux CI machines with the same `ENOENT: ... service-worker.js` error as gotcha #6, while succeeding 100% reliably locally. Confirmed to reproduce identically across two independent platforms' Linux build infrastructure (Vercel and Netlify), and confirmed *not* to be a timing race (two consecutive attempts on the same machine fail identically). The root cause looks like a hook-scoping issue in how `@vite-pwa/sveltekit`'s `closeBundle` hook interacts with Vite 8's newer multi-environment build API — likely upstream, not fixable from this project. See the Deployment section below for the actual workaround (build locally, deploy only the static output — never let CI run the build for this project).

## Project Setup

```bash
# 1. Scaffold
npx sv create expense-splitter-pwa
cd expense-splitter-pwa

# 2. Install dependencies
npm install tailwindcss @tailwindcss/vite
npm install dexie
npm install @supabase/supabase-js
npm install -D @vite-pwa/sveltekit vite-plugin-pwa
npm install -D workbox-core workbox-precaching workbox-routing workbox-strategies workbox-window
npm install -D @sveltejs/adapter-static
npm install uuid date-fns
npm install -D @types/uuid vitest prettier eslint supabase

# 3. Link Supabase project
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations/*.sql in order

# 4. Generate types from the live schema
npx supabase gen types typescript --project-id <your-project-ref> > src/lib/supabase/types.ts

# 5. Environment variables — create .env at project root:
#    PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
#    PUBLIC_SUPABASE_ANON_KEY=<publishable key>

# 6. Run
npm run dev
```

**Critical:** `vite.config.ts` must register the Tailwind plugin (`tailwindcss()` in the `plugins` array) — installing the npm packages alone does not wire it into the build. Same applies to `SvelteKitPWA(...)` for the service worker, and `paths: { relative: false }` inside the `sveltekit(...)` plugin options (see gotcha #3).

### Testing offline behavior locally
`npm run dev` never runs a real service worker in a way that matches production (see gotchas #6, #9). To genuinely test offline/PWA behavior:
```bash
npm run build
npx serve build -s -p 4173   # NOT npm run preview — see gotcha #3
```
Then open `http://localhost:4173` in a fresh Incognito window (rules out stale service-worker/cache state from a previous build), sign in, visit a group so its data is cached locally, then DevTools → Network → Offline, and hard-reload a deep link.

## Data Model

### Dexie (local, `src/lib/db/schema.ts`) — schema version 5, 9 tables
`groups`, `members`, `expenses`, `splits`, `auditLog`, `syncQueue`, `settlements`, `conflicts`, `syncNotifications`. Every syncable record carries a `syncStatus: 'synced' | 'pending' | 'conflict'` field and (except `splits`, `auditLog`, `conflicts`, `syncNotifications`) a server-managed `version` integer. Soft-deletes use `deletedAt: string | null`, never hard deletes.

`conflicts` and `syncNotifications` are local-only bookkeeping tables — they don't sync through the normal outbox and have no server-side counterpart (`conflicts`) or only a partial one (`syncNotifications` mirrors the append-only `sync_overrides` Postgres table, but dismissal state stays local per device).

### Supabase (remote, `supabase/migrations/`) — 5 migrations
| File | Adds |
|---|---|
| `0001_init.sql` | Core schema: `groups`, `members`, `expenses`, `splits`, `audit_log`, RLS policies, `is_approved_member()`/`is_group_creator()`/`join_group_by_code()` |
| `0002_splits_update_policy.sql` | Missing `UPDATE` RLS policy on `splits` (gotcha #2) |
| `0003_settlements.sql` | `settlements` table + RLS |
| `0004_optimistic_concurrency.sql` | `version` column + auto-increment trigger on `groups`/`members`/`expenses`/`splits`/`settlements` |
| `0005_sync_overrides.sql` | `sync_overrides` table + RLS (cross-device conflict-resolution notifications) |
| `0006_settlement_dedup.sql` | `record_settlement_dedup()` RPC — server-side, advisory-lock-serialized duplicate-payment prevention |

Field names are `snake_case` remotely, `camelCase` locally; `src/lib/sync/mappers.ts` is the single source of truth for translating between them in both directions. Client-generated UUIDs (`crypto.randomUUID()`) are used everywhere — the same ID exists in Dexie and Postgres from the moment of creation, no reconciliation needed.

## Feature Status

| Feature | Status |
|---|---|
| Group creation, join-by-code, approval flow | ✅ |
| Sign-up / sign-in | ✅ |
| Equal / percentage / custom expense splitting | ✅ |
| Edit / delete expense | ✅ |
| Debt simplification (greedy min-cash-flow) | ✅ |
| Live balance & settle-up views | ✅ |
| Record a settlement payment ("mark as paid") + undo | ✅ |
| Server-side settlement duplicate prevention | ✅ |
| Offline logging with instant local UI updates | ✅ |
| Background sync (push + pull, retry/backoff) | ✅ |
| PWA manifest, install, offline fallback, service worker | ✅ |
| Offline-edit conflict detection + resolution UI | ✅ |
| Cross-device "your edit was overridden" notifications | ✅ |
| Per-row conflict detection for splits | ⏳ accepted scope limit — see gotcha #5 |
| Multi-currency handling | ⏳ `currency` stored per-group/per-expense but not actively validated/converted |

## Project Structure

```
src/
├── lib/
│   ├── db/              # Dexie schema, types, atomic write helpers (incl. conflict resolution)
│   ├── supabase/        # Supabase client + generated types
│   ├── sync/            # Outbox queue, push/pull engine, field mappers, conflict-diff summaries
│   ├── ledger/          # Split engine, debt simplifier, balance calculator
│   ├── components/      # TopBar, GroupBottomNav (with live conflict-count badge)
│   └── utils/            # liveQuery Svelte-runes wrapper
├── routes/
│   ├── login/
│   ├── signup/
│   ├── groups/
│   │   ├── new/          # Create group
│   │   ├── join/         # Join by code
│   │   └── [groupId]/
│   │       ├── +page.svelte              # Balances + pending approvals + sync-override banners
│   │       ├── expenses/
│   │       │   ├── +page.svelte          # List
│   │       │   ├── new/                  # Create
│   │       │   └── [expenseId]/edit/     # Edit + delete
│   │       ├── settle/                   # Debt simplification + record/undo payments
│   │       └── conflicts/                # Resolve offline-edit collisions
│   └── +page.svelte      # Group list (dashboard)
├── service-worker.ts     # Hand-written (injectManifest strategy) — see gotchas #6, #7, #8, #9
└── app.html
supabase/
└── migrations/            # SQL schema, RLS policies, RPC functions, version triggers
tests/                      # Vitest unit tests: split engine, balances, debt simplifier
```

## Design System

- **Palette**: pale ledger-green paper (`#ECF0E6`), forest-green credit (`#2E6B4F`), brick-red debit (`#B23A2E`), brass accent (`#C08829`) — grounded in the aesthetic of old accounting ledger books, not a generic fintech look.
- **Type**: Fraunces (serif) reserved *only* for money amounts and headlines; Instrument Sans for UI; IBM Plex Mono for system/data (sync status, join codes, timestamps).
- **Signature element**: a dashed "stub tear" divider (`.stub-tear` in `app.css`) styled after a checkbook perforation, used to separate summary from detail.

## Testing

```bash
npm run test    # Vitest — split engine, balances, debt simplifier
npm run check   # svelte-check — TypeScript + Svelte diagnostics
```

## Deployment

**Deployed via Netlify, not Vercel — here's why**, since it wasn't the obvious first choice and cost real time to work out:

`@vite-pwa/sveltekit`'s `injectManifest` strategy has a genuine, reproducible bug under Vite 8's newer "environments" API: on a cold Linux CI build machine, the plugin's manifest-injection step (`closeBundle` hook) fires immediately after the SSR environment's build finishes, *before* the separate client-side build pass that actually compiles `src/service-worker.ts` has run — so it looks for a file that doesn't exist yet and the build fails with `ENOENT: ... service-worker.js`.

This isn't a config mistake — it was confirmed to reproduce **identically on two independent platforms' Linux build infrastructure** (Vercel and Netlify, different build images, different Node patch versions, same exact error and stack trace), while succeeding 100% reliably every time on a local Windows machine. It also isn't timing-flaky — two consecutive attempts on the same machine fail identically, ruling out a race condition. The practical conclusion: **any remote CI build of this project will currently hit this bug**, regardless of hosting platform, until `@vite-pwa/sveltekit` fixes its hook scoping under Vite 8's environments API upstream.

Vercel was tried first and hit three *separate* real issues before this became clear: their CLI's local build step (`vercel build`) has a long-standing, unresolved Windows bug (`Error: spawn cmd.exe ENOENT`, unrelated to PATH/`ComSpec`, both confirmed correctly configured); their framework auto-detection for a `adapter-static` SvelteKit project silently overrides `vercel.json`'s `outputDirectory` unless every override field is both toggled *and* has real typed text in it (a toggle switched on with an empty field silently does nothing); and underneath both of those, the same cross-platform `injectManifest` bug above. None of these are fixable from this project's side.

### The actual working deployment process

Since the local build is 100% reliable and the only broken piece is *remote* building, the fix is simple: **build locally, deploy only the already-built static output** — never let a CI machine run `npm run build` for this project.

```bash
# One-time setup
npm install -g netlify-cli
netlify login
netlify link          # link to the existing site — do NOT create a new one each time

# Every deploy after that
netlify deploy --prod --dir=build
```

`netlify deploy` runs the build itself, but locally (on your machine, using your site's stored build settings) rather than on Netlify's remote Linux build servers — so it never touches the buggy code path at all. This single command is the entire deploy workflow going forward.

**Do not** connect this repo to Netlify or Vercel's GitHub integration (auto-deploy on push) — that triggers a *remote* build and will hit the bug every time. Regular `git push origin master` still keeps GitHub history accurate; it just doesn't trigger a live deploy anymore.

`postbuild` (in `package.json`) automatically writes both `build/vercel.json` and `build/_redirects` after every `npm run build`, so the output folder is ready for either platform's SPA-fallback routing regardless of which one ends up hosting it.

## Known Gaps / Next Steps

1. **Per-row conflict detection for splits** — currently gated at the parent expense's level rather than independently version-checked; see gotcha #5 for the full reasoning and what a complete fix would require (a Postgres RPC for atomic batched conditional updates).
2. **Multi-currency handling** — `currency` is stored per-group and per-expense but not actively validated or converted; a group's balance math implicitly assumes every expense shares the group's currency.
3. **`@vite-pwa/sveltekit` + Vite 8 remote-build incompatibility** — see the Deployment section above. Worth periodically checking if an upstream fix lands, at which point normal git-integrated auto-deploy could be restored.
