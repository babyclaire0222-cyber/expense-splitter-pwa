# Tally — Offline-First Expense Splitter

A group expense-splitting Progressive Web App (PWA), built local-first: every read and write hits the browser's IndexedDB (via Dexie.js) first, then syncs to Supabase in the background whenever the network is available. Inspired by Splitwise/Splid.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | SvelteKit (TypeScript, Svelte 5 runes) |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Local storage | Dexie.js (IndexedDB wrapper) |
| Backend | Supabase (Postgres + Auth + Row Level Security) |
| Testing | Vitest |
| Fonts | Fraunces (display/money), Instrument Sans (UI), IBM Plex Mono (data/system) |
| Deployment target | Vercel or Netlify (HTTPS required for service workers) |

## Core Architecture Concepts

### 1. Integer cents, always
Every monetary value is stored as an integer number of cents (`amountCents`, `shareCents`), never a float. `$15.99` is `1599`. This is enforced throughout `src/lib/ledger/` and the Postgres schema (`amount_cents integer`).

### 2. Zero-sum ledger
The sum of every member's net balance in a group must always equal exactly zero. This is asserted at three separate layers as defense-in-depth:
- **Split engine** (`splitEngine.ts`) — every computed split's shares must sum exactly to the expense total, or it throws.
- **Balance calculator** (`balances.ts`) — asserts the resulting net balances sum to zero.
- **Postgres trigger** (`check_split_sum`, deferred, on `splits`) — a database-level backstop independent of application code.

### 3. Local-first read/write
Components never call Supabase directly for reads — they query Dexie via a `liveQuery`-based reactive wrapper (`src/lib/utils/liveQuery.svelte.ts`), so the UI updates instantly and works fully offline. Writes go through atomic helper functions in `src/lib/db/writeHelpers.ts` that write to Dexie *and* enqueue a sync-queue entry in a single transaction — so a write is never "lost" between the local save and the network push.

### 4. Background sync — the outbox pattern
`src/lib/sync/syncQueue.ts` + `syncEngine.ts` implement a classic outbox:
- Every local write enqueues a `SyncQueueEntry` (table, record ID, operation, JSON payload).
- `pushPendingChanges()` drains the queue in order whenever the browser comes online, with exponential backoff and a max-retry cap (`MAX_AUTO_ATTEMPTS = 5`) before requiring manual retry.
- `pullRemoteChanges()` fetches everything Postgres RLS allows the current user to see and `bulkPut`s it into Dexie — runs on app load and on reconnect.
- **Splits are pushed as a single batched `upsert()`**, not one row at a time — see the RLS gotcha below for why.

### 5. Immutability / audit log
Edits and deletes never destructively overwrite financial data. Expenses use soft-delete (`deletedAt`), and every create/edit/delete writes an append-only `AuditLogEntry`. The Postgres `audit_log` table has no `UPDATE`/`DELETE` RLS policy at all — immutability is enforced at the database level, not just by convention.

### 6. Approval-gated group membership
Joining a group by code doesn't grant immediate access. `join_group_by_code()` (a `SECURITY DEFINER` Postgres function) inserts a `pending` membership row; the group creator must explicitly approve it before that member can see any group data. This is why the client never gets direct `SELECT` access to `groups.join_code` — code lookups are proxied through the RPC.

## ⚠️ Important gotcha: RLS + upsert ordering

**Postgres RLS evaluates both INSERT and UPDATE (and an implicit SELECT for conflict detection) policies on any `INSERT ... ON CONFLICT DO UPDATE` statement — even when the row is a genuine first-time insert with no real conflict.**

We hit this hard: when a user creates a *new* group, our sync engine pushes it via `upsert()`. The group's `UPDATE` and `SELECT` RLS policies originally checked `is_group_creator()`/`is_approved_member()`, which look up the `members` table — but the creator's own membership row hasn't synced yet at that point (it's a separate queued entry). Circular dependency, silent 403.

**Fix:** any table using `upsert()` from the client needs its INSERT, UPDATE, *and* SELECT policies to all independently allow the "I own this row" case (e.g. `created_by = auth.uid()`), without depending on a lookup into another not-yet-synced table. See `supabase/migrations/` for the corrected policies on `groups` and `members`.

If you add new syncable tables, replicate this pattern from day one — it's much cheaper to design for than to debug later.

## Project Setup

