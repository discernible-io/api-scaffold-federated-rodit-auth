# Error handling standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

**Status:** Implemented in this peer via `@rodit/rodit-auth-be` `errorResponse.sendError`  
**Reference:** [`src/app.js`](../src/app.js), route modules under `src/routes/` and `src/protected/`  
**Related:** [`logging-standard.md`](logging-standard.md) (canonical log `error` object)

## Implementation status

- Route handlers and global middleware (`415`, `404`, uncaught errors, malformed JSON) use `sendError()`.
- Remaining work for other services is tracked in [`planned-improvements.md`](planned-improvements.md) (items 10–11).

---

## Standard Error Response Structure

All API errors follow this compact, consistent format:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "error": {
  - FIELD: "code": "HOLA_VALIDATION_FAILED",
  - FIELD: "message": "Token ID must be exactly 12 lowercase letters",
  - FIELD: "details": { "tokenId": "INVALID123" }
  - DO: },
  - FIELD: "requestId": "01HX9X0T9CS1EM0WQ7R6F5B2VY",
  - FIELD: "timestamp": "2026-04-15T08:21:45.000Z"
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

**Key points:**
- `error.code` - Machine-readable code (SCREAMING_SNAKE_CASE)
- `error.message` - Human-readable explanation
- `error.details` - Optional context (only when helpful)
- `requestId` - ULID for tracing (always included)
- `timestamp` - ISO 8601 when error occurred (always included)

---

## How API Endpoints Report Errors

All route files use `sendError()` from `@rodit/rodit-auth-be`:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - DO: const { sendError } = require("@rodit/rodit-auth-be").errorResponse
  - NOTE: Minimal error (most common)
  - DO: sendError(res, {
  - FIELD: statusCode: 400,
  - DO: requestId,
  - FIELD: code: 'HOLA_VALIDATION_FAILED',
  - FIELD: message: 'Token ID must be exactly 12 lowercase letters'
  - DO: })
  - NOTE: With details (when helpful)
  - DO: sendError(res, {
  - FIELD: statusCode: 400,
  - DO: requestId,
  - FIELD: code: 'CRUDA_COMMENT_TOO_LONG',
  - FIELD: message: 'Comment exceeds the maximum allowed length',
  - FIELD: details: { maxLength: 280, actualLength: 412 }
  - DO: })
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

### Implementation in Route Files

All route files follow this pattern:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - DO: const { sendError } = require("@rodit/rodit-auth-be").errorResponse
  - DO: router.get("/endpoint", (req, res) => {
  - SET requestId TO req.requestId || ulid()
  - NOTE: Validation
  - CHECK CONDITION: if (!isValid) {
  - RETURN sendError(res, {
  - FIELD: statusCode: 400,
  - DO: requestId,
  - FIELD: code: 'ERROR_CODE_NAME',
  - FIELD: message: 'What went wrong and why'
  - DO: })
  - }
  - NOTE: Success response
  - RETURN res.status(200).json({ data, requestId })
  - DO: })
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

---

## Common Error Codes

### Authentication & Authorization
| Code | Status | Meaning |
|------|--------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Authenticated but lacks required permissions |
| `AUTH_SERVICE_UNAVAILABLE` | 503 | Authentication service unavailable |

### Token Validation
| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_RODITID` | 400 | Token ID format invalid (not 12 lowercase letters) |
| `TOKEN_NOT_FOUND` | 401 | Token doesn't exist on blockchain |
| `IDENTITY_NOT_FOUND` | 404 | RODiT identity not found |

### HOLA Handshake
| Code | Status | Meaning |
|------|--------|---------|
| `HOLA_VALIDATION_FAILED` | 400 | Missing hola, envelope/shape issues, format, fields, checksum, token id, nonce hex, length limits; see `error.details.reasonCode` |
| `HOLA_TIMESTAMP_INVALID` | 400 | HOLA line timestamp: invalid ISO-8601, or outside acceptable freshness window (`/api/testhola`); use ISO from `GET /api/holanonce16ts` for that line — not the login challenge `timestamp_iso` |
| `HOLA_SIGNATURE_INVALID` | 400 | HOLA line Ed25519 / base32 verification failed (`/api/testhola` HTTP errors) |
| `HOLA_RESPONSE_FAILED` | 400 | Server could not emit outbound test HOLA (`/api/testhola`) |

### Login (JWT) verification (`POST /api/login`, HTTP 401 when failures are not silent)
| Code | Status | Meaning |
|------|--------|---------|
| `LOGIN_CHALLENGE_TIMESTAMP_INVALID` | 401 | Login challenge Unix `timestamp` rejected vs server (must match GET /api/login/timestamp pair used for signing) |
| `LOGIN_BASE64URL_SIGNATURE_INVALID` | 401 | base64url login signature did not verify over UTF-8 login signing payload (identifier + canonical `timestamp_iso` from that challenge) |

### Webhook signature
| Code | Status | Meaning |
|------|--------|---------|
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Webhook payload Ed25519 signature did not verify |

### Request Validation
| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_REQUEST` | 400 | Missing required parameter |
| `INVALID_PARAMETERS` | 400 | Parameter value out of range |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Content-Type not application/json |

