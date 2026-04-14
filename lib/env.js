/**
 * Zero-dependency .env loader for codex-quota.
 * Loads ~/.codex-quota.env into process.env (does not override existing vars).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_FILE_PATH = join(homedir(), ".codex-quota.env");

let loaded = false;

/**
 * Load ~/.codex-quota.env once. Existing env vars are never overridden.
 */
export function loadEnvFile() {
	if (loaded) return;
	loaded = true;

	let raw;
	try {
		raw = readFileSync(ENV_FILE_PATH, "utf-8");
	} catch {
		return; // File missing or unreadable — silently skip
	}

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let value = trimmed.slice(eqIdx + 1).trim();
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

export { ENV_FILE_PATH };
