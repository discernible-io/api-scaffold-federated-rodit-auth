const express = require("express");
const router = express.Router();
const { RoditClient, errorResponse, config } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const webhook = sdkClient.getWebhookHandler();
const logger = sdkClient.getLogger();
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid"); // Adding ulid for request IDs
// Logger methods are available directly on the logger object

const DB_PATH = config.get("API_DEFAULT_OPTIONS.DB_PATH");
const includeDebugDetails = () => config.get("LOG_LEVEL") === "debug";

// Database connection
let db;

// Initialize database and export a function that can be awaited by app.js
const initializeDatabase = async () => {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debugWithContext("Starting database initialization", {
    requestId,
    component: "CRUDARouter",
    event: "initializeDatabase",
    dbPath: DB_PATH,
  });

  try {
    // Initialize SQLite database
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    // Create comments table if it doesn't exist
    await db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment TEXT NOT NULL,
      author TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const duration = Date.now() - startTime;
    logger.infoWithContext("SQLite database initialized successfully", {
      requestId,
      component: "CRUDARouter",
      event: "initializeDatabase",
      dbPath: DB_PATH,
      duration,
    });

    // Add metric for successful operation
    logger.metric("database_operations", duration, {
      operation: "initializeDatabase",
      result: "success",
    });

    return db;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Error initializing SQLite database",
      {
        requestId,
        component: "CRUDARouter",
        event: "initializeDatabase",
        dbPath: DB_PATH,
        duration,
      },
      error,
      "database_error",
      {
        operation: "initializeDatabase",
        result: "error",
        duration,
      }
    );
    throw error;
  }
};

// Expose the database connection for proper cleanup in app.js
const getDatabase = () => db;

// Gracefully close the CRUDA database connection
const closeDatabase = async () => {
  const requestId = ulid();
  const startTime = Date.now();

  try {
    if (db && typeof db.close === "function") {
      await db.close();
      const duration = Date.now() - startTime;
      logger.infoWithContext("SQLite database closed for CRUDA router", {
        requestId,
        component: "CRUDARouter",
        event: "closeDatabase",
        dbPath: DB_PATH,
        duration,
      });
    } else {
      logger.debugWithContext("No CRUDA SQLite connection to close", {
        requestId,
        component: "CRUDARouter",
        event: "closeDatabase",
        dbPath: DB_PATH,
      });
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.logErrorWithMetrics(
      "Error closing CRUDA SQLite database",
      {
        requestId,
        component: "CRUDARouter",
        event: "closeDatabase",
        dbPath: DB_PATH,
        duration
      },
      error,
      "database_error",
      { operation: "closeDatabase", result: "error", duration }
    );
  }
};

// Forward function to use the SDK's webhook sender with simplified interface (payload, req)
// payload shape: { event: string, data?: any, isError?: boolean }
const logAndSendWebhook = async (payload, req = null) => {
  // Add debug logging at the start
  logger.debugWithContext("logAndSendWebhook called", {
    component: "CRUDA",
    event: payload?.event,
    hasRequest: !!req,
    requestId: req?.requestId || "none",
    payloadKeys: payload ? Object.keys(payload) : "no payload"
  });

  try {
    // Use the roditClient from app.locals instead of direct webhook import
    const roditClient = req?.app?.locals?.roditClient;
    
    // Enhanced debug logging for roditClient availability
    logger.debugWithContext("Checking roditClient availability", {
      component: "CRUDA",
      hasRoditClient: !!roditClient,
      hasAppLocals: !!req?.app?.locals,
      localsKeys: req?.app?.locals ? Object.keys(req.app.locals) : "no locals",
      requestId: req?.requestId
    });
    
    if (!roditClient) {
      logger.warnWithContext("RoditClient not available in app.locals, skipping webhook", {
        component: "CRUDA",
        event: payload?.event,
        requestId: req?.requestId,
        hasApp: !!req?.app,
        hasLocals: !!req?.app?.locals,
        localsKeys: req?.app?.locals ? Object.keys(req.app.locals) : "no locals"
      });
      return { success: false, error: "RoditClient not available" };
    }

    // Debug log before calling send_webhook
    logger.debugWithContext("About to call roditClient.send_webhook", {
      component: "CRUDA",
      event: payload?.event,
      requestId: req?.requestId,
      hasSendWebhookMethod: typeof roditClient.send_webhook === 'function',
      roditClientMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(roditClient)).filter(name => typeof roditClient[name] === 'function')
    });

    // Call send_webhook with payload object and request
    const result = await roditClient.send_webhook(payload, req);
    
    // Debug log after successful call
    logger.debugWithContext("roditClient.send_webhook completed", {
      component: "CRUDA",
      event: payload?.event,
      requestId: req?.requestId,
      resultSuccess: result?.success,
      resultKeys: result ? Object.keys(result) : "no result"
    });
    
    return result;
  } catch (error) {
    // Intentional policy (allowed-fallback-standard): webhook delivery is best-effort.
    // CRUDA mutations succeed even when the outbound webhook fails; callers see
    // `{ success: false }` from send_webhook and audit logs retain the failure.
    logger.errorWithContext(
      "Webhook delivery failed, continuing with request processing",
      {
        component: "CRUDA",
        event: payload?.event,
        requestId: req?.requestId,
      },
      error
    );

    // Return a failure result instead of throwing
    return {
      success: false,
      error: error.message,
      errorType: error.name,
    };
  }
};

