/**
 * Streamable HTTP MCP transport for documentation tools.
 * Uses @modelcontextprotocol/sdk StreamableHTTPServerTransport with
 * Mcp-Session-Id sessions and proper GET SSE handling.
 */

const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;

const SERVER_INFO = {
  name: "rodit-cruda-scaffold",
  version: "1.0.0"
};

const PUBLIC_TOOL_NAMES = ["list_resources", "get_resource"];

const transportsBySessionId = {};

function sendMcpTransportSessionError(res, req) {
  if (res.headersSent) {
    return;
  }
  return sendError(res, {
    statusCode: 400,
    requestId: req.requestId || ulid(),
    code: "MCP_TRANSPORT_SESSION_REQUIRED",
    message:
      "MCP Streamable HTTP transport requires a valid Mcp-Session-Id from an MCP client after initialize. Do not bare-GET /mcp.",
    details: { mcpDiscovery: "/.well-known/mcp" }
  });
}

function sendMcpJsonRpcError(res, status, message) {
  if (res.headersSent) {
    return;
  }
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null
  });
}

function resolveSessionId(req) {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return typeof raw === "string" ? raw : undefined;
}

function expressReqFromExtra(extra, fallbackReq) {
  const fromAuth = extra?.authInfo?.extra?.expressReq;
  if (fromAuth) {
    return fromAuth;
  }
  return fallbackReq || { headers: extra?.requestInfo?.headers || {}, user: null };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function toolError(err) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              code: err.code || "MCP_TOOL_ERROR",
              message: err.message,
              statusCode: err.statusCode,
              details: err.details
            }
          },
          null,
          2
        )
      }
    ],
    isError: true
  };
}

async function setupMcpHttpTransport(app, { authenticate, getResource, listResources }) {
  const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return next();
    }
    return authenticate(req, res, () => {
      if (req.user) {
        req.auth = {
          token: authHeader.replace(/^bearer\s+/i, ""),
          clientId: String(req.user.sub || req.user.id || "agent"),
          scopes: [],
          extra: { expressReq: req }
        };
      }
      next();
    });
  };

  const createMcpServer = (boundReq) => {
    const mcpServer = new McpServer({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      instructions:
        "RODiT CRUDA scaffold MCP: list_resources/get_resource are public docs. Prefer identyclaw_ensure_session + identyclaw_request for authenticated REST against /api/cruda/*."
    });

    mcpServer.tool(
      "list_resources",
      "Lists available MCP documentation resources",
      {
        limit: z.number().optional(),
        cursor: z.string().optional()
      },
      async ({ limit, cursor }, extra) => {
        const req = expressReqFromExtra(extra, boundReq);
        const result = await listResources(req, { limit, cursor });
        return toolResult(result);
      }
    );

    mcpServer.tool(
      "get_resource",
      "Retrieves an MCP documentation resource by URI",
      { uri: z.string() },
      async ({ uri }, extra) => {
        try {
          const resource = await getResource(uri);
          const text =
            typeof resource.content === "string"
              ? resource.content
              : JSON.stringify(resource.content, null, 2);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return toolError(err);
        }
      }
    );

    return mcpServer;
  };

  const mcpPostHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpPostHandler",
      requestId: req.requestId,
      hasSessionId: Boolean(sessionId)
    };

    try {
      let transport = sessionId ? transportsBySessionId[sessionId] : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            transportsBySessionId[sid] = transport;
            logger.infoWithContext("MCP session initialized", {
              ...logContext,
              sessionId: sid
            });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transportsBySessionId[sid]) {
            delete transportsBySessionId[sid];
            logger.infoWithContext("MCP session transport closed", {
              ...logContext,
              sessionId: sid
            });
          }
        };

        const mcpServer = createMcpServer(req);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!transport) {
        sendMcpJsonRpcError(res, 400, "Bad Request: No valid MCP transport session.");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.errorWithContext(
        "MCP POST request failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      sendMcpJsonRpcError(res, 500, "Internal server error");
    }
  };

  const mcpGetHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpGetHandler",
      requestId: req.requestId,
      sessionId
    };

    if (!sessionId || !transportsBySessionId[sessionId]) {
      sendMcpTransportSessionError(res, req);
      return;
    }

    try {
      await transportsBySessionId[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.errorWithContext(
        "MCP GET (SSE) request failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpDeleteHandler",
      requestId: req.requestId,
      sessionId
    };

    if (!sessionId || !transportsBySessionId[sessionId]) {
      sendMcpTransportSessionError(res, req);
      return;
    }

    try {
      await transportsBySessionId[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.errorWithContext(
        "MCP DELETE (session terminate) failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  app.post("/mcp", optionalAuth, mcpPostHandler);
  app.get("/mcp", optionalAuth, mcpGetHandler);
  app.delete("/mcp", optionalAuth, mcpDeleteHandler);

  logger.infoWithContext("Streamable HTTP transport mounted", {
    component: "MCPHttpIntegration",
    operation: "setupMcpHttpTransport",
    mode: "stateful-per-session",
    tools: PUBLIC_TOOL_NAMES
  });
}

async function closeMcpHttpTransports() {
  const sessionIds = Object.keys(transportsBySessionId);
  for (const sessionId of sessionIds) {
    try {
      await transportsBySessionId[sessionId].close();
    } catch (error) {
      logger.warnWithContext(
        "Error closing MCP transport",
        { component: "MCPHttpIntegration", operation: "closeMcpHttpTransports", sessionId },
        error instanceof Error ? error : new Error(String(error))
      );
    }
    delete transportsBySessionId[sessionId];
  }
}

module.exports = {
  setupMcpHttpTransport,
  closeMcpHttpTransports,
  SERVER_INFO
};
