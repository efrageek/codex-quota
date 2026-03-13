#!/usr/bin/env node

/**
 * Standalone Codex quota checker for multiple OAuth accounts
 * Zero dependencies - uses Node.js built-ins only
 *
 * This is a thin entry point. All logic lives in lib/ modules.
 * Barrel re-exports below maintain backward compatibility for tests and consumers.
 */

import { realpathSync } from "node:fs";

// ─── Imports from lib modules ────────────────────────────────────────────────

import { PRIMARY_CMD, MULTI_ACCOUNT_PATHS, CODEX_CLI_AUTH_PATH, CLAUDE_MULTI_ACCOUNT_PATHS } from "./lib/constants.js";
import { GREEN, RED, YELLOW, setNoColorFlag, supportsColor, colorize, getPackageVersion } from "./lib/color.js";
import { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";
import {
	printHelp, printHelpCodex, printHelpClaude, printHelpFactory, printHelpFactoryQuota,
	printHelpAdd, printHelpCodexReauth, printHelpSwitch, printHelpCodexSync,
	printHelpList, printHelpRemove, printHelpQuota,
	printHelpClaudeAdd, printHelpClaudeReauth, printHelpClaudeSwitch, printHelpClaudeSync,
	printHelpClaudeList, printHelpClaudeRemove, printHelpClaudeQuota,
} from "./lib/display.js";
import { handleCodex, handleClaude, handleFactory, handleFactoryQuota, handleQuota } from "./lib/handlers.js";

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);

	// Parse flags
	const flags = {
		json: args.includes("--json"),
		noBrowser: args.includes("--no-browser"),
		noColor: args.includes("--no-color"),
		oauth: args.includes("--oauth"),
		manual: args.includes("--manual"),
		dryRun: args.includes("--dry-run"),
		local: args.includes("--local"),
	};

	// Parse --billing-day flag for Factory quota
	const billingDayIdx = args.indexOf("--billing-day");
	if (billingDayIdx !== -1 && billingDayIdx + 1 < args.length) {
		const raw = args[billingDayIdx + 1];
		const parsed = parseInt(raw, 10);
		if (Number.isFinite(parsed)) {
			flags.billingDay = parsed;
		} else {
			console.error(colorize(`Error: Invalid --billing-day value: ${raw}`, RED));
			process.exit(1);
		}
	}

	// Set global noColorFlag for supportsColor() function
	setNoColorFlag(flags.noColor);

	const legacyFlagUsed = args.includes("--claude") || args.includes("--codex");
	if (legacyFlagUsed) {
		console.error(colorize("Error: --claude/--codex flags were replaced by namespaces.", RED));
		console.error(`Use '${PRIMARY_CMD} claude' or '${PRIMARY_CMD} codex' instead.`);
		process.exit(1);
	}

	// Extract non-flag arguments
	// Filter out flags and their values (e.g., --billing-day N)
	const flagsWithValues = new Set();
	const billingDayArgIdx = args.indexOf("--billing-day");
	if (billingDayArgIdx !== -1 && billingDayArgIdx + 1 < args.length) {
		flagsWithValues.add(billingDayArgIdx + 1);
	}
	const nonFlagArgs = args.filter((a, i) => !a.startsWith("--") && a !== "-h" && !flagsWithValues.has(i));
	const firstArg = nonFlagArgs[0];
	const namespace = firstArg === "codex" || firstArg === "claude" || firstArg === "factory" ? firstArg : null;
	const namespaceArgs = namespace ? nonFlagArgs.slice(1) : nonFlagArgs;
	const subcommand = namespace ? namespaceArgs[0] : null;

	// Handle --version flag
	if (args.includes("--version") || args.includes("-v")) {
		console.log(getPackageVersion());
		return;
	}

	const legacyCommands = ["add", "reauth", "switch", "list", "remove", "quota", "sync"];
	if (!namespace && firstArg && legacyCommands.includes(firstArg)) {
		console.error(colorize(`Error: '${firstArg}' now requires a namespace.`, RED));
		console.error(`Use '${PRIMARY_CMD} codex ${firstArg}' or '${PRIMARY_CMD} claude ${firstArg}'.`);
		process.exit(1);
	}

	// Handle --help: show main help or subcommand-specific help
	if (args.includes("--help") || args.includes("-h")) {
		if (!namespace) {
			printHelp();
			return;
		}
		if (namespace === "codex") {
			switch (subcommand) {
				case "add": printHelpAdd(); break;
				case "reauth": printHelpCodexReauth(); break;
				case "switch": printHelpSwitch(); break;
				case "sync": printHelpCodexSync(); break;
				case "list": printHelpList(); break;
				case "remove": printHelpRemove(); break;
				case "quota": printHelpQuota(); break;
				default: printHelpCodex(); break;
			}
			return;
		}
		if (namespace === "claude") {
			switch (subcommand) {
				case "add": printHelpClaudeAdd(); break;
				case "reauth": printHelpClaudeReauth(); break;
				case "switch": printHelpClaudeSwitch(); break;
				case "sync": printHelpClaudeSync(); break;
				case "list": printHelpClaudeList(); break;
				case "remove": printHelpClaudeRemove(); break;
				case "quota": printHelpClaudeQuota(); break;
				default: printHelpClaude(); break;
			}
			return;
		}
		// namespace === "factory"
		switch (subcommand) {
			case "quota": printHelpFactoryQuota(); break;
			default: printHelpFactory(); break;
		}
		return;
	}

	// Route to appropriate handler based on subcommand
	if (namespace === "codex") {
		await handleCodex(namespaceArgs, flags);
		return;
	}
	if (namespace === "claude") {
		await handleClaude(namespaceArgs, flags);
		return;
	}
	if (namespace === "factory") {
		await handleFactory(namespaceArgs, flags);
		return;
	}

	// Default behavior: run combined quota command
	await handleQuota(nonFlagArgs, flags, "all");
}

