/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Caches an async lookup by key for a short time. Concurrent calls for the
 * same key share one promise, so a burst of requests runs the lookup once.
 */
export function memoizeAsync<T>(lookup: (key: string) => Promise<T>, options: { ttlMs: number; maxEntries: number; now?: () => number }): (key: string) => Promise<T> {
	const now = options.now ?? Date.now;
	const entries = new Map<string, { value: Promise<T>; expires: number }>();
	return key => {
		const time = now();
		const cached = entries.get(key);
		if (cached && cached.expires > time) {
			return cached.value;
		}
		const value = lookup(key);
		entries.delete(key);
		entries.set(key, { value, expires: time + options.ttlMs });
		// A failed lookup is not cached.
		value.catch(() => entries.get(key)?.value === value && entries.delete(key));
		while (entries.size > options.maxEntries) {
			entries.delete(entries.keys().next().value!);
		}
		return value;
	};
}