### Service Errors
| Code | Status | Meaning |
|------|--------|---------|
| `SERVICE_UNAVAILABLE` | 503 | Upstream service unavailable |
| `AGENT_DISCOVERY_FAILED` | 500 | Failed to fetch agent list |
| `LOGIN_FAILED` | 500 | Authentication service error |


---

## Key Principles

1. **Minimal by default** - Only include `details` when it adds debugging value
2. **Machine-readable codes** - Always use SCREAMING_SNAKE_CASE
3. **Actionable messages** - Explain what went wrong and the reason it did, not how to fix it
4. **Consistent structure** - Same format across all endpoints
5. **Traceability** - `requestId` and `timestamp` enable end-to-end debugging

---

## Documented Exception: Silent Login Failures

`/api/login` supports a security/privacy mode controlled by `SECURITY_OPTIONS.SILENT_LOGIN_FAILURES`.

- When `SECURITY_OPTIONS.SILENT_LOGIN_FAILURES=true`:
  - Validation/authentication failures in login flow are intentionally **silent**.
  - Server records metrics/logs, but does not return an error body for those guarded failures.
- When `SECURITY_OPTIONS.SILENT_LOGIN_FAILURES=false`:
  - Login validation failures return a **legacy flat payload**:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "error": "LOGIN_PAYLOAD_DEPRECATED",
  - FIELD: "message": "Human-readable explanation",
  - FIELD: "requestId": "01HX9X0T9CS1EM0WQ7R6F5B2VY"
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

This is a compatibility exception to the unified envelope and is limited to login failure paths governed by the silent-login setting.

---

## Example Error Responses

### Minimal (most common)
```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "error": {
  - FIELD: "code": "HOLA_VALIDATION_FAILED",
  - FIELD: "message": "Token ID must be exactly 12 lowercase letters"
  - DO: },
  - FIELD: "requestId": "01HX9X0T9CS1EM0WQ7R6F5B2VY",
  - FIELD: "timestamp": "2026-04-15T08:21:45.000Z"
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

### With details (when helpful)
```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "error": {
  - FIELD: "code": "CRUDA_COMMENT_TOO_LONG",
  - FIELD: "message": "Comment exceeds the maximum allowed length",
  - FIELD: "details": {
  - FIELD: "maxLength": 280,
  - FIELD: "actualLength": 412
  - }
  - DO: },
  - FIELD: "requestId": "01HX9X0T9CS1EM0WQ7R6F5B2VY",
  - FIELD: "timestamp": "2026-04-15T08:21:45.000Z"
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

---

## Benefits

✅ **Compact** - Minimal JSON payload  
✅ **Consistent** - Same structure across all endpoints  
✅ **Traceable** - `requestId` enables end-to-end debugging  
✅ **Actionable** - Clear error codes for programmatic handling  
✅ **Flexible** - Optional `details` for complex errors  
✅ **Documented** - All error codes defined in this standard

---

## Implementation Status

- [x] ErrorResponse schema in swagger.json (compact format)
- [x] All API route files use `sendError()`
- [x] App-level handlers (`415`, `404`, generic error middleware) use `sendError()`
- [x] Error codes documented above
- [x] requestId and timestamp included in all responses
- [x] Optional `details` field for complex errors
