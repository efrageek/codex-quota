/**
 * AES-256-GCM encryption/decryption utilities for Factory auth.v2 files.
 * Handles the IV:AuthTag:CipherText format used by the Droid CLI.
 *
 * Dependencies: constants (for path defaults), fs (for atomic writes)
 */

import {
	randomBytes,
	createCipheriv,
	createDecipheriv,
} from "node:crypto";
import {
	readFileSync,
	existsSync,
	mkdirSync,
	chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./fs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Decryption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decrypt an auth.v2 file content using AES-256-GCM.
 * Format: IV:AuthTag:CipherText (all base64-encoded, colon-separated)
 * @param {string} encryptedContent - The "IV:AuthTag:CipherText" string
 * @param {string} keyContent - Base64-encoded 32-byte key (may have trailing whitespace)
 * @returns {{ access_token: string, refresh_token: string } | null} Parsed JSON or null on failure
 */
export function decryptAuthV2(encryptedContent, keyContent) {
	try {
		if (!encryptedContent || !keyContent) return null;

		// Trim trailing whitespace/newlines from key content
		const trimmedKey = keyContent.trim();

		// Decode the key from base64
		let keyBuf;
		try {
			keyBuf = Buffer.from(trimmedKey, "base64");
		} catch {
			return null;
		}

		// Validate key length (must be exactly 32 bytes for AES-256)
		if (keyBuf.length !== 32) return null;

		// Split encrypted content into exactly 3 segments
		const segments = encryptedContent.trim().split(":");
		if (segments.length !== 3) return null;

		const [ivB64, authTagB64, cipherTextB64] = segments;

		// Decode each segment from base64
		let iv, authTag, cipherText;
		try {
			iv = Buffer.from(ivB64, "base64");
			authTag = Buffer.from(authTagB64, "base64");
			cipherText = Buffer.from(cipherTextB64, "base64");
		} catch {
			return null;
		}

		// Validate IV length (12 bytes for GCM)
		if (iv.length !== 12) return null;

		// Validate AuthTag length (16 bytes for GCM)
		if (authTag.length !== 16) return null;

		// Decrypt using AES-256-GCM
		const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv);
		decipher.setAuthTag(authTag);

		let decrypted = decipher.update(cipherText);
		decrypted = Buffer.concat([decrypted, decipher.final()]);

		// Parse decrypted content as JSON
		const parsed = JSON.parse(decrypted.toString("utf-8"));
		return parsed;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Encryption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypt data to auth.v2 format using AES-256-GCM.
 * Produces IV:AuthTag:CipherText (all base64-encoded, colon-separated)
 * @param {object} data - The data to encrypt (typically { access_token, refresh_token })
 * @param {string} keyContent - Base64-encoded 32-byte key (may have trailing whitespace)
 * @returns {{ encrypted: string } | { error: string }} Encrypted string or error
 */
export function encryptAuthV2(data, keyContent) {
	try {
		if (!data || !keyContent) return { error: "Missing data or key" };

		// Trim trailing whitespace/newlines from key content
		const trimmedKey = keyContent.trim();

		// Decode the key from base64
		let keyBuf;
		try {
			keyBuf = Buffer.from(trimmedKey, "base64");
		} catch {
			return { error: "Invalid base64 key" };
		}

		// Validate key length (must be exactly 32 bytes for AES-256)
		if (keyBuf.length !== 32) return { error: `Invalid key length: ${keyBuf.length} bytes (expected 32)` };

		// Generate a random 12-byte IV
		const iv = randomBytes(12);

		// Encrypt using AES-256-GCM
		const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
		const plaintext = JSON.stringify(data);
		let encrypted = cipher.update(plaintext, "utf-8");
		encrypted = Buffer.concat([encrypted, cipher.final()]);
		const authTag = cipher.getAuthTag();

		// Format: IV:AuthTag:CipherText (all base64)
		const result = [
			iv.toString("base64"),
			authTag.toString("base64"),
			encrypted.toString("base64"),
		].join(":");

		return { encrypted: result };
	} catch (e) {
		return { error: e.message };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Key Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a random 32-byte AES-256 key encoded as base64.
 * @returns {string} Base64-encoded 32-byte key
 */
export function generateAuthKey() {
	return randomBytes(32).toString("base64");
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read and decrypt auth.v2 files from disk.
 * @param {string} authFilePath - Path to the encrypted auth.v2.file
 * @param {string} keyFilePath - Path to the auth.v2.key file
 * @returns {{ accessToken: string, refreshToken: string } | null} Parsed tokens or null on failure
 */
export function readAuthV2Files(authFilePath, keyFilePath) {
	try {
		if (!existsSync(authFilePath) || !existsSync(keyFilePath)) return null;

		const encryptedContent = readFileSync(authFilePath, "utf-8");
		const keyContent = readFileSync(keyFilePath, "utf-8");

		const decrypted = decryptAuthV2(encryptedContent, keyContent);
		if (!decrypted) return null;

		// Map snake_case fields to camelCase for internal use
		return {
			accessToken: decrypted.access_token ?? null,
			refreshToken: decrypted.refresh_token ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Encrypt and write auth.v2 files to disk with secure permissions.
 * Creates the parent directory with 0o700 if it doesn't exist.
 * Always writes both files — used for account switching and initial setup.
 * @param {string} authFilePath - Path to write the encrypted auth.v2.file
 * @param {string} keyFilePath - Path to write the auth.v2.key file
 * @param {object} data - Data to encrypt (typically { access_token, refresh_token })
 * @returns {{ success: boolean, error?: string }} Result
 */
export function writeAuthV2Files(authFilePath, keyFilePath, data) {
	try {
		if (!authFilePath || !keyFilePath || !data) {
			return { success: false, error: "Missing required arguments" };
		}

		// Generate a fresh key for every write
		const keyContent = generateAuthKey();

		// Encrypt the data
		const result = encryptAuthV2(data, keyContent);
		if (result.error) {
			return { success: false, error: result.error };
		}

		// Ensure parent directories exist with secure permissions
		for (const filePath of [authFilePath, keyFilePath]) {
			const dir = dirname(filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			}
		}

		// Write key file first (needed for decryption)
		writeFileAtomic(keyFilePath, keyContent + "\n", { mode: 0o600 });

		// Write encrypted auth file
		writeFileAtomic(authFilePath, result.encrypted, { mode: 0o600 });

		return { success: true };
	} catch (e) {
		return { success: false, error: e.message };
	}
}
