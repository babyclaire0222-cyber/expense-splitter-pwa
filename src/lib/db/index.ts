// src/lib/db/index.ts
import { db } from './schema';

export { db } from './schema';
export * from './types';

/**
 * Call once on app startup (e.g. in root +layout.ts) to ensure the DB
 * is open and ready before any component tries to query it.
 */
export async function initDB(): Promise<void> {
	if (!db.isOpen()) {
		await db.open();
	}
}