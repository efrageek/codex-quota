/**
 * Factory usage API fetch and billing period calculation.
 * Depends on: lib/constants.js
 */

import { FACTORY_USAGE_URL, FACTORY_TIMEOUT_MS } from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Billing Period Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the billing period (start/end dates) containing `now` based on billing day.
 * billingDay defaults to 1 (1st of each month). Handles day 31 in short months
 * by clamping to the last day of the month, and year boundaries (Dec→Jan).
 * @param {number} [billingDay=1] - Day of month when billing period starts (1–31)
 * @param {Date} [now=new Date()] - Reference date
 * @returns {{ start: string, end: string } | { error: string }}
 */
export function computeBillingPeriod(billingDay, now) {
	const day = billingDay ?? 1;
	if (typeof day !== "number" || !Number.isFinite(day)) {
		return { error: `Invalid billing day: ${billingDay}` };
	}
	if (day <= 0 || day > 31) {
		return { error: `Invalid billing day: ${day} (must be 1–31)` };
	}

	const ref = now ?? new Date();
	const year = ref.getFullYear();
	const month = ref.getMonth(); // 0-based

	// Clamp billingDay to the last day of a given month
	const clampDay = (y, m, d) => {
		// Day 0 of next month = last day of current month
		const lastDay = new Date(y, m + 1, 0).getDate();
		return Math.min(d, lastDay);
	};

	// Determine the billing period start that contains `ref`
	const clampedThisMonth = clampDay(year, month, day);
	const refDay = ref.getDate();

	let startYear, startMonth;
	if (refDay >= clampedThisMonth) {
		// Current billing period started this month
		startYear = year;
		startMonth = month;
	} else {
		// Current billing period started last month
		if (month === 0) {
			startYear = year - 1;
			startMonth = 11; // December
		} else {
			startYear = year;
			startMonth = month - 1;
		}
	}

	const clampedStart = clampDay(startYear, startMonth, day);
	const startDate = new Date(startYear, startMonth, clampedStart);

	// End date is the day before the next billing period starts
	let endYear, endMonth;
	if (startMonth === 11) {
		endYear = startYear + 1;
		endMonth = 0; // January
	} else {
		endYear = startYear;
		endMonth = startMonth + 1;
	}
	const clampedEnd = clampDay(endYear, endMonth, day);
	const endDate = new Date(endYear, endMonth, clampedEnd);
	endDate.setDate(endDate.getDate() - 1);

	const fmt = (d) => {
		const yy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		return `${yy}-${mm}-${dd}`;
	};

	return { start: fmt(startDate), end: fmt(endDate) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily Token Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sum billable_tokens across all days in the API response data array.
 * @param {Array<{ billable_tokens: number }>} data - Array of daily token entries
 * @returns {number}
 */
export function sumDailyTokens(data) {
	if (!Array.isArray(data)) return 0;
	return data.reduce((sum, day) => sum + (day?.billable_tokens ?? 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Breakdown Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate by_model across all days in the API response data array.
 * Returns a map of model_id → total billable_tokens.
 * @param {Array<{ by_model?: Array<{ model_id: string, billable_tokens: number }> }>} data
 * @returns {Array<{ model_id: string, billable_tokens: number }>}
 */
export function extractModelBreakdown(data) {
	if (!Array.isArray(data)) return [];

	const modelMap = new Map();
	for (const day of data) {
		if (!Array.isArray(day?.by_model)) continue;
		for (const model of day.by_model) {
			if (!model?.model_id) continue;
			const existing = modelMap.get(model.model_id) ?? 0;
			modelMap.set(model.model_id, existing + (model.billable_tokens ?? 0));
		}
	}

	return [...modelMap.entries()]
		.map(([model_id, billable_tokens]) => ({ model_id, billable_tokens }))
		.sort((a, b) => b.billable_tokens - a.billable_tokens);
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Usage Fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Factory usage from the Analytics API.
 * Auth: prefer access_token (JWT) from account, fall back to apiKey field.
 * Returns structured usage data including billing period, per-model breakdown, and totals.
 * @param {object} account - Factory account object with accessToken and/or apiKey
 * @param {object} [options] - Options
 * @param {number} [options.billingDay=1] - Day of month when billing period starts
 * @param {Date} [options.now] - Reference date (defaults to new Date())
 * @returns {Promise<{ success: boolean, usage?: object, error?: string }>}
 */
export async function fetchFactoryUsage(account, options = {}) {
	const billingDay = options.billingDay ?? 1;
	const period = computeBillingPeriod(billingDay, options.now);
	if (period.error) {
		return { success: false, error: period.error };
	}

	// Determine auth token: prefer JWT (accessToken), fall back to apiKey
	const authToken = account?.accessToken ?? account?.access_token ?? account?.apiKey ?? null;
	if (!authToken) {
		return { success: false, error: "No authentication token available" };
	}

	const url = `${FACTORY_USAGE_URL}?startDate=${period.start}&endDate=${period.end}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FACTORY_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${authToken}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			let detail = "";
			try {
				const body = await res.json();
				detail = body?.detail ?? body?.title ?? "";
			} catch {
				try {
					detail = await res.text();
				} catch {
					// ignore
				}
			}
			const msg = detail
				? `HTTP ${res.status}: ${String(detail).slice(0, 200)}`
				: `HTTP ${res.status}`;
			return { success: false, error: msg };
		}

		let body;
		try {
			body = await res.json();
		} catch {
			return { success: false, error: "Invalid JSON response" };
		}

		const data = body?.data ?? [];
		const used = sumDailyTokens(data);
		const limit = account?.planLimit ?? 0;
		const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
		const byModel = extractModelBreakdown(data);

		return {
			success: true,
			usage: {
				used,
				limit,
				percent,
				billingPeriod: period,
				byModel,
				data,
			},
		};
	} catch (e) {
		const message = e.name === "AbortError" ? "Request timed out" : e.message;
		return { success: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}
