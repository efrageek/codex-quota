/**
 * Factory account loading, dedup, active-label resolution.
 * Depends on: lib/constants.js, lib/jwt.js, lib/container.js, lib/factory-crypto.js
 */

import {
	FACTORY_MULTI_ACCOUNT_PATH,
	FACTORY_AUTH_FILE_PATH,
	FACTORY_AUTH_KEY_PATH,
} from "./constants.js";
import { decodeJWT } from "./jwt.js";
import { readMultiAccountContainer } from "./container.js";
import { readAuthV2Files } from "./factory-crypto.js";

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a Factory account has required fields.
 * @param {object} account
 * @returns {boolean}
 */
export function isValidFactoryAccount(account) {
	return Boolean(account?.label && account?.accountId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Loading — Environment Variable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load Factory accounts from FACTORY_ACCOUNTS environment variable.
 * Supports both JSON array and { accounts: [...] } formats.
 * @returns {Array<object>}
 */
export function loadFactoryAccountsFromEnv() {
	const envAccounts = process.env.FACTORY_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(isValidFactoryAccount)
			.map(a => ({ ...a, source: "env" }));
	} catch {
		console.error("Warning: FACTORY_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Loading — Container File
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load Factory accounts from a multi-account JSON container file.
 * @param {string} [filePath] - Path to the container file (defaults to FACTORY_MULTI_ACCOUNT_PATH)
 * @returns {Array<object>}
 */
export function loadFactoryAccountsFromFile(filePath) {
	const targetPath = filePath ?? FACTORY_MULTI_ACCOUNT_PATH;
	const container = readMultiAccountContainer(targetPath);
	if (!container.exists) return [];
	return container.accounts
		.filter(isValidFactoryAccount)
		.map(a => ({ ...a, source: targetPath }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Loading — auth.v2 Fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a Factory account profile from a WorkOS-issued JWT.
 * WorkOS JWT claims: email, org_id, sub, first_name, last_name, role, exp, iat.
 * @param {string} accessToken - JWT access token
 * @returns {{ email: string | null, org: string | null, name: string | null, accountId: string | null }}
 */
export function extractFactoryProfile(accessToken) {
	const payload = decodeJWT(accessToken);
	if (!payload) return { email: null, org: null, name: null, accountId: null };

	const email = payload.email ?? null;
	const org = payload.org_id ?? null;
	const accountId = payload.sub ?? null;

	const firstName = payload.first_name ?? "";
	const lastName = payload.last_name ?? "";
	const name = [firstName, lastName].filter(Boolean).join(" ") || null;

	return { email, org, name, accountId };
}

/**
 * Load a single Factory account from ~/.factory/auth.v2.file (encrypted JWT fallback).
 * Returns array with single account for consistency with other loaders.
 * @param {string} [authFilePath] - Path to auth.v2.file (defaults to FACTORY_AUTH_FILE_PATH)
 * @param {string} [keyFilePath] - Path to auth.v2.key (defaults to FACTORY_AUTH_KEY_PATH)
 * @returns {Array<object>}
 */
export function loadFactoryAccountFromAuthV2(authFilePath, keyFilePath) {
	const authPath = authFilePath ?? FACTORY_AUTH_FILE_PATH;
	const keyPath = keyFilePath ?? FACTORY_AUTH_KEY_PATH;

	const tokens = readAuthV2Files(authPath, keyPath);
	if (!tokens?.accessToken) return [];

	const profile = extractFactoryProfile(tokens.accessToken);
	if (!profile.accountId) return [];

	return [{
		label: "factory",
		accountId: profile.accountId,
		email: profile.email,
		org: profile.org,
		name: profile.name,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		source: authPath,
	}];
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Loading — Combined
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load ALL Factory accounts from all sources in priority order:
 * (1) FACTORY_ACCOUNTS env var, (2) ~/.factory-accounts.json, (3) auth.v2 fallback.
 * Deduplicates by accountId (sub claim), keeping the first occurrence.
 * @returns {Array<object>}
 */
export function loadAllFactoryAccounts() {
	const all = [];
	all.push(...loadFactoryAccountsFromEnv());
	all.push(...loadFactoryAccountsFromFile());
	if (all.length === 0) {
		all.push(...loadFactoryAccountFromAuthV2());
	}
	// Deduplicate by accountId, keeping first occurrence
	const seen = new Set();
	return all.filter(account => {
		const id = account.accountId;
		if (!id) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Active Label & Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the activeLabel from the Factory multi-account container.
 * @param {string} [filePath] - Path to the container file (defaults to FACTORY_MULTI_ACCOUNT_PATH)
 * @returns {string | null}
 */
export function getFactoryActiveLabel(filePath) {
	const targetPath = filePath ?? FACTORY_MULTI_ACCOUNT_PATH;
	const container = readMultiAccountContainer(targetPath);
	return container.activeLabel ?? null;
}

/**
 * Find a Factory account by label from a given accounts array.
 * @param {Array<object>} accounts
 * @param {string} label
 * @returns {object | null}
 */
export function findFactoryAccountByLabel(accounts, label) {
	if (!Array.isArray(accounts) || !label) return null;
	return accounts.find(a => a.label === label) ?? null;
}

/**
 * Get all unique labels from a given accounts array.
 * @param {Array<object>} accounts
 * @returns {string[]}
 */
export function getAllFactoryLabels(accounts) {
	if (!Array.isArray(accounts)) return [];
	return [...new Set(accounts.map(a => a.label).filter(Boolean))];
}