// Initialize the database when this module is loaded
initializeDatabase()
  .then(() => {
    const requestId = ulid();
    logger.infoWithContext(
      "CRUDA Router database initialized successfully",
      {
        requestId,
        component: "CRUDARouter",
        event: "moduleInitialization",
      }
    );
  })
  .catch((error) => {
    const requestId = ulid();
    logger.logErrorWithMetrics(
      "Failed to initialize database",
      {
        requestId,
        component: "CRUDARouter",
        event: "moduleInitialization",
      },
      error,
      "database_error",
      { operation: "moduleInitialization", result: "error" }
    );
  });

// Middleware to check if item exists
const itemExists = async (req, res, next) => {
  const requestId = req.requestId || ulid();
  const { id } = req.body;

  if (!id) {
    logger.warnWithContext("Item existence check failed - no ID provided", {
      component: "CRUDARouter",
      method: "itemExists",
      requestId,
      bodyKeys: Object.keys(req.body || {}),
    });

    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "INVALID_REQUEST",
      message: "ID is required"
    });
  }

  try {
    const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);

    if (!comment) {
      logger.warnWithContext("Item not found", {
        component: "CRUDARouter",
        method: "itemExists",
        requestId,
        itemId: id,
      });

      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "COMMENT_NOT_FOUND",
        message: "Comment not found"
      });
    }

    req.comment = comment;
    next();
  } catch (error) {
    logger.logErrorWithMetrics(
      "Error checking item existence",
      {
        component: "CRUDARouter",
        event: "itemExists",
        requestId,
        id,
      },
      error,
      "database_error",
      { operation: "itemExists", result: "error" }
    );

    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "CRUDA_OPERATION_FAILED",
      message: "Internal server error"
    });
  }
};

// In-memory store for idempotency keys (use Redis or a database for durable deploys)
const idempotencyStore = new Map();

function isErrorResponseEnvelope(body) {
  return Boolean(body && typeof body === "object" && body.error && body.requestId);
}

function normalizeCachedResponseBody(body, statusCode, requestId) {
  if (isErrorResponseEnvelope(body)) {
    return body;
  }
  if (statusCode >= 400) {
    return {
      error: {
        code: body?.code || body?.error?.code || "CACHED_ERROR",
        message: body?.message || body?.error?.message || body?.error || "Request failed"
      },
      requestId: body?.requestId || requestId,
      timestamp: body?.timestamp || new Date().toISOString()
    };
  }
  return body;
}

