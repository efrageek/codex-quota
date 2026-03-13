/**
 * Factory token refresh and multi-store persistence.
 * Depends on: lib/constants.js, lib/jwt.js, lib/token-match.js, lib/container.js, lib/fs.js, lib/factory-crypto.js
 */

import { existsSync } from "node:fs";
import {
	FACTORY_API_BASE,
	FACTORY_MULTI_ACCOUNT_PATH,
	FACTORY_AUTH_FILE_PATH,
	FACTORY_AUTH_KEY_PATH,
	FACTORY_OAUTH_REFRESH_BUFFER_MS,
	FACTORY_TIMEOUT_MS,
} from "./constants.js";
import { normalizeEntryTokens, updateEntryTokens, FACTORY_TOKEN_FIELDS } from "./token-match.js";
import { readMultiAccountContainer, writeMultiAccountContainer, mapContainerAccounts } from "./container.js";
import { writeAuthV2Files } from "./factory-crypto.js";
import { decodeJWT } from "./jwt.js";

// ─────────────────────────────────────────────────────────────────────────────
// Token Expiry Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a Factory JWT is expired or about to expire within the buffer window.
 * Checks the `exp` claim from the JWT payload if expiresAt is not provided.
 * @param {string | null} accessToken - JWT access token
 * @param {number | null} [expiresAt] - Explicit expiry timestamp in ms (overrides JWT exp)
 * @returns {boolean} True if token is expired or expiring within buffer
 */
export function isFactoryTokenExpiring(accessToken, expiresAt) {
	// If explicit expiresAt is provided, use it
	if (typeof expiresAt === "number" && expiresAt > 0) {
		return expiresAt <= Date.now() + FACTORY_OAUTH_REFRESH_BUFFER_MS;
	}

	// Fall back to JWT exp claim
	if (!accessToken) return true;
	const payload = decodeJWT(accessToken);
	if (!payload?.exp) return true;

	// JWT exp is in seconds, convert to ms
	const expiresMs = payload.exp * 1000;
	return expiresMs <= Date.now() + FACTORY_OAUTH_REFRESH_BUFFER_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh a Factory OAuth token using the refresh token.
 * POSTs to Factory's token refresh endpoint with grant_type=refresh_token.
 * @param {string} refreshToken - The refresh token
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number } | { error: string }>}
 */