// Only run main() when executed directly (not imported for testing)
function getResolvedArgv1() {
	try {
		const arg = process.argv[1];
		if (!arg) return null;
		return realpathSync(arg);
	} catch {
		return process.argv[1] || null;
	}
}
const resolvedArgv1 = getResolvedArgv1();
const isMain = resolvedArgv1 && (
	import.meta.url === `file://${resolvedArgv1}` ||
	import.meta.url === `file://${process.argv[1]}`
);
if (isMain) {
	main().catch(e => {
		console.error(e.message);
		process.exit(1);
	});
}

// ─── Barrel re-exports for backward compatibility (tests + external consumers) ──

// Account loading functions
export {
	loadAccountsFromEnv,
	loadAccountsFromFile,
	loadAccountFromCodexCli,
	loadAllAccounts,
	loadAllAccountsNoDedup,
	findAccountByLabel,
	getAllLabels,
	isValidAccount,
} from "./lib/codex-accounts.js";

export {
	loadClaudeAccountsFromEnv,
	loadClaudeAccountsFromFile,
	loadClaudeAccounts,
	isValidClaudeAccount,
} from "./lib/claude-accounts.js";

// Deduplication functions
export { deduplicateAccountsByEmail } from "./lib/codex-accounts.js";
export { deduplicateClaudeOAuthAccounts } from "./lib/claude-usage.js";

// Claude OAuth functions
export {
	loadClaudeOAuthFromClaudeCode,
	loadClaudeOAuthFromOpenCode,
	loadClaudeOAuthFromEnv,
	loadAllClaudeOAuthAccounts,
	fetchClaudeOAuthUsage,
	fetchClaudeOAuthUsageForAccount,
} from "./lib/claude-usage.js";

export {
	ensureFreshClaudeOAuthToken,
	persistClaudeOAuthTokens,
	refreshClaudeToken,
} from "./lib/claude-tokens.js";