// Middleware to handle idempotency
const handleIdempotency = (req, res, next) => {
  const idempotencyKey = req.headers["idempotency-key"];

  if (!idempotencyKey) {
    return next();
  }

  // Check if we've seen this key before
  const cachedResponse = idempotencyStore.get(idempotencyKey);
  if (cachedResponse) {
    // If the request is still being processed, wait for it
    if (cachedResponse.status === "processing") {
      return new Promise((resolve) => {
        const checkStatus = () => {
          const current = idempotencyStore.get(idempotencyKey);
          if (current.status !== "processing") {
            const requestId = req.requestId || ulid();
            res
              .status(current.statusCode)
              .json(normalizeCachedResponseBody(current.body, current.statusCode, requestId));
            resolve();
          } else {
            setTimeout(checkStatus, 100);
          }
        };
        checkStatus();
      });
    }

    const requestId = req.requestId || ulid();
    return res
      .status(cachedResponse.statusCode)
      .json(
        normalizeCachedResponseBody(
          cachedResponse.body,
          cachedResponse.statusCode,
          requestId
        )
      );
  }

  // Mark as processing
  idempotencyStore.set(idempotencyKey, { status: "processing" });

  // Add response handler to cache the response
  const originalJson = res.json;
  res.json = function (body) {
    idempotencyStore.set(idempotencyKey, {
      status: "completed",
      statusCode: res.statusCode,
      body: body,
    });
    originalJson.call(this, body);
  };

  next();
};

// Validation middleware for create/update operations
const validateComment = (req, res, next) => {
  const requestId = req.requestId || ulid();

  try {
    const { comment } = req.body;

    // If this is a GET request or the route doesn't require a comment, skip validation
    if (
      req.method === "GET" ||
      req.path.endsWith("/list") ||
      req.path.endsWith("/read")
    ) {
      return next();
    }

    // Check if comment exists and is a non-empty string
    if (typeof comment !== "string" || comment.trim() === "") {
      const error = new Error(
        "Comment is required and must be a non-empty string"
      );
      error.statusCode = 400;
      error.code = "VALIDATION_ERROR";
      error.requestId = requestId;

      logger.warnWithContext("Comment validation failed", {
        requestId,
        component: "CRUDA",
        event: "validateComment",
        error: error.message,
        path: req.path,
        method: req.method,
      });

      return sendError(res, {
        statusCode: 400,
        requestId,
        code: error.code || "VALIDATION_ERROR",
        message: error.message
      });
    }

    // Sanitize and trim the comment
    req.body.comment = comment.trim();
    next();
  } catch (error) {
    logger.errorWithContext("Error in validateComment middleware", {
      requestId,
      component: "CRUDA",
      event: "validateComment",
    }, error);

    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "CRUDA_OPERATION_FAILED",
      message: "Internal server error"
    });
  }
};

// CREATE - Add a new comment
router.post(
  "/create",
  (req, res, next) => {
    req.logAction = "create_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  validateComment,
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime;
    const routeStartTime = Date.now();

    const { comment, author } = req.body;

    logger.debugWithContext("Processing create comment request", {
      requestId,
      component: "CRUDARouter",
      event: "createComment",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      commentLength: comment ? comment.length : 0,
      hasAuthor: !!author,
    });

    if (!comment) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.warnWithContext("Create comment validation failed", {
        requestId,
        component: "CRUDARouter",
        event: "createComment",
        validationError: "Missing comment field",
        duration,
        routeDuration,
      });

      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "VALIDATION_ERROR",
        message: "Comment is required"
      });
    }

    try {
      const result = await db.run(
        "INSERT INTO comments (comment, author) VALUES (?, ?)",
        [comment, author || null]
      );

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comment created successfully", {
        requestId,
        component: "CRUDARouter",
        event: "createComment",
        status: "success",
        commentId: result.lastID,
        duration,
        routeDuration,
      });

      // Add metric for successful operation
      logger.metric("cruda_operations", duration, {
        operation: "createComment",
        result: "success",
      });

      // Send webhook and pass the request object
      const webhookPayload = { id: result.lastID, comment, author };
      const webhookResult = await logAndSendWebhook(
        {
          event: "comment_created",
          data: webhookPayload,
        },
        req
      );

      const response = {
        id: result.lastID,
        comment,
        author,
        requestId,
      };

      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null,
        };
      }

      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext("Added JWT token to response", {
          requestId,
          component: "CRUDARouter",
          event: "createComment",
          tokenAdded: true,
        });
      }

      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.logErrorWithMetrics(
        "Error creating comment",
        {
          requestId,
          component: "CRUDARouter",
          event: "createComment",
          duration,
          routeDuration,
        },
        error,
        "cruda_error",
        {
          operation: "createComment",
          result: "error",
          duration,
        }
      );

      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// READ - Read all comments (POST version)