export async function refreshFactoryToken(refreshToken) {
	if (!refreshToken) {
		return { error: "No refresh token available" };
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FACTORY_TIMEOUT_MS);

	try {
		const res = await fetch(`${FACTORY_API_BASE}/api/v1/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			let detail = "";
			try {
				const body = await res.json();
				detail = body?.detail ?? body?.message ?? "";
			} catch {
				try {
					detail = await res.text();
				} catch {
					// ignore
				}
			}
			const msg = detail
				? `Token refresh failed: HTTP ${res.status}: ${String(detail).slice(0, 200)}`
				: `Token refresh failed: HTTP ${res.status}`;
			return { error: msg };
		}

		let body;
		try {
			body = await res.json();
		} catch {
			return { error: "Token refresh failed: invalid JSON response" };
		}

		if (!body?.access_token) {
			return { error: "Token refresh failed: missing access_token in response" };
		}

		return {
			access_token: body.access_token,
			refresh_token: body.refresh_token ?? refreshToken,
			expires_in: body.expires_in ?? 3600,
		};
	} catch (e) {
		const message = e.name === "AbortError" ? "Token refresh timed out" : e.message;
		return { error: message };
	} finally {
		clearTimeout(timeout);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist refreshed Factory tokens to all matching stores.
 * Updates the container file and writes auth.v2 files if this is the active account.
 * @param {{ label: string, accessToken: string, refreshToken?: string | null, expiresAt?: number | null, accountId: string, source?: string }} account
 * @param {Array<object>} allAccounts - All loaded Factory accounts (for matching)
 * @param {{ containerPath?: string, authFilePath?: string, keyFilePath?: string }} [options]
 * @returns {{ updatedPaths: string[], errors: string[] }}
 */
export function persistFactoryTokens(account, allAccounts, options = {}) {
	const updatedPaths = [];
	const errors = [];

	const containerPath = options.containerPath ?? FACTORY_MULTI_ACCOUNT_PATH;
	const authFilePath = options.authFilePath ?? FACTORY_AUTH_FILE_PATH;
	const keyFilePath = options.keyFilePath ?? FACTORY_AUTH_KEY_PATH;

	// Skip persistence for env-sourced accounts
	if (account.source?.startsWith("env")) {
		return { updatedPaths, errors };
	}

	// 1. Update the multi-account container file
	if (existsSync(containerPath)) {
		try {
			const container = readMultiAccountContainer(containerPath);
			if (container.rootType === "invalid") {
				errors.push(`Failed to parse ${containerPath}`);
			} else {
				const mapped = mapContainerAccounts(container, (entry) => {
					if (!entry || typeof entry !== "object") return entry;
					// Match by label (Factory uses label-based matching in the container)
					if (!entry.label || entry.label !== account.label) return entry;
					return updateEntryTokens({ ...entry }, {
						access: account.accessToken,
						refresh: account.refreshToken ?? null,
						expires: account.expiresAt ?? null,
						accountId: account.accountId,
					}, FACTORY_TOKEN_FIELDS);
				});

				if (mapped.updated) {
					writeMultiAccountContainer(containerPath, container, mapped.accounts, {}, { mode: 0o600 });
					updatedPaths.push(containerPath);
				}
			}
		} catch (err) {
			const message = err?.message ?? String(err);
			errors.push(`Failed to update ${containerPath}: ${message}`);
		}
	}

	// 2. Write auth.v2 files if this is the active account
	const activeLabel = (() => {
		try {
			const container = readMultiAccountContainer(containerPath);
			return container.activeLabel ?? null;
		} catch {
			return null;
		}
	})();

	if (activeLabel && activeLabel === account.label) {
		try {
			const data = {
				access_token: account.accessToken,
				refresh_token: account.refreshToken ?? null,
			};
			const result = writeAuthV2Files(authFilePath, keyFilePath, data);
			if (result.success) {
				updatedPaths.push(authFilePath);
			} else if (result.error) {
				errors.push(`Failed to write auth.v2 files: ${result.error}`);
			}
		} catch (err) {
			const message = err?.message ?? String(err);
			errors.push(`Failed to write auth.v2 files: ${message}`);
		}
	}

	return { updatedPaths, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure Fresh Token (main entry point)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a Factory account has a fresh access token, refreshing and persisting if needed.
 * If the JWT is expired or expiring within the buffer window, attempts a refresh.
 * On refresh failure, returns false but does NOT corrupt existing account data.
 * @param {{ label: string, accessToken?: string | null, refreshToken?: string | null, expiresAt?: number | null, accountId: string, apiKey?: string | null, source?: string }} account
 * @param {Array<object>} allAccounts - All loaded Factory accounts
 * @param {{ containerPath?: string, authFilePath?: string, keyFilePath?: string }} [options]
 * @returns {Promise<boolean>} True if token is fresh (or refresh succeeded), false if refresh failed
 */
export async function ensureFreshFactoryToken(account, allAccounts, options = {}) {
	const accessToken = account.accessToken ?? account.access_token ?? null;
	const expiresAt = account.expiresAt ?? account.expires_at ?? null;

	// If token is not expiring, skip refresh
	if (!isFactoryTokenExpiring(accessToken, expiresAt)) {
		return true;
	}

	// No refresh token — cannot refresh
	const refreshToken = account.refreshToken ?? account.refresh_token ?? null;
	if (!refreshToken) {
		// If we have an API key, the account can still work for quota
		return Boolean(account.apiKey);
	}

	// Attempt refresh
	const result = await refreshFactoryToken(refreshToken);
	if (result.error) {
		// Refresh failed — account can still work if it has an API key
		return Boolean(account.apiKey);
	}

	// Update account object in-place with new tokens
	account.accessToken = result.access_token;
	account.refreshToken = result.refresh_token;
	account.expiresAt = Date.now() + result.expires_in * 1000;

	// Extract updated accountId from new JWT if available
	const newPayload = decodeJWT(result.access_token);
	if (newPayload?.sub) {
		account.accountId = newPayload.sub;
	}

	// Persist to all matching stores
	persistFactoryTokens(account, allAccounts, options);

	return true;
}
