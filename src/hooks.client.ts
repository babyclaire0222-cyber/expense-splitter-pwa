// src/hooks.client.ts
import { startSyncEngine } from '$lib/sync/syncEngine';
import { initDB } from '$lib/db';

// No manual service worker registration here — SvelteKit auto-injects its
// own registration snippet into app.html whenever src/service-worker.ts
// exists (a native SvelteKit feature, independent of @vite-pwa/sveltekit).
// Confirmed via direct inspection of the served HTML. Registering manually
// here too caused two competing registrations — the native snippet's
// relative service-worker.js path is what threw the "failed to register...
// wrong scope" error on nested routes; paths.relative: false in
// vite.config.ts fixes that at the source instead.

// Runs once when the app boots in the browser. Opens Dexie, then starts
// listening for 'online' events and does an initial pull+push.
await initDB();
startSyncEngine();