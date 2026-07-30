const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { getUserRateLimiter } = require("../middleware/userratelimitmw");
const { validateContentType, validateJsonBody } = require("../middleware/requestvalidationmw");
const { sendError } = errorResponse;

const authenticate_apicall = (req, res, next) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    const requestId = req.requestId || ulid();
    return sendError(res, {
      statusCode: 503,
      requestId,
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service unavailable"
    });
  }
  return client.authenticate(req, res, (authErr) => {
    if (authErr) {
      return next(authErr);
    }

    const userRateLimiter = getUserRateLimiter(req);
    if (!userRateLimiter) {
      return next();
    }

    return userRateLimiter(req, res, next);
  });
};

const authorize = (req, res, next) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    const requestId = req.requestId || ulid();
    return sendError(res, {
      statusCode: 503,
      requestId,
      code: "AUTHORIZATION_SERVICE_UNAVAILABLE",
      message: "Authorization service unavailable"
    });
  }
  return client.authorize(req, res, next);
};

const getSessionManager = (req) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    throw new Error("RoditClient not available");
  }
  return client.getSessionManager();
};

router.get("/list_all", authenticate_apicall, authorize, async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();

  try {
    const sessions = [];
    const sessionManager = getSessionManager(req);

    let allSessions = [];
    if (sessionManager.storage && typeof sessionManager.storage.getAll === "function") {
      allSessions = await sessionManager.storage.getAll();
    } else if (sessionManager.storage && typeof sessionManager.storage.keys === "function") {
      const sessionIds = await sessionManager.storage.keys();
      for (const id of sessionIds) {
        const session = await sessionManager.storage.get(id);
        if (session) allSessions.push(session);
      }
    } else {
      throw new Error("Session storage interface not available");
    }

    for (const session of allSessions) {
      if (session.status === "active") {
        sessions.push({
          id: session.id,
          roditId: session.roditId,
          ownerId: session.ownerId,
          createdAt: new Date(session.createdAt * 1000).toISOString(),
          expiresAt: new Date(session.expiresAt * 1000).toISOString(),
          lastAccessedAt: new Date(session.lastAccessedAt * 1000).toISOString(),
          status: session.status
        });
      }
    }

    const duration = Date.now() - startTime;
    logger.metric("session_list", duration, {
      operation: "listSessions",
      result: "success",
      sessionCount: sessions.length
    });

    res.json({
      sessions,
      count: sessions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendError(res, {
      statusCode: 500,
      requestId,
      code: "SESSIONS_RETRIEVE_FAILED",
      message: "Failed to retrieve sessions"
    });
  }
});

router.post("/cleanup", validateContentType, authenticate_apicall, authorize, async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();

  try {
    const sessionManager = getSessionManager(req);
    const activeBefore = await sessionManager.getActiveSessionCount();
    const cleanupResult = await sessionManager.cleanupExpiredSessions();
    const activeAfter = await sessionManager.getActiveSessionCount();
    const removedCount = activeBefore - activeAfter;
    const duration = Date.now() - startTime;

    logger.metric("session_cleanup", duration, {
      operation: "cleanupExpiredSessions",
      result: "success",
      removedCount
    });

    res.status(200).json({
      success: true,
      message: "Session cleanup completed",
      stats: {
        removedCount,
        activeSessions: activeAfter,
        totalSessions: activeAfter,
        cleanupResult
      },
      requestId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendError(res, {
      statusCode: 500,
      requestId,
      code: "SESSION_CLEANUP_FAILED",
      message: "Session cleanup failed"
    });
  }
});

router.post("/revoke", validateContentType, validateJsonBody, authenticate_apicall, authorize, async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  const { sessionId } = req.body;
  const reason = req.body.reason || "admin_termination";

  if (!sessionId) {
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "SESSION_ID_REQUIRED",
      message: "Missing required parameter: sessionId"
    });
  }

  try {
    const sessionManager = getSessionManager(req);
    const sessionClosed = await sessionManager.closeSession(sessionId, reason);

    if (sessionClosed) {
      res.json({
        message: "Session terminated successfully",
        sessionId,
        reason,
        timestamp: new Date().toISOString()
      });
    } else {
      sendError(res, {
        statusCode: 404,
        requestId,
        code: "SESSION_NOT_FOUND",
        message: "Session not found or already terminated",
        details: { sessionId }
      });
    }
  } catch (error) {
    sendError(res, {
      statusCode: 500,
      requestId,
      code: "SESSION_TERMINATION_FAILED",
      message: "Failed to terminate session"
    });
  }
});

module.exports = router;
