/**
 * Request Validation Middleware
 * Validates Content-Type and input format BEFORE authentication
 */

const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { ulid } = require("ulid");
const { sendError } = errorResponse;

function validateContentType(req, res, next) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) {
    return next();
  }

  const contentType = req.get("Content-Type");
  if (!contentType || !contentType.includes("application/json")) {
    const requestId = req.requestId || ulid();
    logger.debugWithContext("Invalid Content-Type", {
      component: "RequestValidation",
      method: req.method,
      path: req.path,
      contentType: contentType || "missing",
      ip: req.ip,
      requestId
    });

    return sendError(res, {
      statusCode: 415,
      requestId,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Content-Type must be application/json"
    });
  }

  next();
}

function validateJsonBody(req, res, next) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) {
    return next();
  }

  if (req.body === undefined) {
    const requestId = req.requestId || ulid();
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "INVALID_REQUEST",
      message: "Request body is required"
    });
  }

  next();
}

module.exports = {
  validateContentType,
  validateJsonBody
};
