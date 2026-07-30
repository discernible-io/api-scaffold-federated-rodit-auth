const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger } = require("@rodit/rodit-auth-be");
const { version: APP_VERSION } = require("../lib/app-version");

/**
 * @route GET /
 * @desc API discovery with agent login guidance (OpenClaw / shell agents)
 */
router.get("/", (req, res) => {
  const requestId = req.requestId || ulid();

  logger.infoWithContext("API root discovery requested", {
    component: "DiscoveryRoutes",
    requestId,
    endpoint: "/",
    ip: req.ip
  });

  return res.status(200).json({
    name: "RODiT Authentication API",
    version: APP_VERSION,
    description:
      "Scaffold API for RODiT / IdentyClaw passport login with a CRUDA comments showcase. Agents: start with doc:skills or guide:troubleshooting via MCP HTTP paths (see agentGuide).",
    agentGuide: {
      summary:
        "OpenClaw: identyclaw_ensure_session({ apiEndpoint }) then call protected routes via identyclaw_request. JWT is never returned to the model. Raw: GET /api/login/timestamp → POST /api/login → Authorization: Bearer on /api/cruda/*.",
      tlsNote: "If using self-signed TLS on :8443 — use curl -sk",
      loginFlow: {
        openClawPreferred:
          'identyclaw_ensure_session({ apiEndpoint }) then identyclaw_request({ method, path, apiEndpoint })',
        timestamp: "GET /api/login/timestamp",
        login: "POST /api/login",
        verify: "GET /api/token/claims (or any protected route)",
        note: "Plugin caches JWT; do not paste Bearer from chat"
      },
      discovery: {
        resourceUri: "doc:discovery",
        http: "/api/mcp/resource/doc:discovery"
      },
      skills: {
        resourceUris: ["doc:skills", "skills:skills"],
        http: "/api/mcp/resource/doc:skills"
      },
      troubleshooting: {
        resourceUri: "guide:troubleshooting",
        http: "/api/mcp/resource/guide:troubleshooting"
      },
      clawHub: {
        skill: "openclaw skills install clawhub:identyclaw",
        plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin"
      },
      mcpDiscovery: "/.well-known/mcp",
      listResources: "/api/mcp/resources"
    },
    documentation: {
      swagger: "/api-docs/swagger.json",
      openapi: "/api-docs/swagger.json"
    },
    endpoints: {
      public: [
        "/health",
        "/api/login/timestamp",
        "/api/login",
        "/api/mcp/resources",
        "/api/mcp/resource/{uri}",
        "/api/mcp/schema",
        "/.well-known/mcp"
      ],
      authenticated: [
        "/api/logout",
        "/api/cruda",
        "/api/token/claims",
        "/api/sessions"
      ]
    },
    endpointsList: [
      "/health",
      "/api/login/timestamp",
      "/api/login",
      "/api/logout",
      "/api/mcp/resources",
      "/api/mcp/resource/{uri}",
      "/api/cruda",
      "/api/sessions",
      "/.well-known/mcp"
    ],
    mcp: {
      resources: "/api/mcp/resources",
      schema: "/api/mcp/schema",
      discovery: "/.well-known/mcp",
      streamableHttp: "/mcp",
      tools: ["list_resources", "get_resource"],
      httpAccessForAgents: {
        discovery: "/.well-known/mcp",
        list: "/api/mcp/resources",
        getByUri: "/api/mcp/resource/{uri}",
        skills: "/api/mcp/resource/doc:skills",
        troubleshooting: "/api/mcp/resource/guide:troubleshooting",
        loginGuide: "/api/mcp/resource/guide:agent-login",
        mcp: "/mcp"
      },
      note:
        "Doc resources are public. OpenClaw agents should prefer identyclaw_ensure_session + identyclaw_request so JWT never enters the model context. Do not bare-GET /mcp — use an MCP client (initialize → Mcp-Session-Id) or /.well-known/mcp / /api/mcp/resources."
    },
    doNotUseRawHttpGetOn: "/mcp",
    requestId,
    timestamp: new Date().toISOString()
  });
});

/**
 * @route GET /.well-known/mcp
 * @desc MCP discovery metadata for agents and clients
 */
router.get("/.well-known/mcp", (req, res) => {
  const requestId = req.requestId || ulid();

  logger.infoWithContext("MCP discovery requested", {
    component: "DiscoveryRoutes",
    requestId,
    endpoint: "/.well-known/mcp",
    ip: req.ip
  });

  const host = req.get("host");
  const protocol = req.protocol || "https";
  const baseUrl = host ? `${protocol}://${host}` : null;

  return res.status(200).json({
    title: "RODiT API MCP Discovery",
    transport: {
      protocol: "streamable-http",
      endpoint: "/mcp",
      absoluteEndpoint: baseUrl ? `${baseUrl}/mcp` : null
    },
    resources: {
      list: "/api/mcp/resources",
      getByUri: "/api/mcp/resource/{uri}",
      examples: [
        "/api/mcp/resource/doc:discovery",
        "/api/mcp/resource/doc:skills",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting",
        "/api/mcp/resource/openapi:swagger"
      ]
    },
    tools: [
      { name: "list_resources", description: "Lists available MCP resources" },
      { name: "get_resource", description: "Retrieves a resource by URI" }
    ],
    agentGuide: {
      summary:
        "OpenClaw + IdentyClaw: ensure_session, then call /api/cruda/* via identyclaw_request (JWT never to model). Raw login: doc:skills.",
      tlsNote: "Self-signed TLS — use curl -sk",
      login: {
        openClawPreferred:
          "identyclaw_ensure_session({ apiEndpoint }) then identyclaw_request({ method, path, apiEndpoint })",
        timestamp: "/api/login/timestamp",
        exchange: "/api/login"
      },
      clawHub: {
        skill: "openclaw skills install clawhub:identyclaw",
        plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin"
      }
    },
    doNotUseRawHttpGetOn: "/mcp",
    httpAccessForAgents: {
      discovery: "/.well-known/mcp",
      list: "/api/mcp/resources",
      getByUri: "/api/mcp/resource/{uri}",
      health: "/health",
      skills: "/api/mcp/resource/doc:skills",
      loginGuide: "/api/mcp/resource/guide:agent-login",
      troubleshooting: "/api/mcp/resource/guide:troubleshooting",
      examples: [
        "/api/mcp/resource/doc:discovery",
        "/api/mcp/resource/doc:skills",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting"
      ]
    },
    transportNote:
      "For curl and shell agents, use httpAccessForAgents paths. JWT login uses GET /api/login/timestamp and POST /api/login (not MCP session headers).",
    requestId,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
