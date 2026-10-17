# HTTP API error codes

Lux `/api/*` errors return `{ message, code }`. Existing `message` text is preserved;
clients should branch on `code`. Compatibility sync endpoints and WebSocket RPC
errors are unchanged. Rate limiting now uses HTTP 429 instead of 403.

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, invalid, expired or revoked token; invalid refresh token |
| `FORBIDDEN` | 403 | Authenticated user lacks admin permission, or bootstrap access is denied |
| `INVALID_CREDENTIALS` | 401 | Incorrect login username/password |
| `INVALID_CURRENT_PASSWORD` | 403 | Incorrect old password during password change |
| `SESSION_REQUIRED` | 400 | `POST /api/me/password` with `revokeOtherDevices: false` requires a token with a session id; sign in again |
| `RATE_LIMITED` | 429 | Existing IP/account auth failure limit reached |
| `INVALID_REQUEST` | 400 | Invalid request body or rejected input |
| `INVALID_DISPLAY_NAME` | 400 | Profile displayName is not a string or exceeds 100 characters |
| `INVALID_AVATAR` | 400 | Profile avatar is not a string |
| `AVATAR_TOO_LARGE` | 413 | Profile avatar exceeds 200 × 1024 characters |
| `INVALID_SIGNATURE` | 400 | Profile signature is not a string or exceeds 140 characters |
| `INVALID_GENDER` | 400 | Profile gender is not male, female or unknown (empty clears to unknown) |
| `USERNAME_READONLY` | 400 | Profile request includes read-only username; edit displayName instead |
| `PROFILE_SAVE_FAILED` | 500 | Profile persistence failed |
| `MISSING_FIELDS` | 400 | Required fields are absent or empty |
| `NOT_FOUND` | 404 | API route or requested resource does not exist |
| `TOKEN_NOT_FOUND` | 404 | PAT is absent or belongs to another user |
| `SESSION_NOT_FOUND` | 404 | Session is absent or belongs to another user |
| `USER_NOT_FOUND` | 404 | Managed user does not exist |
| `INVITE_NOT_FOUND` | 404 check/admin; 400 register | Invite does not exist |
| `INVITE_DISABLED` | 410 check; 400 register | Invite disabled |
| `INVITE_EXPIRED` | 410 check; 400 register | Expiry reached (Unix milliseconds) |
| `INVITE_USED_UP` | 410 check; 400 register | `usedCount >= maxUses` |
| `LAST_ADMIN` | 409 update; 400 delete | Cannot remove the last active admin |
| `SELF_DEMOTE` | 409 | Cannot disable/demote yourself |
| `DEVICE_CONFLICT` | 409 | Device identifiers conflict |
| `CONFLICT` | 409 | Admin already exists during bootstrap |
| `INTERNAL_ERROR` | 500 | Unexpected server error without a more specific code |

Framework errors retain their Fastify `code` (for example
`FST_ERR_CTP_BODY_TOO_LARGE` for HTTP 413); otherwise unclassified request errors
use `INVALID_REQUEST`. Invite registration retains its existing HTTP 400 errors
and adds the same invite codes used by the check endpoint. Successful invite
checks do not consume uses or reset accumulated failures. Failures share the
existing auth IP limiter; registration also retains account-based limiting.

Profile GET/POST/PATCH responses retain `{ profile: { displayName, avatar, gender,
signature } }` and add read-only `username`. POST/PATCH trim supplied strings,
ignore unknown fields, and validate all supplied fields before saving anything.
Empty strings clear text fields; empty gender resets to `unknown`. Omitted fields
stay unchanged. Avatar strings (including mobile data URLs) retain their existing
format compatibility; oversized avatars are rejected instead of truncated.
The global request body limit still applies before profile validation.

For `POST /api/me/password`, a legacy token without `sid` combined with
`revokeOtherDevices: false` returns `SESSION_REQUIRED` with message
`sign in again to keep other devices signed in`, without changing the password
or sessions. Sign in again and use the returned `accessToken`. Omitting the flag
or passing `true` works with legacy tokens and returns a new renewable session.