export {
	ensureFreshToken,
	persistOpenAiOAuthTokens,
} from "./lib/codex-tokens.js";

// OAuth PKCE utilities
export {
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
} from "./lib/oauth.js";

// Claude OAuth browser flow
export {
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
	handleClaudeOAuthFlow,
} from "./lib/claude-oauth.js";

// JWT utilities
export { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";

// Divergence helpers (for testing)
export {
	detectCodexDivergence,
	detectClaudeDivergence,
	findFresherOpenAiOAuthStore,
	findFresherClaudeOAuthStore,
	readOpencodeOpenAiOauthStore,
	readPiOpenAiOauthStore,
	readCodexCliOpenAiOauthStore,
	getActiveAccountId,
	getActiveAccountInfo,
	handleCodexSync,
	handleClaudeSync,
} from "./lib/sync.js";

// Display helpers (for testing)
export {
	shortenPath,
	formatExpiryStatus,
	normalizePercentUsed,
	parseClaudeUtilizationWindow,
	drawBox,
	printHelp,
	printHelpAdd,
	printHelpCodexReauth,
	printHelpClaude,
	printHelpClaudeAdd,
	printHelpClaudeReauth,
	printHelpClaudeSync,
	printHelpSwitch,
	printHelpCodexSync,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
	formatTokenCount,
	buildFactoryUsageLines,
	printHelpFactory,
	printHelpFactoryQuota,
} from "./lib/display.js";

// Subcommand handlers (for testing)
export {
	handleSwitch,
	handleCodexReauth,
	handleRemove,
	handleClaudeAdd,
	handleClaudeReauth,
	handleClaudeSwitch,
	handleClaudeRemove,
	handleFactory,
	handleFactoryAdd,
	handleFactorySwitch,
	handleFactoryRemove,
	handleFactoryList,
	handleFactoryQuota,
	handleQuota,
} from "./lib/handlers.js";

// Color utilities
export { supportsColor, colorize, setNoColorFlag } from "./lib/color.js";

// Constants (for testing)
export { MULTI_ACCOUNT_PATHS, CODEX_CLI_AUTH_PATH, PRIMARY_CMD, CLAUDE_MULTI_ACCOUNT_PATHS } from "./lib/constants.js";

// Factory constants (for testing)
export {
	FACTORY_API_BASE,
	FACTORY_USAGE_URL,
	FACTORY_TIMEOUT_MS,
	FACTORY_MULTI_ACCOUNT_PATH,
	FACTORY_AUTH_FILE_PATH,
	FACTORY_AUTH_KEY_PATH,
	FACTORY_OAUTH_REFRESH_BUFFER_MS,
	FACTORY_PLAN_TIERS,
} from "./lib/constants.js";

// Factory crypto utilities (for testing)
export {
	decryptAuthV2,
	encryptAuthV2,
	generateAuthKey,
	readAuthV2Files,
	writeAuthV2Files,
} from "./lib/factory-crypto.js";

// Factory account utilities (for testing)
export {
	isValidFactoryAccount,
	loadFactoryAccountsFromEnv,
	loadFactoryAccountsFromFile,
	extractFactoryProfile,
	loadFactoryAccountFromAuthV2,
	loadAllFactoryAccounts,
	getFactoryActiveLabel,
	findFactoryAccountByLabel,
	getAllFactoryLabels,
} from "./lib/factory-accounts.js";

// Factory usage utilities (for testing)
export {
	computeBillingPeriod,
	sumDailyTokens,
	extractModelBreakdown,
	fetchFactoryUsage,
} from "./lib/factory-usage.js";

// Factory token refresh (for testing)
export {
	isFactoryTokenExpiring,
	refreshFactoryToken,
	persistFactoryTokens,
	ensureFreshFactoryToken,
} from "./lib/factory-tokens.js";

// Token match field maps (for testing)
export { FACTORY_TOKEN_FIELDS } from "./lib/token-match.js";
