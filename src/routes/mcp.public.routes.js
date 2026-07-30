/**
 * Public MCP HTTP routes for agent documentation and OpenClaw plugin compatibility.
 * Resource list and get-by-uri are unauthenticated so agents can read login guides before JWT.
 */
const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { loadOpenApiSpec } = require("../lib/app-version");

const mcpCache = { swagger: null };

function loadSwaggerSpec() {
  if (mcpCache.swagger) {
    return mcpCache.swagger;
  }
  try {
    mcpCache.swagger = loadOpenApiSpec();
    return mcpCache.swagger;
  } catch (error) {
    logger.errorWithContext(
      "Failed to load swagger.json for MCP schema",
      { component: "MCPRoutes", method: "loadSwaggerSpec" },
      error
    );
    mcpCache.swagger = {
      openapi: "3.0.0",
      info: { title: "RODiT API", version: "unknown" },
      paths: {}
    };
    return mcpCache.swagger;
  }
}

const AGENT_SKILLS_MD = `# Agent login cheat sheet (RODiT CRUDA scaffold)

## Identity (pick one)

### 1. OpenClaw + IdentyClaw plugin (preferred for OpenClaw agents)

If you already have Passport keys and the IdentyClaw OpenClaw plugin:

\`\`\`text
identyclaw_ensure_session({ apiEndpoint: "<this-api-base>" })
# JWT is cached inside the plugin — it is NEVER returned to the model.
identyclaw_request({ method: "GET", path: "/api/cruda/", apiEndpoint: "<this-api-base>" })
\`\`\`

Install if needed:

\`\`\`bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin
openclaw skills install clawhub:identyclaw
\`\`\`

Do **not** invent curl Bearer headers from chat. A JWT from \`https://api.identyclaw.com\` does **not** authorize this peer's protected routes — login against **this** \`apiEndpoint\`.

### 2. MCP streamable HTTP (docs tools)

Connect to \`/mcp\` with an MCP client: \`initialize\` first, keep \`Mcp-Session-Id\`. Do **not** bare-GET \`/mcp\` (use \`/.well-known/mcp\` for discovery). Tools: \`list_resources\`, \`get_resource\`.

### 3. Raw JWT login (any runtime)

| Step | Endpoint | Notes |
| --- | --- | --- |
| 1 | \`GET /api/login/timestamp\` | Returns \`timestamp\` + \`timestamp_iso\` from the same moment |
| 2 | Sign locally | UTF-8 bytes of \`accountid + timestamp_iso\` or \`roditid + timestamp_iso\` (no separator) |
| 3 | \`POST /api/login\` | Send exactly one of \`timestamp\` or \`timestamp_iso\`; \`base64url_signature\` |
| 4 | Protected calls | \`Authorization: Bearer <jwt_token>\` on REST |

## Critical rules

- Fetch a **fresh** timestamp pair immediately before each login attempt; discard after use.
- Sign with **timestamp_iso** from the challenge response.
- Response field is \`jwt_token\` (not \`token\`).
- Store the full JWT outside model-visible output (plugin cache or local file) — never paste redacted tool output (\`eyJhbG…\`) into Authorization headers.

## Verify login

\`\`\`bash
curl -sk "$BASE/api/token/claims" -H "Authorization: Bearer $JWT"
\`\`\`

## Showcase resource

Protected CRUDA comments API: \`/api/cruda/*\` (create / list / read / update / destroy). Requires authentication **and** METHOD_PERMISSION_MAP authorization.

## More help

- \`GET /api/mcp/resource/guide:troubleshooting\`
- \`GET /.well-known/mcp\`
`;

const AGENT_LOGIN_GUIDE = {
  title: "Agent API login",
  description:
    "JWT challenge-response login for this RODiT peer. OpenClaw: ensure_session then identyclaw_request (JWT never returned to the model). Others: raw Ed25519 login.",
  preferredPath: {
    runtime: "OpenClaw + IdentyClaw plugin",
    call: "identyclaw_ensure_session({ apiEndpoint }) then identyclaw_request({ method, path, apiEndpoint })",
    note: "Plugin caches JWT and never returns it; do not curl Bearer from chat. Home (api.identyclaw.com) JWT is rejected for this peer's protected routes."
  },
  flow: [
    "OpenClaw (preferred): identyclaw_ensure_session({ apiEndpoint }) then identyclaw_request",
    "Raw login: GET /api/login/timestamp",
    "Sign UTF-8 (accountid or roditid) + timestamp_iso with Ed25519 → base64url",
    "POST /api/login with exactly one timestamp field and base64url_signature",
    "Use Authorization: Bearer jwt_token on protected REST routes (e.g. /api/cruda/*)"
  ],
  requestFields: {
    accountid: "64-char lowercase hex NEAR implicit account (enrollment)",
    roditid: "12-letter Passport token id (direct login)",
    timestamp: "Unix seconds from challenge (or timestamp_iso, not both)",
    base64url_signature: "Ed25519 signature over identifier + timestamp_iso"
  },
  responseFields: {
    jwt_token: "Bearer token (~1500–2000 chars, three dot-separated segments)"
  },
  openClaw: {
    ensureSession: "identyclaw_ensure_session({ apiEndpoint })",
    plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin",
    skill: "openclaw skills install clawhub:identyclaw"
  },
  showcase: "/api/cruda"
};

