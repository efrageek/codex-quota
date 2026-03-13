# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime
- Node.js >= 18 (uses native fetch, crypto)
- Bun v1.3.10 (test runner)
- Zero npm dependencies

## Factory Analytics API
- Base URL: `https://api.factory.ai/api/v1/analytics`
- Auth: `Authorization: Bearer <token>` (JWT from auth.v2 or `fk-` API key)
- Endpoints: `/tokens`, `/tools`, `/activity`, `/productivity`, `/users`
- Date params: `startDate` and `endDate` in `YYYY-MM-DD` (UTC)
- Data available through yesterday only (24h lag)
- Historical data available from 2026-01-14
- **Current limitation:** Analytics API returns 403 "not enabled" for the test org. Build against documented response format with mocked tests.

## Factory Auth Files
- `~/.factory/auth.v2.file` — AES-256-GCM encrypted JSON containing `{ access_token, refresh_token }`
- `~/.factory/auth.v2.key` — Base64-encoded 32-byte AES key
- Encryption format: `IV:AuthTag:CipherText` (all Base64, colon-separated)
- JWT issuer: `https://api.workos.com`
- JWT claims: email, org_id, role, roles, permissions, sub, exp, iat, etc.
- JWT expiry: 7 days from issuance
- Refresh token: 25-char opaque string

## Factory Plans
- Pro: 20M Standard Tokens/month ($20)
- Max: 200M Standard Tokens/month ($200)
- Free: BYOK only
- Overage: $2.70 per million Standard Tokens
- Cached tokens: 10 cached = 1 Standard Token

## API Key Format
- Prefix: `fk-`
- Generated at: app.factory.ai/settings/api-keys
- Requires Manager or Owner role for Analytics API access

## Environment Variables
- `FACTORY_ACCOUNTS` — JSON array of Factory accounts (follows same pattern as `CODEX_ACCOUNTS`)
- `FACTORY_API_KEY` — Direct API key for headless/CI use (used by Droid CLI)