router.post(
  "/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();

    logger.debugWithContext("Processing list comments request", {
      requestId,
      component: "CRUDARouter",
      event: "listComments",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
    });

    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comments retrieved successfully", {
        requestId,
        component: "CRUDARouter",
        event: "listComments",
        status: "success",
        count: itemCount,
        duration,
        routeDuration,
      });

      // Add metric for successful operation
      logger.metric("cruda_operations", duration, {
        operation: "listComments",
        result: "success",
        count: itemCount,
      });

      // Send webhook and pass the request object
      const webhookPayload = { count: itemCount };
      const webhookResult = await logAndSendWebhook(
        {
          event: "comments_listed",
          data: webhookPayload,
        },
        req
      );

      const response = {
        comments,
        requestId,
      };

      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null,
        };
      }

      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext("Added JWT token to response", {
          requestId,
          component: "CRUDARouter",
          event: "listComments",
          tokenAdded: true,
        });
      }

      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.logErrorWithMetrics(
        "Error retrieving comments",
        {
          requestId,
          component: "CRUDARouter",
          event: "listComments",
          duration,
          routeDuration,
        },
        error,
        "cruda_error",
        {
          operation: "listComments",
          result: "error",
          duration,
        }
      );

      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// READ - Read all comments (GET version for test compatibility)
router.get(
  "/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();

    logger.debugWithContext(
      "Processing GET list comments request",
      {
        requestId,
        component: "CRUDARouter",
        event: "listCommentsGET",
        endpoint: req.path,
        httpMethod: req.method,
        userId: req.user?.id,
        ip: req.ip,
        action: req.logAction,
      }
    );

    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comments retrieved successfully via GET", {
        requestId,
        component: "CRUDARouter",
        event: "listCommentsGET",
        status: "success",
        count: itemCount,
        duration,
        routeDuration,
      });

      // Add metric for successful operation
      logger.metric("cruda_operations", duration, {
        operation: "listComments",
        result: "success",
        count: itemCount,
        method: "GET",
      });

      const response = {
        comments,
        requestId,
      };

      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.logErrorWithMetrics(
        "Error retrieving comments via GET",
        {
          requestId,
          component: "CRUDARouter",
          event: "listCommentsGET",
          duration,
          routeDuration,
        },
        error,
        "cruda_error",
        {
          operation: "listComments",
          result: "error",
          duration,
          method: "GET",
        }
      );

      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// READ - Read a specific comment by id (POST version)
