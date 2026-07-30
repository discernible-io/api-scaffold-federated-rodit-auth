const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { ulid } = require("ulid");
const { sendError } = errorResponse;

const USER_RATE_LIMITER_LOCALS_KEY = "__userRateLimiterMiddleware";

function createUserRateLimitMiddleware(roditClient) {
  const getRateLimitFactory = roditClient?.getRateLimitMiddleware?.();

  if (typeof getRateLimitFactory !== "function") {
    throw new Error("Rate limit middleware factory not available from SDK");
  }

  const userLimiters = new Map();

  return async function userRateLimitMiddleware(req, res, next) {
    const userId = req.user?.id || req.user?.sub;

    if (!userId) {
      return next();
    }

    try {
      if (!userLimiters.has(userId)) {
        const configObject = await roditClient.getConfigOwnRodit();
        const metadata = configObject?.own_rodit?.metadata;

        if (!metadata?.max_requests || !metadata?.maxrq_window) {
          return next();
        }

        const maxRequests = parseInt(metadata.max_requests, 10);
        const windowSeconds = parseInt(metadata.maxrq_window, 10);
        const windowMinutes = Math.max(Math.floor(windowSeconds / 60), 1);

        const userLimiter = getRateLimitFactory(maxRequests, windowMinutes);
        userLimiters.set(userId, { limiter: userLimiter });
      }

      return userLimiters.get(userId).limiter(req, res, next);
    } catch (error) {
      const requestId = req.requestId || ulid();
      logger.errorWithContext(
        "Error applying user-based rate limiting",
        { component: "UserRateLimit", requestId },
        error
      );

      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "SERVICE_UNAVAILABLE",
        message: "Rate limiting configuration error"
      });
    }
  };
}

module.exports = {
  getUserRateLimiter(req) {
    const appLocals = req.app?.locals;
    if (!appLocals?.roditClient) {
      return null;
    }

    if (!appLocals[USER_RATE_LIMITER_LOCALS_KEY]) {
      try {
        appLocals[USER_RATE_LIMITER_LOCALS_KEY] = createUserRateLimitMiddleware(
          appLocals.roditClient
        );
      } catch {
        appLocals[USER_RATE_LIMITER_LOCALS_KEY] = null;
      }
    }

    return appLocals[USER_RATE_LIMITER_LOCALS_KEY];
  }
};
