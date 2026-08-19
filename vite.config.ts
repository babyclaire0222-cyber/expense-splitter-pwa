import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({
				pages: 'build',
				assets: 'build',
				fallback: 'index.html',
				precompress: false,
				strict: true
			})
		}),
		SvelteKitPWA({
			// generateSW's navigateFallback can never work correctly here: it's
			// validated against the precache manifest at build time, but
			// adapter-static's index.html doesn't exist until *after* that
			// manifest is generated (SvelteKit builds the SW before handing off
			// to the adapter). Confirmed via two direct hits of the
			// "non-precached-url" crash. injectManifest + a hand-written
			// src/service-worker.ts sidesteps this by caching the shell at
			// runtime instead of relying on a build-time-verified entry.
			strategies: 'injectManifest',
			// hooks.client.ts already registers the worker manually with the
			// correct absolute path. Without this, the plugin ALSO injects its
			// own registerSW.js bootstrap into app.html's <head>, which
			// registers using a relative path — confirmed to resolve wrong on
			// nested routes (e.g. /groups/<id>/service-worker.js instead of
			// /service-worker.js), throwing a real registration error.
			injectRegister: false,
			injectManifest: {
				// Default globPatterns already correctly precache
				// client/**/*.{js,css,ico,png,svg,webp,webmanifest} — those files
				// genuinely do exist at manifest-generation time, unlike the
				// adapter-generated HTML. No override needed here.
			},
			manifest: {
				name: 'Tally - Expense Splitter',
				short_name: 'Tally',
				description: 'Offline-first group expense splitting',
				theme_color: '#C08829',
				background_color: '#ECF0E6',
				display: 'standalone',
				start_url: '/',
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: '/icons/icon-192-maskable.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'maskable'
					},
					{
						src: '/icons/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					},
					{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
				]
			},
			devOptions: {
				enabled: false
			}
		})
	]
});