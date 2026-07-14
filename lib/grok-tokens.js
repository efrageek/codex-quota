/**
 * SuperGrok / xAI OAuth token refresh with fan-out persistence.
 * Depends on: lib/constants.js, lib/jwt.js, lib/fs.js, lib/token-match.js
 *
 * Hard rule: after rotating a refresh token, write the new tokens to every
 * live store that held the previous refresh (or previous access) so other
 * agents are not left with a dead credential.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	XAI_OAUTH_REFRESH_BUFFER_MS,
	GROK_TIMEOUT_MS,
} from "./constants.js";
import { decodeJWT } from "./jwt.js";
import { writeFileAtomic } from "./fs.js";
import { extractGrokProfile, resolveGrokExpiresAt } from "./grok-accounts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Expiry check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string | null | undefined} accessToken
 * @param {number | null | undefined} expiresAt
 * @param {number} [bufferMs]
 * @returns {boolean}
 */
export function isGrokTokenExpiring(accessToken, expiresAt, bufferMs = XAI_OAUTH_REFRESH_BUFFER_MS) {
	if (typeof expiresAt === "number" && expiresAt > 0) {
		return expiresAt <= Date.now() + bufferMs;
	}
	if (!accessToken) return true;
	const payload = decodeJWT(accessToken);
	if (!payload?.exp) return true;
	return payload.exp * 1000 <= Date.now() + bufferMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh an xAI SuperGrok OAuth access token.
 * @param {string} refreshToken
 * @param {{ tokenEndpoint?: string | null, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number } | { error: string }>}
 */
export async function refreshGrokToken(refreshToken, options = {}) {
	if (!refreshToken) {
		return { error: "No refresh token available" };
	}

	const fetchFn = options.fetchFn ?? fetch;
	const tokenEndpoint = (typeof options.tokenEndpoint === "string" && options.tokenEndpoint.trim())
		? options.tokenEndpoint.trim()
		: XAI_OAUTH_TOKEN_URL;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GROK_TIMEOUT_MS);

	try {
		const res = await fetchFn(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: XAI_OAUTH_CLIENT_ID,
				refresh_token: refreshToken,
			}),
			signal: controller.signal,
		});

		const text = await res.text();
		if (!res.ok) {
			return {
				error: `Token refresh failed: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
			};
		}

		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return { error: "Token refresh failed: invalid JSON response" };
		}

		if (!body?.access_token) {
			return { error: "Token refresh failed: missing access_token in response" };
		}

		return {
			access_token: body.access_token,
			// xAI rotates refresh tokens — always prefer the new one when present
			refresh_token: body.refresh_token ?? refreshToken,
			expires_in: Number(body.expires_in ?? 21600),
		};
	} catch (e) {
		const message = e?.name === "AbortError" ? "Token refresh timed out" : (e?.message ?? String(e));
		return { error: message };
	} finally {
		clearTimeout(timeout);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan-out persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @returns {object | null}
 */
function readJsonObject(filePath) {
	if (!existsSync(filePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Whether a source location should receive the rotated tokens.
 * Prefer exact previous-refresh match so independently rotated sessions are left alone.
 * Fall back to previous-access only when either side lacks a refresh token.
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} source
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} used
 * @returns {boolean}
 */
export function sourceMatchesRotatedTokens(source, used) {
	if (used.previousRefresh && source.previousRefresh) {
		return source.previousRefresh === used.previousRefresh;
	}
	if (used.previousAccess && source.previousAccess && source.previousAccess === used.previousAccess) {
		return true;
	}
	return false;
}

/**
 * Update a pi-style auth.json provider entry in place.
 * @param {object} data
 * @param {string} providerKey
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 * @returns {boolean} whether mutated
 */
function updatePiStyleProvider(data, providerKey, tokens) {
	const entry = data[providerKey];
	if (!entry || typeof entry !== "object") return false;
	entry.access = tokens.accessToken;
	entry.refresh = tokens.refreshToken;
	entry.expires = tokens.expiresAt;
	if (!entry.type) entry.type = "oauth";
	data[providerKey] = entry;
	return true;
}

/**
 * Update OpenCode auth.json xai entry.
 * @param {object} data
 * @param {string} providerKey
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 * @returns {boolean}
 */
function updateOpencodeProvider(data, providerKey, tokens) {
	const key = data[providerKey] ? providerKey : (data.xai ? "xai" : (data["xai-oauth"] ? "xai-oauth" : providerKey));
	const entry = data[key];
	if (!entry || typeof entry !== "object") return false;
	entry.access = tokens.accessToken;
	entry.refresh = tokens.refreshToken;
	entry.expires = tokens.expiresAt;
	if (!entry.type) entry.type = "oauth";
	data[key] = entry;
	return true;
}

/**
 * Update Hermes credential pool + providers.xai-oauth.tokens when matching.
 * @param {object} data
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} used
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, expiresIn?: number }} tokens
 * @returns {boolean}
 */
function updateHermesAuth(data, used, tokens) {
	let mutated = false;

	const pool = data.credential_pool?.["xai-oauth"];
	if (Array.isArray(pool)) {
		for (const entry of pool) {
			if (!entry || typeof entry !== "object") continue;
			const prevAccess = entry.access_token ?? entry.access ?? null;
			const prevRefresh = entry.refresh_token ?? entry.refresh ?? null;
			if (!sourceMatchesRotatedTokens(
				{ previousAccess: prevAccess, previousRefresh: prevRefresh },
				used,
			)) {
				continue;
			}
			entry.access_token = tokens.accessToken;
			entry.refresh_token = tokens.refreshToken;
			entry.last_refresh = new Date().toISOString();
			entry.last_status = "ok";
			mutated = true;
		}
	}

	const provider = data.providers?.["xai-oauth"];
	if (provider && typeof provider === "object") {
		const providerTokens = provider.tokens;
		if (providerTokens && typeof providerTokens === "object") {
			const prevAccess = providerTokens.access_token ?? providerTokens.access ?? null;
			const prevRefresh = providerTokens.refresh_token ?? providerTokens.refresh ?? null;
			if (sourceMatchesRotatedTokens(
				{ previousAccess: prevAccess, previousRefresh: prevRefresh },
				used,
			)) {
				providerTokens.access_token = tokens.accessToken;
				providerTokens.refresh_token = tokens.refreshToken;
				if (typeof tokens.expiresIn === "number") {
					providerTokens.expires_in = tokens.expiresIn;
				}
				providerTokens.token_type = providerTokens.token_type ?? "Bearer";
				provider.tokens = providerTokens;
				provider.last_refresh = new Date().toISOString();
				mutated = true;
			}
		}
	}

	return mutated;
}

/**
 * Persist rotated SuperGrok tokens to every matching live source.
 * Env-sourced accounts are never written.
 * @param {object} account - account with sources[] and pre-refresh previous tokens
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, expiresIn?: number }} tokens
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} used
 * @returns {{ updatedPaths: string[], errors: string[] }}
 */
export function persistGrokTokens(account, tokens, used) {
	const updatedPaths = [];
	const errors = [];

	const sources = Array.isArray(account?.sources) ? account.sources : [];
	// Group by path so each file is rewritten once
	/** @type {Map<string, object[]>} */
	const byPath = new Map();
	for (const source of sources) {
		if (!source?.path || source.kind === "env" || source.path === "env:GROK_ACCOUNTS") continue;
		if (!sourceMatchesRotatedTokens(source, used)) continue;
		const list = byPath.get(source.path) ?? [];
		list.push(source);
		byPath.set(source.path, list);
	}

	for (const [filePath, pathSources] of byPath) {
		try {
			const data = readJsonObject(filePath);
			if (!data) {
				errors.push(`Failed to read ${filePath}`);
				continue;
			}

			let mutated = false;
			for (const source of pathSources) {
				if (source.kind === "pi-auth") {
					mutated = updatePiStyleProvider(data, source.providerKey || "xai-oauth", tokens) || mutated;
				} else if (source.kind === "opencode-auth") {
					mutated = updateOpencodeProvider(data, source.providerKey || "xai", tokens) || mutated;
				} else if (source.kind === "hermes-pool" || source.kind === "hermes-provider") {
					mutated = updateHermesAuth(data, used, tokens) || mutated;
				}
			}

			if (mutated) {
				writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
				updatedPaths.push(filePath);
			}
		} catch (err) {
			errors.push(`Failed to update ${filePath}: ${err?.message ?? String(err)}`);
		}
	}

	return { updatedPaths, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure fresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a Grok account has a fresh access token.
 * On refresh, fan-out writes to every store that held the previous refresh/access.
 * @param {object} account
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, bufferMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, refreshed: boolean, error?: string, updatedPaths?: string[], persistErrors?: string[] }>}
 */
export async function ensureFreshGrokToken(account, options = {}) {
	const accessToken = account.accessToken ?? account.access_token ?? null;
	const expiresAt = account.expiresAt
		?? resolveGrokExpiresAt(account.expires, accessToken);

	if (!isGrokTokenExpiring(accessToken, expiresAt, options.bufferMs)) {
		return { ok: true, refreshed: false };
	}

	const refreshToken = account.refreshToken ?? account.refresh_token ?? null;
	if (!refreshToken) {
		return { ok: false, refreshed: false, error: "No refresh token available" };
	}

	const previousAccess = accessToken;
	const previousRefresh = refreshToken;

	const result = await refreshGrokToken(refreshToken, {
		tokenEndpoint: account.tokenEndpoint,
		fetchFn: options.fetchFn,
		timeoutMs: options.timeoutMs,
	});

	if (result.error) {
		return { ok: false, refreshed: false, error: result.error };
	}

	const newExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 21600)) * 1000;
	const tokens = {
		accessToken: result.access_token,
		refreshToken: result.refresh_token,
		expiresAt: newExpiresAt,
		expiresIn: result.expires_in,
	};

	// Update account object in place
	account.accessToken = tokens.accessToken;
	account.refreshToken = tokens.refreshToken;
	account.expiresAt = tokens.expiresAt;

	const profile = extractGrokProfile(tokens.accessToken);
	if (profile.accountId) account.accountId = profile.accountId;
	if (profile.teamId) account.teamId = profile.teamId;
	if (profile.tier != null) account.tier = profile.tier;
	if (profile.email) account.email = profile.email;

	// Keep sources' previous* as the pre-refresh values for matching, then update them
	const used = { previousAccess, previousRefresh };
	const { updatedPaths, errors } = persistGrokTokens(account, tokens, used);

	// After successful fan-out, update source previous* so a second refresh in-process matches
	if (Array.isArray(account.sources)) {
		for (const source of account.sources) {
			if (sourceMatchesRotatedTokens(source, used)) {
				source.previousAccess = tokens.accessToken;
				source.previousRefresh = tokens.refreshToken;
			}
		}
	}

	if (errors.length && updatedPaths.length === 0) {
		// Refreshed in memory but failed to persist anywhere — dangerous for other agents
		return {
			ok: false,
			refreshed: true,
			error: `Refreshed token but failed to persist: ${errors.join("; ")}`,
			updatedPaths,
			persistErrors: errors,
		};
	}

	return {
		ok: true,
		refreshed: true,
		updatedPaths,
		persistErrors: errors.length ? errors : undefined,
	};
}
