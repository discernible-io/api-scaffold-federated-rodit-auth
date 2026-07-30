# Logging standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Internal logging conventions for SignPortal and the `@rodit/rodit-auth-be` SDK.
This document is for contributors and operators, not public API consumers.

**Related:** [`configuration-standard.md`](configuration-standard.md) — how `LOG_LEVEL`, `NODE_ENV`, and optional log shipping (`LOKI_URL`, etc.) are resolved.

## Implementation status (consuming service)

The **shared logger** is exported by `@rodit/rodit-auth-be` (Winston-backed implementation inside that package). Today it exposes: `logger.debug`, `logger.info`, `logger.warn`, `logger.error`, plus `logger.logWithContext`, `logger.errorWithContext`, `logger.warnWithContext`, `logger.infoWithContext`, `logger.debugWithContext`, and helpers such as `metric`, `logErrorWithMetrics`, and `createLogContext`.

It does **not** implement `logger.event(...)` or `logger.formatError(...)`. Treat those as non-standard in a typical consuming service unless the SDK adds them in a future change.

## Preferred application logging pattern

**This is the preferred pattern for application code in the consuming service.** Follow [`src/app.js`](../src/app.js) (service-relative):

- Import the SDK **`logger`** from `@rodit/rodit-auth-be`.
- Build transports in app code (console, optional Loki), create a custom Winston logger, and inject it with **`logger.setLogger(customLogger)`**.
- For new code, prefer **`logger.<level>WithContext(message, context, error?)`** so metadata is consistently nested in `context`.
- For existing code paths that already use `logger.info(message, meta)` / `logger.error(message, meta)`, do not rewrite churn-only changes; migrate opportunistically when touching those areas.

Keeping to this pattern ensures application logs use the same structured JSON shape, `LOG_LEVEL` resolution, and transport behavior as the SDK.