const TROUBLESHOOTING_GUIDE = {
  title: "Agent login troubleshooting",
  description: "Common login failures for OpenClaw, Cursor, and shell agents",
  lastUpdated: "2026-07-30",
  commonErrors: [
    {
      error: "Login succeeds (200) but next request returns INVALIDATED_TOKEN / invalid_jwt_format",
      cause:
        "Client sent a truncated or redacted JWT (e.g. eyJhbG…ISDw from agent tool output). Login succeeded; the follow-up bearer token was invalid.",
      solutions: [
        "Store jwt_token outside model context: OpenClaw identyclaw plugin, RoditClient, or a local file",
        "Verify full JWT length ~1500–2000 and three dot-separated segments",
        "Never inline jwt_token in commands visible to the model"
      ],
      prevention:
        "Prefer the OpenClaw identyclaw plugin or local SDK over raw curl the model can see."
    },
    {
      error: "LOGIN_BASE64URL_SIGNATURE_INVALID or 401 after POST /api/login",
      cause: "Wrong signing payload, wrong key, or standard base64 instead of base64url.",
      solutions: [
        "Use timestamp_iso from the same GET /api/login/timestamp response for signing",
        "Message is identifier + timestamp_iso with no separator",
        "Encode signature as base64url (- and _, no padding)"
      ]
    },
    {
      error: "LOGIN_TIMESTAMP_AMBIGUOUS or INVALID_LOGIN_TIMESTAMP",
      cause: "Sent both timestamp and timestamp_iso, or reused an old challenge pair.",
      solutions: [
        "Send exactly one timestamp field in POST /api/login",
        "Fetch a new GET /api/login/timestamp before every retry"
      ]
    },
    {
      error: "AUTH_SERVICE_UNAVAILABLE (503)",
      cause: "RoditClient not initialized on this instance (missing NEAR credentials at startup).",
      solutions: ["Check server logs and NEAR_CREDENTIALS_JSON_B64 / Vault configuration on the host"]
    }
  ]
};

const DISCOVERY_INDEX = {
  title: "MCP discovery index",
  description: "Start here for agent login and OpenClaw compatibility",
  resources: [
    { uri: "doc:skills", http: "/api/mcp/resource/doc:skills", description: "Login cheat sheet" },
    { uri: "guide:agent-login", http: "/api/mcp/resource/guide:agent-login", description: "Structured login guide" },
    { uri: "guide:troubleshooting", http: "/api/mcp/resource/guide:troubleshooting", description: "Login error diagnosis" },
    { uri: "openapi:swagger", http: "/api/mcp/resource/openapi:swagger", description: "OpenAPI spec" }
  ],
  publicLoginEndpoints: ["/api/login/timestamp", "/api/login"],
  showcase: "/api/cruda",
  discovery: "/.well-known/mcp"
};

const mcpService = {
  async listAvailableResources(req, options = {}) {
    const all = [
      { uri: "doc:discovery", name: "MCP Discovery Index", type: "application/json" },
      { uri: "doc:skills", name: "Agent Login Skills", type: "text/markdown" },
      { uri: "skills:skills", name: "Agent Login Skills (alias)", type: "text/markdown" },
      { uri: "guide:agent-login", name: "Agent Login Guide", type: "application/json" },
      { uri: "guide:troubleshooting", name: "Login Troubleshooting", type: "application/json" },
      { uri: "openapi:swagger", name: "OpenAPI Schema", type: "application/json" }
    ];
    const start = options.cursor ? parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit || all.length;
    const resources = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? String(start + limit) : null;
    return { resources, nextCursor };
  },

  async getResource(uri) {
    if (uri === "openapi:swagger") {
      return { type: "application/json", content: loadSwaggerSpec() };
    }
    if (uri === "doc:discovery") {
      return { type: "application/json", content: DISCOVERY_INDEX };
    }
    if (uri === "doc:skills" || uri === "skills:skills") {
      return { type: "text/markdown", content: AGENT_SKILLS_MD };
    }
    if (uri === "guide:agent-login") {
      return { type: "application/json", content: AGENT_LOGIN_GUIDE };
    }
    if (uri === "guide:troubleshooting") {
      return { type: "application/json", content: TROUBLESHOOTING_GUIDE };
    }
    const error = new Error(`Unknown resource: ${uri}`);
    error.statusCode = 404;
    throw error;
  },

  async getSchemaResource() {
    return loadSwaggerSpec();
  }
};

router.get("/resources", async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();

  try {
    const options = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor
    };
    const result = await mcpService.listAvailableResources(req, options);
    const duration = Date.now() - startTime;

    logger.metric("mcp_operations", duration, { operation: "listResources", result: "success" });

    return res.json({ ...result, requestId });
  } catch (error) {
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_LIST_FAILED",
      message: "Failed to list resources",
      details: { detail: error.message }
    });
  }
});

router.get("/resource/:uri(*)", async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  const uri = req.params.uri;

  try {
    const resource = await mcpService.getResource(uri);

    const duration = Date.now() - startTime;
    logger.metric("mcp_operations", duration, {
      operation: "getResource",
      resourceUri: uri,
      result: "success"
    });

    return res.json({ ...resource, requestId });
  } catch (error) {
    const duration = Date.now() - startTime;
    const statusCode = error.statusCode || 500;

    if (statusCode === 404) {
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "MCP_RESOURCE_NOT_FOUND",
        message: "Resource not found",
        details: { uri }
      });
    }

    logger.logErrorWithMetrics(
      "Error retrieving MCP resource",
      { requestId, component: "MCPRoutes", resourceUri: uri, duration },
      error,
      "mcp_error",
      { operation: "getResource", resourceUri: uri, result: "error", duration }
    );

    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_RESOURCE_FAILED",
      message: "Failed to retrieve resource",
      details: { detail: error.message }
    });
  }
});

router.get("/schema", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const schema = await mcpService.getSchemaResource();
    return res.json({ ...schema, requestId });
  } catch (error) {
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_SCHEMA_FAILED",
      message: "Failed to retrieve schema",
      details: { detail: error.message }
    });
  }
});

module.exports = router;
module.exports.mcpService = mcpService;