router.post(
  "/read",
  (req, res, next) => {
    req.logAction = "read_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();

    const { id } = req.body || {};

    logger.debugWithContext("Processing read comment request", {
      requestId,
      component: "CRUDARouter",
      event: "readComment",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id,
    });

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("Read comment validation failed - missing id", {
        requestId,
        component: "CRUDARouter",
        event: "readComment",
        duration,
        routeDuration,
      });
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "ID is required"
      });
    }

    try {
      const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      if (!comment) {
        logger.warnWithContext("Comment not found for read", {
          requestId,
          component: "CRUDARouter",
          event: "readComment",
          duration,
          routeDuration,
        });
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      logger.infoWithContext("Comment retrieved successfully", {
        requestId,
        component: "CRUDARouter",
        event: "readComment",
        status: "success",
        duration,
        routeDuration,
      });

      logger.metric("cruda_operations", duration, {
        operation: "readComment",
        result: "success",
      });

      // Ensure comment field is never null - provide empty string as fallback
      const sanitizedComment = {
        ...comment,
        comment: comment.comment || "",
      };

      return res.json({
        data: { comment: sanitizedComment },
        comment: sanitizedComment, // Also provide at root level for compatibility
        requestId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error reading comment",
        { requestId, component: "CRUDARouter", event: "readComment", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "readComment", result: "error", duration }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// READ - Read by id (GET version for compatibility)
router.get(
  "/read/:id",
  (req, res, next) => {
    req.logAction = "read_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const id = req.params.id;

    logger.debugWithContext("Processing GET read comment request", {
      requestId,
      component: "CRUDARouter",
      event: "readCommentGET",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id,
    });

    try {
      const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      if (!comment) {
        logger.warnWithContext("Comment not found for GET read", {
          requestId,
          component: "CRUDARouter",
          event: "readCommentGET",
          duration,
          routeDuration,
        });
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      logger.infoWithContext("Comment retrieved successfully via GET", {
        requestId,
        component: "CRUDARouter",
        event: "readCommentGET",
        status: "success",
        duration,
        routeDuration,
      });
      logger.metric("cruda_operations", duration, {
        operation: "readComment",
        result: "success",
        method: "GET",
      });

      // Ensure comment field is never null - provide empty string as fallback
      const sanitizedComment = {
        ...comment,
        comment: comment.comment || "",
      };

      return res.json({
        data: { comment: sanitizedComment },
        comment: sanitizedComment, // Also provide at root level for compatibility
        requestId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error reading comment via GET",
        { requestId, component: "CRUDARouter", event: "readCommentGET", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "readComment", result: "error", duration, method: "GET" }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// UPDATE - Update a comment's text
router.post(
  "/update",
  itemExists,
  (req, res, next) => {
    req.logAction = "update_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id, comment } = req.body || {};

    logger.debugWithContext("Processing update comment request", {
      requestId,
      component: "CRUDARouter",
      event: "updateComment",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id,
    });

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [
        id,
      ]);
      if (!existing) {
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      await db.run(
        "UPDATE comments SET comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [comment, id]
      );

      const updated = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comment updated successfully", {
        requestId,
        component: "CRUDARouter",
        event: "updateComment",
        status: "success",
        duration,
        routeDuration,
      });
      logger.metric("cruda_operations", duration, {
        operation: "updateComment",
        result: "success",
      });

      return res.json({ comment: updated, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error updating comment",
        { requestId, component: "CRUDARouter", event: "updateComment", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "updateComment", result: "error", duration }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// DESTROY - Delete a comment by id (POST version)
router.post(
  "/destroy",
  itemExists,
  (req, res, next) => {
    req.logAction = "delete_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id } = req.body || {};

    logger.debugWithContext("Processing delete comment request", {
      requestId,
      component: "CRUDARouter",
      event: "deleteComment",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id,
    });

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("Delete validation failed - missing id", {
        requestId,
        component: "CRUDARouter",
        event: "deleteComment",
        duration,
        routeDuration,
      });
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "ID is required"
      });
    }

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [
        id,
      ]);
      if (!existing) {
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      await db.run("DELETE FROM comments WHERE id = ?", [id]);

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.infoWithContext("Comment deleted successfully", {
        requestId,
        component: "CRUDARouter",
        event: "deleteComment",
        status: "success",
        duration,
        routeDuration,
      });
      logger.metric("cruda_operations", duration, {
        operation: "deleteComment",
        result: "success",
      });

      return res.json({ success: true, id, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error deleting comment",
        { requestId, component: "CRUDARouter", event: "deleteComment", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "deleteComment", result: "error", duration }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// UPDATE - Update a comment's text (PUT version for HTTP method compatibility)
router.put(
  "/update",
  (req, res, next) => {
    req.logAction = "update_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  validateComment,
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id, comment } = req.body || {};

    logger.debugWithContext(
      "Processing PUT update comment request",
      {
        requestId,
        component: "CRUDARouter",
        event: "updateCommentPUT",
        endpoint: req.path,
        httpMethod: req.method,
        userId: req.user?.id,
        ip: req.ip,
        action: req.logAction,
        itemId: id,
      }
    );

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("PUT update validation failed - missing id", {
        requestId,
        component: "CRUDARouter",
        event: "updateCommentPUT",
        duration,
        routeDuration,
      });
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "ID is required"
      });
    }

    if (!comment) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("PUT update validation failed - missing comment", {
        requestId,
        component: "CRUDARouter",
        event: "updateCommentPUT",
        duration,
        routeDuration,
      });
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "VALIDATION_ERROR",
        message: "Comment is required"
      });
    }

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [
        id,
      ]);
      if (!existing) {
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      await db.run(
        "UPDATE comments SET comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [comment, id]
      );

      const updated = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comment updated successfully via PUT", {
        requestId,
        component: "CRUDARouter",
        event: "updateCommentPUT",
        status: "success",
        duration,
        routeDuration,
      });
      logger.metric("cruda_operations", duration, {
        operation: "updateComment",
        result: "success",
        method: "PUT",
      });

      return res.json({ comment: updated, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error updating comment via PUT",
        { requestId, component: "CRUDARouter", event: "updateCommentPUT", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "updateComment", result: "error", duration, method: "PUT" }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// DESTROY - Delete a comment by id (DELETE version for HTTP method compatibility)
router.delete(
  "/destroy",
  (req, res, next) => {
    req.logAction = "delete_item";
    req.requestId = req.headers["x-request-id"] || ulid();
    req.startTime = Date.now();
    next();
  },
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id } = req.body || {};

    logger.debugWithContext("Processing DELETE comment request", {
      requestId,
      component: "CRUDARouter",
      event: "deleteCommentDELETE",
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id,
    });

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("DELETE validation failed - missing id", {
        requestId,
        component: "CRUDARouter",
        event: "deleteCommentDELETE",
        duration,
        routeDuration,
      });
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "ID is required"
      });
    }

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [
        id,
      ]);
      if (!existing) {
        return sendError(res, {
          statusCode: 404,
          requestId,
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found"
        });
      }

      await db.run("DELETE FROM comments WHERE id = ?", [id]);

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.infoWithContext("Comment deleted successfully via DELETE", {
        requestId,
        component: "CRUDARouter",
        event: "deleteCommentDELETE",
        status: "success",
        duration,
        routeDuration,
      });
      logger.metric("cruda_operations", duration, {
        operation: "deleteComment",
        result: "success",
        method: "DELETE",
      });

      return res.json({ success: true, id, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.logErrorWithMetrics(
        "Error deleting comment via DELETE",
        { requestId, component: "CRUDARouter", event: "deleteCommentDELETE", duration, routeDuration },
        error,
        "cruda_error",
        { operation: "deleteComment", result: "error", duration, method: "DELETE" }
      );
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "CRUDA_OPERATION_FAILED",
        message: "Internal server error"
      });
    }
  }
);

// GET route for CRUDA endpoint info and health check
router.get("/", (req, res) => {
  const requestId = req.headers["x-request-id"] || ulid();

  logger.infoWithContext("CRUDA endpoint info requested", {
    component: "CRUDARoutes",
    method: "getInfo",
    requestId,
    ip: req.ip,
  });

  res.json({
    message: "CRUDA API - Create, Read, Update, Delete operations",
    endpoints: {
      "POST /create": "Create a new comment",
      "POST /list": "List all comments",
      "GET /list": "List all comments (GET version)",
      "POST /read": "Read a specific comment",
      "GET /read/:id": "Read a specific comment (GET version)",
      "POST /update": "Update a comment",
      "PUT /update": "Update a comment (PUT version)",
      "POST /destroy": "Delete a comment",
      "DELETE /destroy": "Delete a comment (DELETE version)",
    },
    requestId,
  });
});

// Error handling middleware for CRUDA routes
router.use((err, req, res, next) => {
  const requestId = req.requestId || ulid();
  const statusCode = err.statusCode || 500;

  // Log the error
  logger.errorWithContext("CRUDA route error", {
    requestId,
    error: {
      name: err.name,
      message: err.message,
      stack: includeDebugDetails() ? err.stack : undefined,
    },
    path: req.path,
    method: req.method,
  });

  return sendError(res, {
    statusCode,
    requestId,
    code: err.code || (statusCode >= 500 ? "CRUDA_OPERATION_FAILED" : "INVALID_REQUEST"),
    message: statusCode === 500 ? "Internal Server Error" : err.message,
    details:
      includeDebugDetails() && err.stack
        ? { stack: err.stack }
        : undefined
  });
});
// 404 handler for undefined routes (must be LAST)
router.use((req, res) => {
  const requestId = req.requestId || ulid();
  return sendError(res, {
    statusCode: 404,
    requestId,
    code: "ENDPOINT_NOT_FOUND",
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Export the database utilities
router.getDatabase = getDatabase;
router.closeDatabase = closeDatabase;

module.exports = router;