```bash
# 1. Scaffold
npx sv create expense-splitter-pwa
cd expense-splitter-pwa

# 2. Install dependencies
npm install tailwindcss @tailwindcss/vite
npm install dexie
npm install @supabase/supabase-js
npm install -D @vite-pwa/sveltekit vite-plugin-pwa workbox-window
npm install uuid date-fns
npm install -D @types/uuid vitest prettier eslint supabase
npm install @fontsource-variable/fraunces @fontsource/instrument-sans @fontsource/ibm-plex-mono

# 3. Link Supabase project
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations/*.sql

# 4. Generate types from the live schema
npx supabase gen types typescript --project-id <your-project-ref> > src/lib/supabase/types.ts

# 5. Environment variables — create .env at project root:
#    PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
#    PUBLIC_SUPABASE_ANON_KEY=<publishable key>

# 6. Run
npm run dev
```

**Critical:** `vite.config.ts` must register the Tailwind plugin (`tailwindcss()` in the `plugins` array) — installing the npm packages alone does not wire it into the build.

## Data Model

### Dexie (local, `src/lib/db/schema.ts`) — 6 tables
`groups`, `members`, `expenses`, `splits`, `auditLog`, `syncQueue`. Every syncable record carries a `syncStatus: 'synced' | 'pending' | 'conflict'` field. Soft-deletes use `deletedAt: string | null`, never hard deletes.

### Supabase (remote, `supabase/migrations/0001_init.sql`) — mirrors Dexie 1:1
Field names are `snake_case` remotely, `camelCase` locally; `src/lib/sync/mappers.ts` is the single source of truth for translating between them in both directions. Client-generated UUIDs (`crypto.randomUUID()`) are used everywhere — the same ID exists in Dexie and Postgres from the moment of creation, no reconciliation needed.

## Feature Status

| Feature | Status |
|---|---|
| Group creation, join-by-code, approval flow | ✅ |
| Equal / percentage / custom expense splitting | ✅ |
| Debt simplification (greedy min-cash-flow) | ✅ |
| Live balance & settle-up views | ✅ |
| Offline logging with instant local UI updates | ✅ |
| Background sync (push + pull, retry/backoff) | ✅ |
| PWA manifest, install, offline fallback page | ⏳ not yet built |
| Edit/delete expense UI | ⏳ `deleteExpenseLocal()` exists, no button wired up yet |

## Project Structure

```
src/
├── lib/
│   ├── db/            # Dexie schema, types, atomic write helpers
│   ├── supabase/       # Supabase client + generated types
│   ├── sync/           # Outbox queue, push/pull engine, field mappers
│   ├── ledger/         # Split engine, debt simplifier, balance calculator
│   ├── components/     # TopBar, GroupBottomNav
│   └── utils/           # liveQuery Svelte-runes wrapper
├── routes/
│   ├── login/
│   ├── groups/
│   │   ├── new/         # Create group
│   │   ├── join/        # Join by code
│   │   └── [groupId]/
│   │       ├── +page.svelte           # Balances + pending approvals
│   │       ├── expenses/               # List + new
│   │       └── settle/                 # Debt simplification results
│   └── +page.svelte     # Group list (dashboard)
supabase/
└── migrations/          # SQL schema, RLS policies, RPC functions
tests/                    # Vitest unit tests (26 passing: split engine, balances, debt simplifier)
```

## Design System

- **Palette**: pale ledger-green paper (`#ECF0E6`), forest-green credit (`#2E6B4F`), brick-red debit (`#B23A2E`), brass accent (`#C08829`) — grounded in the aesthetic of old accounting ledger books, not a generic fintech look.
- **Type**: Fraunces (serif) reserved *only* for money amounts and headlines; Instrument Sans for UI; IBM Plex Mono for system/data (sync status, join codes, timestamps).
- **Signature element**: a dashed "stub tear" divider (`.stub-tear` in `app.css`) styled after a checkbook perforation, used to separate summary from detail.

## Testing

```bash
npm run test    # Vitest — 26 tests across splitEngine, balances, debtSimplifier
npm run check   # svelte-check — TypeScript + Svelte diagnostics
```

## Known Gaps / Next Steps

1. **PWA service worker + manifest** — needed for genuine offline testing (dev-server "offline" simulation blocks route-chunk fetches, giving false negatives) and installability.
2. **Edit/delete expense UI** — backend logic exists, no UI trigger yet.
3. **Multi-currency handling** — `currency` is stored per-group and per-expense but not actively validated/converted.