### Reference pattern from `src/app.js` (use going forward)

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - DO: const { logger } = require("@rodit/rodit-auth-be")
  - SET winston TO require("winston")
  - SET LokiTransport TO require("winston-loki")
  - SET transports TO [
  - FIELD: new winston.transports.Console({ format: winston.format.json(), level: logLevel })
  - DO: ]
  - CHECK CONDITION: if (lokiUrl) transports.push(new LokiTransport({ host: lokiUrl, json: true, level: logLevel }))
  - DO: logger.setLogger(
  - DO: winston.createLogger({
  - FIELD: level: logLevel,
  - FIELD: format: winston.format.json(),
  - DO: transports
  - DO: })
  - DO: )
  - DO: app.use((req, res, next) => {
  - SET start TO Date.now()
  - DO: res.on("finish", () => {
  - DO: logger.infoWithContext("Request completed", {
  - FIELD: component: "API",
  - FIELD: requestId: req.requestId,
  - FIELD: method: req.method,
  - FIELD: path: req.originalUrl,
  - FIELD: statusCode: res.statusCode,
  - FIELD: duration: Date.now() - start
  - DO: })
  - DO: })
  - DO: next()
  - DO: })
  - DO: logger.infoWithContext("Running startup checks", {
  - FIELD: component: "API",
  - FIELD: operation: "startup.validateConfig"
  - DO: })
  - DO: try {
  - DO: validateConfig(logger)
  - DO: } catch (err) {
  - DO: logger.errorWithContext(
  - DO: "Configuration validation failed",
  - FIELD: { component: "API", operation: "startup.validateConfig" },
  - DO: err
  - DO: )
  - DO: throw err
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

## Goals

- Keep logs machine-queryable and human-readable.
- Make incidents traceable across API, middleware, and SDK layers.
- Prevent accidental disclosure of secrets or sensitive payload data.

## Scope

Applies to runtime code in:

- `src/` (this API server)

Does not apply to docs/examples where `console.*` snippets are instructional only. SDK internals follow the same conventions when touched via the package API.

## Logger and Levels

- Use `logger.debug`, `logger.info`, `logger.warn`, `logger.error` from the shared logger.
- For new runtime code, prefer **`logger.<level>WithContext(message, context, error?)`** (or `logger.logWithContext(level, ...)`) so metadata lives in a structured `context` object.
- Use log levels consistently:
  - `debug`: development diagnostics and detailed state.
  - `info`: expected lifecycle events (startup, request completion, successful operations).
  - `warn`: recoverable problems or degraded behavior.
  - `error`: failed operation, exception, or unavailable dependency.
- Avoid emojis and decorative prefixes in main log messages.

## Effective log level and environment (`LOG_LEVEL`, `NODE_ENV`)

Logging volume and verbosity are **not** hardcoded per environment in application logic. They follow the **same configuration resolution order** as every other tunable setting (environment variable → layered `config/` files including `NODE_ENV` → SDK fallbacks). See [`configuration-standard.md`](configuration-standard.md) for priority details.

**Example (typical service):** Winston/Loki injection in [`src/app.js`](../src/app.js) reads `LOG_LEVEL`, `LOKI_URL`, and related keys via `config.get` only (no `process.env` || `config.get` stacking).

**`LOG_LEVEL`**

- **Source:** `config.get("LOG_LEVEL")` via `@rodit/rodit-auth-be` (with SDK fallbacks documented in that package).
- **Allowed values:** `error`, `warn`, `info`, `debug` (when the SDK runs startup validation).
- **Effect:** The shared Winston logger uses this as its **maximum verbosity** threshold: messages below that level are not emitted on console (and on Loki, when configured). For example `info` hides `logger.debug(...)` calls; `debug` exposes them.
- **Operators:** Prefer `LOG_LEVEL=debug` (or equivalent in `config/{NODE_ENV}.json`) only for short-lived troubleshooting, then revert to `info` or `warn` in steady-state main.

**`NODE_ENV`**

- Selects **`config/{NODE_ENV}.json`** when that file exists (standard `node-config` behavior). It does not bypass `LOG_LEVEL`; it may supply a **different default** `LOG_LEVEL` than `config/default.json` for that environment tier.
- Do not add `process.env.NODE_ENV` checks in routing or middleware to gate logging; rely on **`LOG_LEVEL`** and structured messages instead.

**Log shipping (`LOKI_URL`, `LOKI_TLS_SKIP_VERIFY`, `LOKI_BASIC_AUTH`)**

- Optional Loki transport in `src/app.js` should use the **same resolved `LOG_LEVEL`** as stdout. These keys follow the configuration standard above; secrets in `LOKI_BASIC_AUTH` must never be logged.

**Observability of the chosen settings**

- **Example (typical service):** After listen, `logger.info("Server started", …)` in [`src/app.js`](../src/app.js) records port and endpoints; use resolved `LOG_LEVEL` from config when bootstrap injection is aligned (see implementation note above).

## Canonical Event Shape

Every structured log entry should follow this payload contract (delivered via the **second argument** to `*WithContext`, which becomes the log record’s `context` when using those helpers):

- `component` (required): stable emitter identifier (for example `API`, `ClientSigner` in this repo).
- `requestId` (required for request-bound logs): request correlation id.
- `operation` (recommended): logical action (for example `startup.validateConfig`, `auth.login`).
- `method`, `path`, `statusCode`, `duration` (request lifecycle logs).
- `error` (for failures): normalized error object (see Error Contract).

Some call sites still use two-argument Winston patterns (`logger.info(message, meta)`); treat **`*WithContext` as the standard** for new code so fields stay consistent.

## Aspirational Unified Event Schema

The long-term target is a single, normalized event envelope for all runtime logs.
This section is aspirational and describes the desired end state, not guaranteed current behavior.
Adoption of these fields must follow the same rule as [**Aspirational Event Vocabulary**](#aspirational-event-vocabulary): implement only with **spot improvements** at call sites, never via helpers or other indirection that centralizes envelope or vocabulary construction.

Each log event should include:

- `eventId` (required): unique id for this emitted event.
- `eventType` (required): normalized type/category of event.
- `loggerId` (required): stable identifier of the logger/emitter instance.
- `ipAddressId` (required for multi-instance/server deployments): identifier for the server instance IP context.
- `credentialId` (optional): identifier of the credential used by the source to perform the request, when applicable.
- `sourceId` (required): origin identifier (for example originating client IP id or upstream system id).
- `resourceId` (required): identifier of the target resource (subject) of the event.
- `requestType` (required for request-driven events): normalized request/action type.
- `result` (required): one of `success`, `failure`, `error`, `source_error`.
- `resultText` (required when result is not self-evident): human-readable reason for the result.
- `dateTime` (required): event timestamp in ISO 8601 UTC format.

Recommended normalized envelope:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "eventId": "evt_01J...",
  - FIELD: "eventType": "authentication.attempt",
  - FIELD: "loggerId": "API",
  - FIELD: "ipAddressId": "ip_node_01",
  - FIELD: "credentialId": "cred_service_a",
  - FIELD: "sourceId": "src_203.0.113.10",
  - FIELD: "resourceId": "user_12345",
  - FIELD: "requestType": "POST /auth/login",
  - FIELD: "result": "failure",
  - FIELD: "resultText": "Invalid credentials",
  - FIELD: "dateTime": "2026-05-05T19:40:00Z"
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

Normalization notes:

- Prefer ids and controlled vocabularies over free-form strings for fields ending in `Id` or `Type`.
- `result` values should stay constrained to the canonical set above.
- `dateTime` should be generated by the server clock in UTC.
- If a legacy field (for example `requestId` or `operation`) is also present during migration, keep the aspirational fields authoritative.

## Legacy-to-Structured Example (ProFTPD)

Use this pattern when converting unstructured auth/service logs into the normalized event envelope.

### Unstructured examples (source lines)

```text
May 21 20:22:14 slacker proftpd[25530] proftpd.lab.ossec.net (192.168.20.10[192.168.20.10]): FTP session closed.
May 21 20:22:28 slacker proftpd[25556] proftpd.lab.ossec.net (192.168.20.10[192.168.20.10]): USER dcid-test: Login successful.
May 21 20:22:44 slacker proftpd[25557] proftpd.lab.ossec.net (192.168.20.10[192.168.20.10]): USER dcid-test (Login failed): Incorrect password.
May 21 20:21:21 slacker proftpd[25530] proftpd.lab.ossec.net (192.168.20.10[192.168.20.10]): no such user 'dcid-inv'
May 21 20:21:21 slacker proftpd[31806] proftpd.lab.ossec.net (190.48.150.156[190.48.150.156]): USER abad: no such user found from 190.48.150.156 [190.48.150.156] to proftpd.lab.ossec.net:21
```

### Structured examples (target shape)

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - [
  - {
  - FIELD: "eventType": "interface.disconnect",
  - FIELD: "component": "Interface",
  - FIELD: "action": "disconnect",
  - FIELD: "credentialId": null,
  - FIELD: "sourceId": "host:slacker|proc:proftpd[25530]",
  - FIELD: "resourceId": "service:proftpd.lab.ossec.net:21",
  - FIELD: "requestType": "ftp.session.close",
  - FIELD: "result": "success",
  - FIELD: "resultText": "FTP session closed.",
  - FIELD: "dateTime": "2021-05-21T20:22:14Z"
  - DO: },
  - {
  - FIELD: "eventType": "session.login",
  - FIELD: "component": "Session",
  - FIELD: "action": "login",
  - FIELD: "credentialId": "user:dcid-test",
  - FIELD: "sourceId": "host:slacker|proc:proftpd[25556]",
  - FIELD: "resourceId": "service:proftpd.lab.ossec.net:21",
  - FIELD: "requestType": "ftp.auth.login",
  - FIELD: "result": "success",
  - FIELD: "resultText": "Login successful.",
  - FIELD: "dateTime": "2021-05-21T20:22:28Z"
  - DO: },
  - {
  - FIELD: "eventType": "session.login",
  - FIELD: "component": "Session",
  - FIELD: "action": "login",
  - FIELD: "credentialId": "user:dcid-test",
  - FIELD: "sourceId": "host:slacker|proc:proftpd[25557]",
  - FIELD: "resourceId": "service:proftpd.lab.ossec.net:21",
  - FIELD: "requestType": "ftp.auth.login",
  - FIELD: "result": "failure",
  - FIELD: "resultText": "Incorrect password.",
  - FIELD: "dateTime": "2021-05-21T20:22:44Z"
  - DO: },
  - {
  - FIELD: "eventType": "credential.read",
  - FIELD: "component": "Credential",
  - FIELD: "action": "read",
  - FIELD: "credentialId": "user:dcid-inv",
  - FIELD: "sourceId": "host:slacker|proc:proftpd[25530]",
  - FIELD: "resourceId": "service:proftpd.lab.ossec.net:21",
  - FIELD: "requestType": "ftp.auth.lookup",
  - FIELD: "result": "error",
  - FIELD: "resultText": "No such user.",
  - FIELD: "dateTime": "2021-05-21T20:21:21Z"
  - DO: },
  - {
  - FIELD: "eventType": "credential.read",
  - FIELD: "component": "Credential",
  - FIELD: "action": "read",
  - FIELD: "credentialId": "user:abad",
  - FIELD: "sourceId": "host:slacker|proc:proftpd[31806]|remote:190.48.150.156",
  - FIELD: "resourceId": "service:proftpd.lab.ossec.net:21",
  - FIELD: "requestType": "ftp.auth.lookup",
  - FIELD: "result": "failure",
  - FIELD: "resultText": "No such user found.",
  - FIELD: "dateTime": "2021-05-21T20:21:21Z"
  - }
  - ]
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

### Mapping guidance for this pattern

- `credentialId`: normalized subject identity (for example `user:<username>`), not raw message fragments.
- `sourceId`: emitter/process identity and remote peer when present.
- `resourceId`: canonical target endpoint/service id.
- `requestType`: protocol-specific action label (for example `ftp.auth.login`, `ftp.session.close`).
- `result`: constrain to `success`, `failure`, `error`, `source_error`.
- `resultText`: short explanation from parser normalization; avoid keeping noisy raw fragments.

## Aspirational Event Vocabulary

To reduce synonym drift (`start` vs `run`, `disconnect` vs `close`), map events to a controlled `component` + `action` vocabulary.

**How to adopt this vocabulary:** Progress toward aligned `eventType`, `component`, and `action` values must happen **only** through **spot improvements**—direct edits at the call sites that own the behavior (explicit `logger.*WithContext` payloads and message text in that code path). Do **not** implement or migrate toward this vocabulary by adding **helpers, wrappers, builders, or other indirection** whose role is to construct or normalize these aspirational fields. Indirection makes call sites harder to read and review; the standard is local, obvious logging at the point of the event.

### Component and allowed actions

- `Component`: `initiate`, `finalize`, `freeze`, `unfreeze`, `query`, `state`, `change`, `request`, `rights`, `cancel_rights`
- `Credential`: `create`, `delete`, `block`, `unblock`, `read`, `write`, `grant`, `cancel`
- `Session`: `login`, `logout`, `suspend`, `resume`, `read`, `write`, `grant`, `cancel`
- `Message`: `send`, `listen`, `retain`, `forward`, `read`, `write`, `grant`, `cancel`
- `Repository`: `create`, `delete`, `block`, `unblock`, `read`, `write`, `grant`, `cancel`
- `Interface`: `connect`, `disconnect`, `interrupt`, `continue`, `read`, `write`, `grant`, `cancel`
- `Channel`: `open`, `close`, `hold`, `release`, `read`, `write`, `grant`, `cancel`
- `Service`: `start`, `stop`, `pause`, `resume`, `read`, `write`, `grant`, `cancel`

### Naming rule

- Build `eventType` as `<component-lowercase>.<action-lowercase>` (for example `session.login`, `service.stop`, `interface.disconnect`).
- If a source verb is not in the controlled list, map it to the nearest approved action and preserve source phrasing in `resultText` when needed.

## Message Style

- Message text should be short and action-oriented, for example:
  - `Configuration validation passed`
  - `RPC health check failed`
  - `Request completed`
- Do not encode metadata in message prefixes like `[MCP]` when the same value can be a field.

## Error Contract

Use one canonical error field:

```text
PSEUDOCODE
INPUTS:
  - Use values defined by the surrounding section/context.
STEPS:
  - {
  - FIELD: "error": {
  - FIELD: "name": "ErrorName",
  - FIELD: "message": "Human readable message",
  - FIELD: "code": "OPTIONAL_MACHINE_CODE",
  - FIELD: "stack": "OPTIONAL_STACK_FOR_DEBUG"
  - }
  - }
OUTPUTS:
  - Produces the section's intended result using equivalent logic.
```

Rules:

- Always include `error.message`.
- Include `error.name` when available.
- Include `error.code` when available from upstream libraries.
- Include `error.stack` only where appropriate for the current **effective `LOG_LEVEL`** and security policy (avoid large stacks at `info` in high-volume paths unless justified).
- Do not split across ad-hoc fields like `errorMessage` and `errorCode`.
- `logger.formatError(...)` is not available; build the canonical `{ name, message, code?, stack? }` shape manually or pass an `Error` into `errorWithContext` / `logWithContext` so the Winston format serializes it consistently.

## Context Construction

- Prefer inline context objects passed to **`logger.<level>WithContext(message, context, error?)`** (or `logWithContext`).
- Do not introduce new helper layers for context construction unless there is a clear shared need.

## Request Lifecycle Pattern

For request-scoped operations:

- Emit one completion log at end of request with:
  - `component`, `requestId`, `method`, `path`, `statusCode`, `duration`.
- Emit error logs with the same correlation fields.
- Ensure middleware and route handlers preserve the same `requestId`.

## Multi-layer Request Telemetry Clarity (Current + Aspirational)

This section addresses ambiguity when one HTTP request is logged by multiple layers
(for example app middleware, SDK middleware, and `PerformanceService`).

### Current-state requirements (apply now)

- Keep `PerformanceService` logs explicit about intent: use message text that states telemetry action (`Request telemetry recorded`, `Trace started`, `Trace completed`) rather than generic lifecycle wording.
- Avoid duplicate completion phrasing across layers. If more than one layer emits completion, each must have distinct message text and distinct `component`.
- For metric-style debug events emitted via `logger.metric(...)`, include enough labels to identify source context (`component`, `method`, `url/path`, `status`, `requestId` when available).
- When the emitter is not the route handler itself (for example service-level instrumentation), include `operation` that names the instrumentation step.
- Public documentation endpoints (for example `/openapi.json`) must log as normal request traffic; do not assume privileged semantics in message text.

### Aspirational requirements (target state)

The following requirements are target-state and may be adopted incrementally at call sites.

- Every request-bound log includes both:
  - `component` (who emitted),
  - `pipelineStage` (where in flow: `request.start`, `request.instrumentation`, `request.finish`, `request.metric`, `trace.start`, `trace.finish`).
- Every request-bound event should carry `eventType` aligned with the normalized vocabulary, for example:
  - `service.request` for request middleware lifecycle,
  - `service.read` for telemetry extraction/read operations,
  - `service.write` for telemetry emission/record operations.
- For layered logging, exactly one event is designated canonical completion (`result` + `resultText` + duration fields). Other layers should emit either:
  - instrumentation events (`request.metric`, `trace.*`), or
  - error/warn events.
- Metrics emitted as logs should include `metric_type` plus a stable `metric_scope` (`request`, `trace`, `process`) so dashboards can distinguish API business events from telemetry plumbing.
- Add `routeVisibility` (`public`, `authenticated`, `privileged`) to request completion logs so operators do not infer access level from path names alone.

Normalization note:

- Adopt these fields through spot improvements at call sites, consistent with the no-indirection guidance in [Aspirational Event Vocabulary](#aspirational-event-vocabulary).

## No `console.*` in Runtime Code

- Do not use `console.log`, `console.warn`, or `console.error` in runtime code under `src/`.
- Use shared logger instead so all logs keep the same format and transport.
- Exception: early bootstrap fallback is permitted only when logger cannot initialize; keep this minimal.

## Redaction and Sensitive Data

Never log:

- Secrets, passwords, private keys, tokens, or credentials.
- Full auth headers or session bearer tokens.
- Raw biometric or facial encoding payloads.

When needed for diagnostics:

- Log presence/shape, not raw value (for example `[REDACTED]`, `tokenPresent: true`).
- Prefer explicit allowlists over broad object dumps.

## Current Consistency Gaps (Audit Snapshot)

- Mixed context payload patterns across routes and SDK helper expectations.
- Residual direct `console.*` outside runtime paths (for example instructional strings embedded in how-to config content).
- Inconsistent failure payload shape (`error` string vs nested object vs split fields).
- Uneven inclusion of `component` and `requestId` outside request handlers.

## Review Checklist (PR Gate)

- Uses shared logger (no runtime `console.*`).
- Does not hardcode verbosity; respects resolved **`LOG_LEVEL`** (see [`configuration-standard.md`](configuration-standard.md)).
- Includes `component` on all structured logs.
- Includes `requestId` on request-scoped logs.
- Uses canonical `error` object for failures.
- Avoids secrets/PII in log payload.
- Message text is concise and metadata lives in structured fields.
