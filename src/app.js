/**
 * RODiT Authentication API Server
 *
 * This application demonstrates the implementation of RODiT-based authentication
 * using the RODiT Authentication SDK.
 *
 * Copyright (c) 2025 Discernible Inc. All rights reserved.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
const { ulid } = require("ulid");
const swaggerUi = require("swagger-ui-express");
const winston = require("winston");
const LokiTransport = require("winston-loki");
const {
  RoditClient,
  logger,
  validateConfig,
  errorResponse,
  config,
  resolveHealthyNearRpcUrl
} = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { setExpressSessionStore } = require(path.join(
  path.dirname(require.resolve("@rodit/rodit-auth-be")),
  "lib/auth/sessionmanager.js"
));
const { probeNearRpcStatus } = require("./services/near-rpc-probe.service");
const { createHealthHandler } = require("./services/health.service");
const {
  logResolvedConfigSnapshot,
  logNginxPublicRateLimitSettings,
  redactRpcHostLabel
} = require("./services/startup-config.service");

const WINSTON_MESSAGE = Symbol.for("message");
const LOKI_TRANSPORT_KEYS = new Set(["level", "message", "timestamp", "label", "labels"]);

function stringifyLogLine(value) {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (nestedValue instanceof Error) {
      return {
        name: nestedValue.name,
        message: nestedValue.message,
        stack: nestedValue.stack
      };
    }
    return nestedValue;
  });
}

function createLokiLineFormat() {
  return winston.format((info) => {
    const payload = {};
    for (const [key, value] of Object.entries(info)) {
      payload[key] = value;
    }

    info[WINSTON_MESSAGE] = stringifyLogLine(payload);

    // winston-loki sends remaining metadata as Loki structured metadata. This
    // Loki endpoint drops records when that metadata contains nested objects.
    for (const key of Object.keys(info)) {
      if (!LOKI_TRANSPORT_KEYS.has(key)) {
        delete info[key];
      }
    }

    return info;
  })();
}

const SERVICE_NAME = config.get("SERVICE_NAME");
const HEALTH_CHECKS_CACHE_MS = Number(config.get("HEALTH_CHECKS_CACHE_MS"));
const isMainTier = () => config.get("NODE_ENV") === "main";

function tierSwaggerServerUrl() {
  const publicPort = config.has("PUBLIC_PORT") ? config.get("PUBLIC_PORT") : "8443";
  return `https://${SERVICE_NAME}:${publicPort}`;
}

function abortSessionStorageSetup(message, context, error) {
  logger.errorWithContext(message, context, error);
  if (isMainTier()) {
    process.exit(1);
  }
}

// Configure winston-loki logging BEFORE creating RoditClient
(() => {
  try {
    const lokiUrl = config.has("LOKI_URL") ? config.get("LOKI_URL") : null;
    const logLevel = config.get("LOG_LEVEL");
    const skipTlsRaw = config.get("LOKI_TLS_SKIP_VERIFY");
    const skipTls =
      skipTlsRaw === true || skipTlsRaw === "true" || String(skipTlsRaw).toLowerCase() === "true";
    const basicAuth = config.has("LOKI_BASIC_AUTH") ? config.get("LOKI_BASIC_AUTH") : null;

    const transports = [
      new winston.transports.Console({ format: winston.format.json(), level: logLevel })
    ];

    if (lokiUrl) {
      const lokiOptions = {
        host: lokiUrl,
        labels: { app: SERVICE_NAME, service_name: SERVICE_NAME, component: "rodit-sdk" },
        json: true,
        level: logLevel,
        batching: false,
        gracefulShutdown: true,
        replaceTimestamp: true,
        timeout: 10000,
        interval: 1,
        format: createLokiLineFormat()
      };

      if (basicAuth) {
        lokiOptions.basicAuth = basicAuth;
      }
      if (skipTls) {
        lokiOptions.ssl = { rejectUnauthorized: false };
      }

      const lokiTransport = new LokiTransport(lokiOptions);

      lokiTransport.on("error", (err) => {
        logger.errorWithContext(
          "Loki transport error",
          { component: "AppLifecycle", operation: "logging.lokiTransport" },
          err instanceof Error ? err : new Error(String(err?.message || err))
        );
      });

      lokiTransport.on("warn", (warn) => {
        logger.warnWithContext("Loki transport warning", {
          component: "AppLifecycle",
          operation: "logging.lokiTransport",
          warnDetail: typeof warn === "string" ? warn : JSON.stringify(warn)
        });
      });

      transports.push(lokiTransport);
    }

    logger.setLogger(
      winston.createLogger({
        level: logLevel,
        format: winston.format.json(),
        transports
      })
    );
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e?.message || e));
    logger.warnWithContext(
      "SDK Loki logger injection failed; using default SDK logger",
      { component: "AppLifecycle", operation: "startup.loggerInjection" },
      err
    );
  }
})();

// Logger is now available with all SDK methods
// Use logger.infoWithContext(), logger.errorWithContext(), etc.

// Create temporary client instance to access middleware utilities
const tempClient = new RoditClient();
const ratelimitmw = tempClient.getRateLimitMiddleware();

// Will be set to fully initialized client later
let roditClient;
let sessionStore; // Store reference for graceful shutdown

// Authentication middleware will be created after client initialization
let authenticate_apicall;
let validatepermissions;

// Import routes
const homeRoute = require("./routes/home");
const authPublicRoutes = require("./routes/auth.public.routes");
const agentPublicRoutes = require("./routes/agent.public.routes");
const discoveryRoutes = require("./routes/discovery.public.routes");
const signclientRoute = require("./routes/signclient");
const mcpRoutes = require("./routes/mcp.public.routes");

// Import protected routes (require authentication)
const metricsRoutes = require("./protected/metricsroutes");
const sessionRoutes = require("./routes/session.privileged.routes");

// Configure SQLite session storage using express-session
try {
  let SQLiteStore;
  try {
    SQLiteStore = require('connect-sqlite3')(session);
  } catch (err) {
    abortSessionStorageSetup(
      'connect-sqlite3 not installed; persistent session storage unavailable',
      {
        component: 'SessionStorage',
        suggestion: 'Install with: npm install express-session connect-sqlite3'
      },
      err
    );
    SQLiteStore = null;
  }

  if (SQLiteStore) {
    const DB_PATH = config.get("API_DEFAULT_OPTIONS.DB_PATH");
    const dbDir = path.dirname(DB_PATH);
    const dbFile = path.basename(DB_PATH);

    sessionStore = new SQLiteStore({
      db: dbFile,
      dir: dbDir,
      table: 'sessions',
    });

    if (typeof setExpressSessionStore === 'function') {
      setExpressSessionStore(sessionStore);
    } else {
      abortSessionStorageSetup(
        'setExpressSessionStore is not available in this SDK version',
        {
          component: 'SessionStorage',
          note: 'Upgrade @rodit/rodit-auth-be to enable express-session store injection'
        }
      );
    }

    logger.infoWithContext('SQLite session storage configured successfully', {
      component: 'SessionStorage',
      storageType: 'SQLite (connect-sqlite3)',
      dbPath: DB_PATH,
      table: 'sessions',
      persistent: true
    });
  } else if (!isMainTier()) {
    logger.warnWithContext('Using default in-memory session storage', {
      component: 'SessionStorage',
      storageType: 'InMemorySessionStorage',
      persistent: false
    });
  }
} catch (e) {
  abortSessionStorageSetup(
    'Error configuring session storage',
    { component: 'SessionStorage' },
    e instanceof Error ? e : new Error(String(e?.message || e))
  );
}

// Log application startup
logger.info("Starting RODiT Authentication API Server", {
  nodeEnv: config.get('NODE_ENV'),
  pid: process.pid,
  version: config.has('npm_package_version') ? config.get('npm_package_version') : 'unknown',
  nodeVersion: process.version,
});

// Initialize application
const app = express();

// Set up request ID and tracing middleware
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || req.headers["x-correlation-id"] || ulid();
  req.startTime = Date.now();
  next();
});

// Mount public routes
app.use("/", discoveryRoutes);
app.use("/api", homeRoute);
app.use("/api", signclientRoute);
app.use("/api/mcp", mcpRoutes);

// Import additional protected routes
const crudaRoutes = require("./protected/cruda");

// Development environment logging
const LOG_LEVEL = config.get('LOG_LEVEL', 'info');
const isProduction = ['info', 'warn', 'error'].includes(LOG_LEVEL);
if (!isProduction) {
  logger.info("Running in development mode - enhanced logging enabled");
}

// Use SDK-provided rate limiting helper

// Default rate limits - will be updated from RODiT metadata
let ratelimiter = ratelimitmw(100, 15);

// OpenAPI spec — authoritative copy in api-docs/swagger.json (documentation-standard.md)
const swaggerPath = path.join(__dirname, "../api-docs/swagger.json");
const swaggerSpec = JSON.parse(fs.readFileSync(swaggerPath, "utf8"));

// Configure Express to trust proxies for correct client IP detection
// Using a specific configuration instead of 'true' to prevent IP spoofing
app.set("trust proxy", 1);

// Configure middleware
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

// Malformed JSON bodies → standard ErrorResponse envelope
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    const requestId = req.requestId || ulid();
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "INVALID_JSON",
      message: "Malformed JSON in request body"
    });
  }
  return next(err);
});

// Serve raw OpenAPI JSON before Swagger UI so /api-docs/swagger.json is not HTML
app.get("/api-docs/swagger.json", (req, res) => {
  res.type("application/json").json(swaggerSpec);
});

// Setup Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Add request ID to all error responses
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    // If this is an error response, add the request ID
    if (body && (body.error || body.success === false) && req.requestId) {
      body.requestId = req.requestId;
    }
    return originalJson.call(this, body);
  };
  next();
});

// Performance monitoring middleware
app.use((req, res, next) => {
  const crypto = require("crypto");
  req.traceId = req.headers["x-trace-id"] || crypto.randomUUID();

  if (roditClient) {
    const performanceService = roditClient.getPerformanceService();
    if (performanceService) {
      performanceService.recordRequest(req);
    }
  }

  res.on("finish", () => {
    const duration = Date.now() - req.startTime;
    req.duration = duration;
    const pathOnly = req.originalUrl.split("?")[0];

    if (roditClient) {
      const performanceService = roditClient.getPerformanceService();
      if (performanceService) {
        performanceService.recordMetric("request_duration_ms", duration, {
          method: req.method,
          path: req.path,
          status: res.statusCode,
        });

        if (res.statusCode >= 400) {
          performanceService.recordMetric("error_count", 1, {
            method: req.method,
            path: req.path,
            status: res.statusCode,
          });
        }
      }
    }

    logger.infoWithContext("Request completed", {
      component: "API",
      operation: "http.request.complete",
      method: req.method,
      path: pathOnly,
      statusCode: res.statusCode,
      duration,
      requestId: req.requestId,
      traceId: req.traceId,
      userAgent: req.get("User-Agent")
    });

    logger.debugWithContext("Request performance metrics", {
      component: "API",
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      requestId: req.requestId,
      traceId: req.traceId,
      referer: req.get("Referer"),
      contentLength: res.get("Content-Length"),
      contentType: res.get("Content-Type"),
    });

    logger.metric("request_duration_ms", duration, {
      method: req.method,
      path: req.path,
      status: res.statusCode,
    });
  });
  next();
});

// Apply rate limiting to all routes
// app.use((req, res, next) => ratelimiter(req, res, next));

// Action logging middleware - tracks user actions
app.use((req, res, next) => {
  if (req.logAction) {
    logger.infoWithContext("Action executed", {
      component: "API",
      action: req.logAction,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous",
      roditId: req.user ? req.user.roditId : null,
      requestId: req.requestId,
      traceId: req.traceId,
      timestamp: new Date().toISOString(),
      service: req.logService,
      resource: req.resource || req.path,
    });
  }
  next();
});

app.use("/", homeRoute);

// Logout route will be mounted after middleware initialization

// Protected routes will be mounted after middleware initialization

// Token claims endpoint will be mounted after middleware initialization

function setupFallbackHandlers() {
  app.use((err, req, res, next) => {
    const crypto = require("crypto");
    const requestId = req.requestId || ulid();
    const traceId = req.traceId || crypto.randomUUID();
    const omitStack = isMainTier();

    logger.errorWithContext(
      "Server error occurred",
      {
        component: "API",
        message: err.message,
        method: req.method,
        url: req.originalUrl,
        userIP: req.ip,
        userId: req.user ? req.user.id : "anonymous",
        roditId: req.user ? req.user.roditId : null,
        errorCode: err.code || "106",
        route: req.route ? req.route.path : "unknown",
        requestId,
        traceId,
        timestamp: new Date().toISOString(),
        service: req.logService,
        action: req.logAction || "unspecified",
        statusCode: err.statusCode || 500,
        stack: omitStack ? undefined : err.stack,
      },
      err
    );

    if (!omitStack) {
      logger.debugWithContext("Server error stack", {
        component: "API",
        requestId,
        stack: err.stack
      });
    }

    return sendError(res, {
      statusCode: err.statusCode && err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500,
      requestId,
      code: err.code || "SERVICE_UNAVAILABLE",
      message: err.statusCode && err.statusCode < 500 ? err.message : "Internal Server Error"
    });
  });
}

// Update rate limit once obtained config
function updateRateLimit(maxRequests, maxRqWindow) {
  const requestId = ulid();
  const startTime = Date.now();

  try {
    // Use SDK-exported ratelimitmw to rebuild middleware with new limits
    ratelimiter = ratelimitmw(maxRequests, maxRqWindow);

    const duration = Date.now() - startTime;
    logger.infoWithContext("Rate limit settings updated", {
      requestId,
      component: "RateLimiter",
      event: "updateRateLimit",
      maxRequests,
      windowDuration: maxRqWindow,
      duration,
      result: "success",
    });

    // Add metric for rate limit update
    logger.metric("rate_limit_operations", duration, {
      operation: "updateRateLimit",
      result: "success",
    });
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Failed to update rate limit settings",
      {
        requestId,
        component: "RateLimiter",
        event: "updateRateLimit",
        maxRequests,
        windowDuration: maxRqWindow,
        duration,
      },
      error,
      "rate_limit_error",
      {
        operation: "updateRateLimit",
        result: "error",
        duration,
      }
    );

    throw error;
  }
}

// Store server instance for graceful shutdown
let server;
let db;

// Function to update Swagger servers configuration from RODIT token
function updateSwaggerServers(subjectuniqueidentifier_url) {
  const requestId = ulid();

  try {
    if (subjectuniqueidentifier_url && subjectuniqueidentifier_url !== "N/A") {
      // Update the swagger specification with the dynamic URL
      swaggerSpec.servers = [
        {
          url: subjectuniqueidentifier_url,
          description: "RODiT API Server (from token)",
        },
      ];

      logger.infoWithContext("Swagger servers updated with RODIT token URL", {
        requestId,
        component: "SwaggerConfig",
        event: "updateSwaggerServers",
        apiUrl: subjectuniqueidentifier_url,
        serverUrl: subjectuniqueidentifier_url,
      });
    } else {
      const tierUrl = tierSwaggerServerUrl();
      swaggerSpec.servers = [
        {
          url: tierUrl,
          description: `${SERVICE_NAME} (${config.get("NODE_ENV")} tier)`,
        },
      ];

      logger.warnWithContext(
        "No valid API URL in RODIT token; using tier server URL from config",
        {
          requestId,
          component: "SwaggerConfig",
          event: "updateSwaggerServers",
          apiUrl: subjectuniqueidentifier_url,
          serverUrl: tierUrl,
        }
      );
    }
  } catch (error) {
    logger.errorWithContext("Failed to update Swagger servers configuration", {
      requestId,
      component: "SwaggerConfig",
      event: "updateSwaggerServers",
      apiUrl: subjectuniqueidentifier_url,
    }, error);

    const tierUrl = tierSwaggerServerUrl();
    swaggerSpec.servers = [
      {
        url: tierUrl,
        description: `${SERVICE_NAME} (${config.get("NODE_ENV")} tier, error fallback)`,
      },
    ];
  }
}

// Function to display RODIT token information during startup
async function displayRoditInfo(configObject) {
  const requestId = ulid();
  const startTime = Date.now();

  try {
    const own_rodit = configObject.own_rodit;
    const metadata = own_rodit.metadata;
    const token_id = own_rodit.token_id;

    // Get SDK version from package.json
    const packageJson = require("../package.json");
    const sdkVersion =
      packageJson.dependencies["@rodit/rodit-auth-be"] || "unknown";

    // Extract network and contract from environment or metadata
    const nearContractId =
      (config.has('NEAR_CONTRACT_ID') ? config.get('NEAR_CONTRACT_ID') : null) ||
      metadata.serviceprovider_id?.split(";")[1]?.replace("sc=", "") ||
      "unknown";
    const network = nearContractId.includes("testnet") ? "testnet" : "mainnet";

    logger.info("\n=== RODiT Authentication System ===");
    logger.info(
      `Version ${sdkVersion.replace(
        "^",
        ""
      )} running on ${network} at Smart Contract ${nearContractId}`
    );
    logger.info("Get help with: npm run help\n");

    logger.info("RODiT Contents");
    logger.info("▹▸▹▹▹ Authentication token information loaded...\n");

    // Display token information in a structured format
    const roditData = {
      token_id: token_id,
      metadata: {
        allowed_cidr: metadata.allowed_cidr || "N/A",
        allowed_iso3166list: metadata.allowed_iso3166list || "N/A",
        jwt_duration: metadata.jwt_duration || "N/A",
        max_requests: metadata.max_requests || "0",
        maxrq_window: metadata.maxrq_window || "0",
        not_after: metadata.not_after || "N/A",
        not_before: metadata.not_before || "N/A",
        openapijson_url: metadata.openapijson_url || "N/A",
        permissioned_routes: metadata.permissioned_routes || "N/A",
        serviceprovider_id: metadata.serviceprovider_id || "N/A",
        serviceprovider_signature: metadata.serviceprovider_signature || "N/A",
        subjectuniqueidentifier_url:
          metadata.subjectuniqueidentifier_url || "N/A",
        userselected_dn: metadata.userselected_dn || "N/A",
        webhook_cidr: metadata.webhook_cidr || "N/A",
        webhook_url: metadata.webhook_url || "N/A",
      },
    };

    // Log the RODIT data in a structured context for better indexing
    logger.infoWithContext("RODIT token information", roditData);
    logger.info("");

    // Update Swagger servers configuration with the API URL from RODIT token
    updateSwaggerServers(metadata.subjectuniqueidentifier_url);
    const duration = Date.now() - startTime;
    logger.infoWithContext("RODIT token information displayed successfully", {
      requestId,
      component: "RoditInfo",
      event: "displayRoditInfo",
      duration,
      tokenId: token_id,
      network,
      contractId: nearContractId,
    });

    // Add metric for RODIT info display
    logger.metric("rodit_info_operations", duration, {
      operation: "display",
      result: "success",
    });
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Failed to display RODIT token information",
      {
        requestId,
        component: "RoditInfo",
        event: "displayRoditInfo",
        duration,
      },
      error,
      "rodit_info_error",
      {
        operation: "display",
        result: "error",
        duration,
      }
    );

    // Don't throw the error - just log it and continue
    logger.warn(
      "RODIT token information could not be displayed, continuing with startup..."
    );
  }
}

// Start the server with proper initialization
async function startServer() {
  const requestId = ulid();
  const startTime = Date.now();

  logger.infoWithContext("Server starting", {
    requestId,
    component: "AppLifecycle",
    event: "startServer",
    nodeEnv: config.get('NODE_ENV'),
    pid: process.pid,
  });

  try {
    // Make client available to routes via app.locals
    app.locals.roditClient = roditClient;

    logger.infoWithContext("Initializing RODiT configuration", {
      requestId,
      component: "AppLifecycle",
      event: "startServer",
      status: "initializing",
      nodeEnv: config.get('NODE_ENV'),
      pid: process.pid,
    });

    // Initialize RODiT SDK properly
    logger.debug("RoditClient constructor completed", {
      component: "AppLifecycle",
      status: "constructor_done",
    });

    logger.debug("Creating and initializing RODiT client", {
      component: "AppLifecycle",
      status: "creating_client",
    });

    const primaryRpcUrl = config.has("NEAR_RPC_URL") ? config.get("NEAR_RPC_URL") : null;
    let selectedRpcUrl = primaryRpcUrl;
    if (typeof resolveHealthyNearRpcUrl === "function") {
      selectedRpcUrl = await resolveHealthyNearRpcUrl();
    } else if (primaryRpcUrl) {
      logger.warnWithContext("RPC URL resolver unavailable; using configured NEAR_RPC_URL", {
        component: "AppLifecycle",
        operation: "startup.resolveNearRpcUrl",
        fallback: "NEAR_RPC_URL"
      });
    }

    if (selectedRpcUrl && selectedRpcUrl !== primaryRpcUrl) {
      process.env.NEAR_RPC_URL = selectedRpcUrl;
      const probeTimeoutMs = Number(config.get("NEAR_RPC_TIMEOUT"));
      let primaryProbeOk = null;
      if (primaryRpcUrl) {
        const primaryProbe = await probeNearRpcStatus(primaryRpcUrl, probeTimeoutMs);
        primaryProbeOk = primaryProbe.ok;
      }
      const logContext = {
        component: "AppLifecycle",
        operation: "startup.resolveNearRpcUrl",
        primaryConfigured: Boolean(primaryRpcUrl),
        selectedSource: "resolveHealthyNearRpcUrl",
        primaryRpcHost: redactRpcHostLabel(primaryRpcUrl),
        selectedRpcHost: redactRpcHostLabel(selectedRpcUrl),
        ...(primaryProbeOk === false && { primaryProbeFailed: true })
      };
      if (primaryProbeOk === false) {
        logger.warnWithContext(
          "NEAR RPC startup fallback: primary endpoint unavailable; using alternate",
          logContext
        );
      } else {
        logger.infoWithContext("NEAR RPC startup: selected endpoint differs from config", logContext);
      }
    }
    
    // Create and initialize the client in one step
    roditClient = await RoditClient.create('server');
    
    // Update app.locals with the fully initialized client
    app.locals.roditClient = roditClient;

    // Create authentication middleware using initialized client
    authenticate_apicall = (req, res, next) => {
      return roditClient.authenticate(req, res, next);
    };

    validatepermissions = (req, res, next) => {
      return roditClient.authorize(req, res, next);
    };

    logger.info("Authentication middleware initialized", {
      component: "AppLifecycle",
      status: "middleware_ready"
    });

    logger.infoWithContext("Running startup checks", {
      component: "AppLifecycle",
      operation: "startup.validateConfig"
    });

    try {
      validateConfig(logger);
      logger.infoWithContext("SDK configuration validated", {
        component: "AppLifecycle",
        operation: "startup.validateConfig"
      });
    } catch (configErr) {
      logger.errorWithContext(
        "Configuration validation failed",
        {
          component: "AppLifecycle",
          operation: "startup.validateConfig"
        },
        configErr
      );
      throw configErr;
    }

    app.get("/health", createHealthHandler({ app, config, logger, cacheMs: HEALTH_CHECKS_CACHE_MS }));

    // Auth routes (aligned with idclawserver-idc / OpenClaw plugin)
    app.use("/api", authPublicRoutes);
    app.use("/api", agentPublicRoutes);

    // Protected routes
    app.use("/api/cruda", authenticate_apicall, validatepermissions, crudaRoutes);
    app.use("/api/metrics", metricsRoutes);
    app.use("/api/sessions", sessionRoutes);
    
    // Mount token claims endpoint
    app.get("/api/token/claims", authenticate_apicall, (req, res) => {
      return res.json({
        requestId: req.requestId,
        user: req.user || null,
      });
    });

    const { setupMcpHttpTransport } = require("./services/mcp-http.service");
    await setupMcpHttpTransport(app, {
      authenticate: authenticate_apicall,
      getResource: (uri) => mcpRoutes.mcpService.getResource(uri),
      listResources: (req, options) => mcpRoutes.mcpService.listAvailableResources(req, options)
    });

    app.use((req, res) => {
      const requestId = req.requestId || ulid();
      logger.infoWithContext("404 - Endpoint not found", {
        component: "AppLifecycle",
        method: req.method,
        url: req.originalUrl,
        requestId
      });
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "ENDPOINT_NOT_FOUND",
        message: "Endpoint not found"
      });
    });

    setupFallbackHandlers();
    
    logger.info("Protected routes mounted", {
      component: "AppLifecycle", 
      status: "routes_mounted"
    });

    // Get and apply configuration
    logger.debug("Attempting to retrieve RODiT configuration", {
      component: "AppLifecycle",
      status: "getting_config",
    });
    
    const configObject = await roditClient.getConfigOwnRodit();
    if (!configObject) {
      logger.error("RODiT configuration not found - no credentials available", {
        component: "AppLifecycle",
        status: "config_missing",
        suggestion: "Check Vault credentials or RODIT_NEAR_CREDENTIALS_SOURCE setting"
      });
      throw new Error("Failed to initialize RODiT configuration");
    }

    logger.info("RODiT configuration successfully loaded", {
      component: "AppLifecycle",
      status: "config_loaded",
      hasOwnRodit: !!(configObject && configObject.own_rodit)
    });

    // Display RODIT token information
    await displayRoditInfo(configObject);

    // Update rate limits if applicable
    const own_rodit = configObject.own_rodit;
    if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
      updateRateLimit(
        own_rodit.metadata.maxrequests,
        own_rodit.metadata.maxrqwindow
      );
    }

    // Start the HTTP server
    const port = configObject.port || 8080;
    server = app.listen(port, () => {
      const serverStartDuration = Date.now() - startTime;

      logger.infoWithContext(
        "HTTP server started successfully",
        {
          requestId,
          component: "AppLifecycle",
          event: "startServer",
          port,
          duration: serverStartDuration,
          protocol: "http",
          swagger: `/api-docs`,
          nodeEnv: config.get('NODE_ENV'),
          pid: process.pid,
        }
      );

      // Add metric for server startup
      logger.metric("server_operations", serverStartDuration, {
        operation: "startup",
        result: "success",
      });

      logger.info(`\nRODiT Authentication API Server running on port ${port}`);

      const endpoints = [
        "  / - API discovery (agentGuide, OpenClaw login paths)",
        "  /.well-known/mcp - MCP discovery for agents",
        "  GET /api/login/timestamp - Login challenge (timestamp pair)",
        "  POST /api/login - Login with RODiT credentials",
        "  GET /api/mcp/resources - Public MCP doc list (no JWT)",
        "  GET /api/mcp/resource/doc:skills - Agent login cheat sheet",
        "  POST /api/logout - Logout (Bearer JWT; expired tokens allowed)",
        "  /api/cruda - CRUDA showcase (requires authentication + permissions)",
        "  /api/sessions - Session admin (authenticate + authorize)",
        "  /api-docs - Swagger API documentation",
      ];

      logger.info("Available endpoints:");
      endpoints.forEach((endpoint) => logger.info(endpoint));
      logger.info("");

      logNginxPublicRateLimitSettings(logger);
      setTimeout(() => {
        logResolvedConfigSnapshot(logger, config);
      }, 15000);
    });

    // Graceful shutdown handling
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Server initialization failed",
      {
        requestId,
        component: "AppLifecycle",
        event: "startServer",
        duration,
        nodeEnv: config.get('NODE_ENV'),
        pid: process.pid,
      },
      error,
      "server_startup_error",
      {
        operation: "startServer",
        result: "error",
        duration,
      }
    );

    process.exit(1);
  }
}

// Graceful shutdown function
async function gracefulShutdown(signal) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.infoWithContext("Shutting down gracefully", {
    requestId,
    component: "AppLifecycle",
    event: "gracefulShutdown",
    signal: signal || "unknown",
  });

  try {
    if (server) {
      server.close(async () => {
        const duration = Date.now() - startTime;
        logger.infoWithContext("HTTP server closed", {
          requestId,
          component: "AppLifecycle",
          event: "gracefulShutdown",
          signal: signal || "unknown",
          duration,
        });

        // Add metric for server shutdown
        logger.metric("server_operations", duration, {
          operation: "shutdown",
          result: "success",
        });

        // Close database connections
        await closeAllDatabases();

        process.exit(0);
      });
    } else {
      await closeAllDatabases();

      const duration = Date.now() - startTime;
      logger.infoWithContext(
        "Server shutdown completed (no active HTTP server)",
        {
          requestId,
          component: "AppLifecycle",
          event: "gracefulShutdown",
          signal: signal || "unknown",
          duration,
        }
      );

      process.exit(0);
    }
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Error during graceful shutdown",
      {
        requestId,
        component: "AppLifecycle",
        event: "gracefulShutdown",
        signal: signal || "unknown",
        duration,
      },
      error,
      "server_shutdown_error",
      {
        operation: "gracefulShutdown",
        result: "error",
        duration,
      }
    );

    // Force exit in case of shutdown errors
    process.exit(1);
  }
}

// Helper function to close all database connections
async function closeAllDatabases() {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debugWithContext("Closing all database connections", {
    requestId,
    component: "DatabaseManager",
    event: "closeAllDatabases",
  });

  // Check if db exists and has a close method before calling it
  if (db && typeof db.close === "function") {
    try {
      await db.close();

      const duration = Date.now() - startTime;
      logger.infoWithContext("Main database connection closed", {
        requestId,
        component: "DatabaseManager",
        event: "closeAllDatabases",
        database: "main-db",
        duration,
      });

      // Add metric for database close
      logger.metric("database_operations", duration, {
        operation: "close",
        database: "main-db",
        result: "success",
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.logErrorWithMetrics(
        "Error closing main database",
        {
          requestId,
          component: "DatabaseManager",
          event: "closeAllDatabases",
          database: "main-db",
          duration,
        },
        error,
        "database_error",
        {
          operation: "close",
          database: "main-db",
          result: "error",
          duration,
        }
      );
    }
  }

  try {
    const { closeMcpHttpTransports } = require("./services/mcp-http.service");
    await closeMcpHttpTransports();
  } catch (error) {
    logger.warnWithContext("Error closing MCP transports", {
      requestId,
      component: "MCPHttpIntegration",
      error: error.message
    });
  }

  // Close the CRUDA database connection
  try {
    if (crudaRoutes && typeof crudaRoutes.closeDatabase === 'function') {
      const crudaStartTime = Date.now();
      await crudaRoutes.closeDatabase();

      const crudaDuration = Date.now() - crudaStartTime;
      logger.infoWithContext("CRUDA database connection closed", {
        requestId,
        component: "DatabaseManager",
        event: "closeAllDatabases",
        database: "cruda-db",
        duration: crudaDuration,
      });

      // Add metric for CRUDA database close
      logger.metric("database_operations", crudaDuration, {
        operation: "close",
        database: "cruda-db",
        result: "success",
      });
    }
  } catch (error) {
    const crudaDuration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Error closing CRUDA database",
      {
        requestId,
        component: "DatabaseManager",
        event: "closeAllDatabases",
        database: "cruda-db",
        duration: crudaDuration,
      },
      error,
      "database_error",
      {
        operation: "close",
        database: "cruda-db",
        result: "error",
        duration: crudaDuration,
      }
    );
  }

  // Close the SQLite session store connection
  try {
    if (sessionStore && typeof sessionStore.close === 'function') {
      const sessionStartTime = Date.now();
      await new Promise((resolve, reject) => {
        sessionStore.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const sessionDuration = Date.now() - sessionStartTime;
      logger.infoWithContext("Session store connection closed", {
        requestId,
        component: "DatabaseManager",
        event: "closeAllDatabases",
        database: "session-store",
        duration: sessionDuration,
      });

      // Add metric for session store close
      logger.metric("database_operations", sessionDuration, {
        operation: "close",
        database: "session-store",
        result: "success",
      });
    }
  } catch (error) {
    const sessionDuration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Error closing session store",
      {
        requestId,
        component: "DatabaseManager",
        event: "closeAllDatabases",
        database: "session-store",
        duration: sessionDuration,
      },
      error,
      "database_error",
      {
        operation: "close",
        database: "session-store",
        result: "error",
        duration: sessionDuration,
      }
    );
  }
}

/**
 * Fetch and parse the OpenAPI specification
 * @param {RoditClient} client - RODiT client instance
 * @returns {Promise<Object>} OpenAPI specification
 */
