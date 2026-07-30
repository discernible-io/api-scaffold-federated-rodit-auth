// Importing express module
const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { RoditClient, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();
// Logger methods are available directly on the logger object

// Handling request using router
router.get("/home", (req, res, next) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  
  logger.debugWithContext("Processing homepage request", {
    requestId,
    component: 'HomeRoutes',
    event: 'getHomepage',
    endpoint: '/api/home',
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  
  try {
    // Send the homepage response
    res.send("This is the homepage request");
    
    const duration = Date.now() - startTime;
    logger.infoWithContext("Homepage request processed successfully", {
      requestId,
      component: 'HomeRoutes',
      event: 'getHomepage',
      statusCode: 200,
      duration
    });
    
    // Add metric for successful operation
    logger.metric('route_operations', duration, {
      operation: 'getHomepage',
      result: 'success'
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.logErrorWithMetrics(
      'Error processing homepage request',
      {
        requestId,
        component: 'HomeRoutes',
        event: 'getHomepage',
        duration
      },
      error,
      'route_error',
      {
        operation: 'getHomepage',
        result: 'error',
        duration
      }
    );
    
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "HOME_REQUEST_FAILED",
      message: "Failed to process homepage request"
    });
  }
});

// Respond to HEAD requests for health/benchmark probes
router.head("/home", (req, res) => {
  // Minimal fast response for probes
  res.status(200).end();
});

// Importing the router
module.exports = router;