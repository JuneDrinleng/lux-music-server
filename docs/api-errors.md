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
| `RATE_LIMITED` | 429 | Existing IP/account auth failure limit reached |
| `INVALID_REQUEST` | 400 | Invalid request body or rejected input |
| `MISSING_FIELDS` | 400 | Required fields are absent or empty |
| `NOT_FOUND` | 404 | API route or requested resource does not exist |
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
