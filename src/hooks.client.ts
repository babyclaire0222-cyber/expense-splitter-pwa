// src/hooks.client.ts
import { startSyncEngine } from '$lib/sync/syncEngine';
import { initDB } from '$lib/db';

// Runs once when the app boots in the browser. Opens Dexie, then starts
// listening for 'online' events and does an initial pull+push.
await initDB();
startSyncEngine();