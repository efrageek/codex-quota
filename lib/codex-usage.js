/**
 * Codex usage API fetch.
 * Depends on: lib/constants.js
 */

import { RESET_CREDITS_URL, USAGE_URL } from "./constants.js";

/**
 * Fetch JSON from a Codex backend endpoint for one account.
 * @param {string} url - Backend endpoint URL
 * @param {object} account - Codex account
 * @param {object} [extraHeaders] - Endpoint-specific headers
 * @returns {Promise<object>}
 */
async function fetchCodexJson(url, account, extraHeaders = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	const headers = {
		Authorization: `Bearer ${account.access}`,
		accept: "application/json",
		originator: "codex_cli_rs",
		...extraHeaders,
	};
	if (account.accountId) {
		headers["chatgpt-account-id"] = account.accountId;
	}

	try {
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!res.ok) {
			return { error: `HTTP ${res.status}` };
		}
		return await res.json();
	} catch (e) {
		return { error: e.message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Fetch detailed banked reset credits for a Codex account.
 * @param {object} account - Codex account
 * @returns {Promise<object>}
 */
export async function fetchResetCredits(account) {
	return fetchCodexJson(RESET_CREDITS_URL, account, {
		"OpenAI-Beta": "codex-1",
		originator: "Codex Desktop",
	});
}

/**
 * Add detailed reset credits to the ordinary usage payload without discarding
 * summary fields already returned by the usage endpoint.
 * @param {object} usage - Usage endpoint payload
 * @param {object} resetCredits - Reset-credit endpoint payload
 * @returns {object}
 */
export function mergeResetCredits(usage, resetCredits) {
	if (!usage || usage.error || !resetCredits || resetCredits.error) return usage;

	const usageRoot = usage.usage && typeof usage.usage === "object" ? usage.usage : usage;
	const existing = usageRoot.rate_limit_reset_credits;
	const merged = {
		...(existing && typeof existing === "object" ? existing : {}),
		...resetCredits,
	};

	if (usageRoot === usage) {
		return { ...usage, rate_limit_reset_credits: merged };
	}
	return { ...usage, usage: { ...usageRoot, rate_limit_reset_credits: merged } };
}

/**
 * Fetch Codex quota usage and enrich it with detailed banked reset credits.
 * Reset-credit failures do not hide otherwise valid quota usage.
 * @param {object} account - Codex account
 * @returns {Promise<object>}
 */
export async function fetchUsage(account) {
	const [usage, resetCredits] = await Promise.all([
		fetchCodexJson(USAGE_URL, account),
		fetchResetCredits(account),
	]);
	return mergeResetCredits(usage, resetCredits);
}