async function getOpenApiSpec(client) {
  if (!client.openApiUrl) {
    throw new Error('OpenAPI URL not configured');
  }
  
  if (client.openApiSpec) {
    return client.openApiSpec;
  }
  
  try {
    const response = await fetch(client.openApiUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
    }
    
    client.openApiSpec = await response.json();
    return client.openApiSpec;
  } catch (error) {
    const logger = client.getLogger();
    logger.error('Failed to fetch OpenAPI specification', {
      component: 'App',
      method: 'getOpenApiSpec',
      url: client.openApiUrl,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get available API endpoints from the OpenAPI spec
 * @param {RoditClient} client - RODiT client instance
 * @returns {Promise<Object>} Map of available endpoints
 */
async function getAvailableEndpoints(client) {
  const spec = await getOpenApiSpec(client);
  const endpoints = {};
  
  // Extract endpoints from the OpenAPI spec
  const paths = spec.paths || {};
  
  for (const [path, methods] of Object.entries(paths)) {
    endpoints[path] = {};
    
    for (const [method, definition] of Object.entries(methods)) {
      if (method === 'parameters') continue; // Skip non-method properties
      
      endpoints[path][method] = {
        operationId: definition.operationId,
        summary: definition.summary,
        description: definition.description,
        parameters: definition.parameters,
        requestBody: definition.requestBody,
        responses: definition.responses
      };
    }
  }
  
  return endpoints;
}

// Start the server
startServer();

// Export for testing purposes
module.exports = { app, startServer, getOpenApiSpec, getAvailableEndpoints };
