export async function fetchProxxOpenAiQuota(options = {}) {
	const fetchFn = options.fetchFn ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
	const baseUrl = typeof options.baseUrl === "string" && options.baseUrl.trim().length > 0
		? options.baseUrl.trim().replace(/\/+$/, "")
		: "http://localhost:8789";
	const url = new URL("/api/v1/credentials/openai/quota", baseUrl);
	if (typeof options.accountId === "string" && options.accountId.trim().length > 0) {
		url.searchParams.set("accountId", options.accountId.trim());
	}

	try {
		const headers = { accept: "application/json" };
		if (typeof options.authToken === "string" && options.authToken.trim().length > 0) {
			headers.authorization = `Bearer ${options.authToken.trim()}`;
		}

		const response = await fetchFn(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return { success: false, error: text.trim() || `HTTP ${response.status}`, status: response.status };
		}

		const payload = await response.json();
		return { success: true, data: payload };
	} catch (error) {
		return { success: false, error: error?.message ?? String(error) };
	} finally {
		clearTimeout(timeout);
	}
}

export function formatProxxQuotaResponse(payload) {
	const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
	return accounts.map((account) => ({
		label: account.displayName ?? account.accountId ?? "unknown",
		usage: account,
	}));
}
