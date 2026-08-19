/// <reference lib="webworker" />
// This file is compiled by SvelteKit itself (via @vite-pwa/sveltekit's
// injectManifest delegation) rather than by workbox-build directly, so it
// needs the ambient ServiceWorkerGlobalScope type rather than relying on
// vite-plugin-pwa's own worker tsconfig.
declare let self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

// --- Standard asset precaching -------------------------------------------
// self.__WB_MANIFEST is replaced at build time with the list of hashed
// JS/CSS/font/icon files. This part works fine with the normal Workbox
// flow because those files exist in `.svelte-kit/output/client` *during*
// the Vite build, before the adapter ever runs.
const manifestEntries = self.__WB_MANIFEST;
precacheAndRoute(Array.isArray(manifestEntries) ? manifestEntries : []);
cleanupOutdatedCaches();

self.skipWaiting();
clientsClaim();

// --- SPA app-shell fallback (the actual fix) ------------------------------
// WHY THIS EXISTS: this app is a pure SPA (ssr = false, prerender = false
// everywhere), and adapter-static's fallback `index.html` is written to
// `build/` *after* SvelteKit hands off to the adapter — which is *after*
// this service worker's precache manifest has already been generated.
// That means no literal HTML file is ever available for Workbox's
// build-time-verified `navigateFallback` option to point at; using it
// throws "non-precached-url" the moment any navigation is attempted,
// whether offline or online (we hit this twice: once pointing at
// `/offline`, once at `/index.html` — same root cause both times).
//
// The fix: don't rely on the precache manifest for the shell at all.
// Instead, lazily cache the shell HTML in a *runtime* cache the first
// time it's actually fetched (which happens naturally on first load,
// while online), then serve that cached copy for every subsequent
// navigation — including deep links that were never precached, like
// /groups/<id> reloaded while offline. The client-side SvelteKit router
// takes it from there using data already synced into Dexie.
const APP_SHELL_CACHE = 'app-shell';
const APP_SHELL_URL = '/';

// Seed the shell into the cache as soon as the SW installs — don't wait for
// a live navigation to populate it. A service worker can never intercept
// the very first navigation that causes it to be installed (this is a
// fundamental browser rule, not a bug), so if that first navigation lands
// on e.g. /login and everything after is client-side routing (normal for
// an SPA), a purely lazy cache-on-navigate approach never gets a chance to
// run and the shell cache stays empty forever — confirmed via a real
// offline test: the fallback's own fetch() throws uncaught with nothing
// cached to fall back to. install fires right after the SW script is
// downloaded, normally while still online, so this reliably seeds it.
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(APP_SHELL_CACHE)
			.then((cache) => cache.add(APP_SHELL_URL))
			.catch(() => {
				// If install happens to run offline (e.g. a repeat install
				// attempt), the live navigate handler below will fill this in
				// on the next successful online visit instead.
			})
	);
});

registerRoute(
	new NavigationRoute(
		async ({ request }) => {
			const cache = await caches.open(APP_SHELL_CACHE);

			try {
				// Prefer a fresh copy when we genuinely have network — keeps the
				// shell from ever going stale for someone who's just on a slow
				// connection rather than truly offline.
				const fresh = await fetch(APP_SHELL_URL);
				if (fresh && fresh.ok) {
					cache.put(APP_SHELL_URL, fresh.clone());
					return fresh;
				}
			} catch {
				// Network unavailable — fall through to cache below.
			}

			const cached = await cache.match(APP_SHELL_URL);
			if (cached) return cached;

			// Last-resort safety net: install-time seeding above should make
			// this unreachable in practice, but if it's ever hit, return a
			// real Response instead of letting fetch() throw — an uncaught
			// rejection here surfaces to the user as Chrome's own hard
			// "ERR_FAILED" page, which is a worse failure mode than a plain
			// offline message we control.
			try {
				return await fetch(request);
			} catch {
				return new Response(
					'<!doctype html><title>Offline</title><p>You\u2019re offline and this page hasn\u2019t been cached yet. Reconnect and reload once to enable full offline access.</p>',
					{ status: 200, headers: { 'Content-Type': 'text/html' } }
				);
			}
		},
		{
			// Don't intercept real backend calls — only same-origin page
			// navigations should ever hit this handler.
			denylist: [/^\/api/, /^\/auth/]
		}
	)
);

// --- Supabase API runtime caching ------------------------------------------
// Try the network first since this is live financial data; only fall back
// to a short-lived cache if the network genuinely fails.
registerRoute(
	({ url }) => url.hostname.endsWith('.supabase.co'),
	new NetworkFirst({
		cacheName: 'supabase-api-cache',
		networkTimeoutSeconds: 8
	})
);
