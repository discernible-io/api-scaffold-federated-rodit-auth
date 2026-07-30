// In the protected/signclient.js file
const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
// Use npm package export
const { RoditClient, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();
// login_portal method is now available on the RoditClient instance
const roditManager = sdkClient.getRoditManager();
// Logger methods are available directly on the logger object

async function signPortalRodit(
  port,
  tamperproofedValues,
  mintingfee,
  mintingfeeaccount,
  roditClient
) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debugWithContext("Sending signportal request", {
    requestId,
    component: "SignPortal",
    event: "signPortalRodit",
    serviceProviderId: tamperproofedValues.serviceprovider_id,
    port
  });

  // Get API endpoint using the roditClient's getPortalUrl method
  const apiendpoint = roditClient.getPortalUrl(
    tamperproofedValues.serviceprovider_id,
    port
  );

  const signportalJwtToken = roditClient.getSignPortalJwtToken();
  const requestBody = {
    tamperproofedValues,
    mintingfee,
    mintingfeeaccount,
  };

  const fetchUrl = `${apiendpoint}/api/portal/signportal`;
  
  const headers = {
    "Content-Type": "application/json",
    "X-Request-ID": requestId,
  };

  if (signportalJwtToken) {
    headers["Authorization"] = `Bearer ${signportalJwtToken}`;
  }

  // Enhanced logging with structured context
  logger.infoWithContext("Preparing SignPortal API call", {
    requestId,
    component: "SignPortal",
    event: "signPortalRodit",
    url: fetchUrl,
    headers: Object.keys(headers),
    bodySize: JSON.stringify(requestBody).length,
    hasToken: !!signportalJwtToken
  });
  
  // Separate sensitive data into debug level logs
  logger.debugWithContext("Request body details", {
    requestId,
    component: "SignPortal",
    event: "signPortalRodit",
    bodyKeys: Object.keys(requestBody)
  });

  try {
    const result = await roditClient.fetchWithErrorHandlingSignPortal(fetchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;
    logger.infoWithContext("Raw response received from SignPortal", {
      requestId,
      component: "SignPortal",
      event: "signPortalRodit",
      responseReceived: true,
      duration
    });

    if (result.error) {
      const duration = Date.now() - startTime;
      
      logger.logErrorWithMetrics(
        "SignPortal error response",
        {
          requestId,
          component: "SignPortal",
          event: "signPortalRodit",
          errorCode: result.error,
          errorMessage: result.message,
          duration
        },
        new Error(result.message || result.error),
        "signportal_error",
        {
          operation: "signPortalRodit",
          result: "error",
          duration
        }
      );
      
      throw new Error(`SignPortal error: ${result.error}: ${result.message}`);
    }

    const successDuration = Date.now() - startTime;
    logger.infoWithContext("SignPortal operation successful", {
      requestId,
      component: "SignPortal",
      event: "signPortalRodit",
      tokenId: result.token_id,
      duration: successDuration
    });
    
    // Add metric for successful operation
    logger.metric("signportal_operations", successDuration, {
      operation: "signPortalRodit",
      result: "success"
    });
    
    return result;
  } catch (error) {
    const errorDuration = Date.now() - startTime;
    
    logger.logErrorWithMetrics(
      "Error during signportal operation",
      {
        requestId,
        component: "SignPortal",
        event: "signPortalRodit",
        errorMessage: error.message,
        duration: errorDuration
      },
      error,
      "signportal_error",
      {
        operation: "signPortalRodit",
        result: "error",
        duration: errorDuration
      }
    );
    
    throw error;
  }
}

// Ensure body parsing for this route specifically
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

// The signclient endpoint that the frontend will call
router.post("/signclient", async (req, res) => {
  const requestId = ulid();
  const startTime = Date.now();
  
  logger.infoWithContext("Received signclient request", {
    requestId,
    component: "SignClient",
    event: "handleSignClientRequest",
    endpoint: "/signclient",
    httpMethod: req.method,
    ip: req.ip,
    userAgent: req.get("User-Agent")
  });

  // Debug request body and headers
  logger.debugWithContext("Request debugging info", {
    requestId,
    component: "SignClient",
    event: "handleSignClientRequest",
    hasBody: !!req.body,
    bodyType: typeof req.body,
    contentType: req.get('Content-Type'),
    contentLength: req.get('Content-Length'),
  });

  try {
    // Check if req.body exists before destructuring
    if (!req.body) {
      logger.errorWithContext("Request body is undefined", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        contentType: req.get('Content-Type'),
        contentLength: req.get('Content-Length'),
        method: req.method,
      });
      
      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "Request body is missing or malformed",
        details: {
          hint: "Expected JSON body with tobesignedValues, mintingfee, and mintingfeeaccount",
          contentType: req.get("Content-Type")
        }
      });
    }

    // Get data from frontend
    const { tobesignedValues, mintingfee, mintingfeeaccount } = req.body;

    // Basic validation
    if (!tobesignedValues || !mintingfee || !mintingfeeaccount) {
      logger.warnWithContext("Missing required fields in signclient request", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        hasSignedValues: !!tobesignedValues,
        hasMintingFee: !!mintingfee,
        hasMintingFeeAccount: !!mintingfeeaccount,
      });

      return sendError(res, {
        statusCode: 400,
        requestId,
        code: "INVALID_REQUEST",
        message: "Missing required fields"
      });
    }

    // Initialize vault and config if not already done
    if (!roditManager.vaultInitialized) {
      logger.infoWithContext("Initializing vault for signclient", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
      });
      await roditManager.initializeCredentialsStore();
      await roditManager.initializeRoditConfig("server");
    }

    // Get configuration from rodit client
    const roditClient = req.app.locals.roditClient;
    if (!roditClient) {
      throw new Error('RoditClient not available in app.locals');
    }
    const config_own_rodit = await roditClient.getConfigOwnRodit();
    if (!config_own_rodit) {
      logger.errorWithContext("Failed to get RODiT configuration", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
      });
      throw new Error("Failed to initialize RODiT configuration");
    }

    const portalPort = 8443;
    
    // JWT Token management
    // roditClient already defined above
    if (!roditClient.getSignPortalJwtToken()) {
      logger.infoWithContext("Authenticating with SignPortal", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        portalPort,
        hasExistingToken: false
      });

      // Use the login_portal method on the roditClient instance
      const loginResult = await roditClient.login_portal(config_own_rodit, portalPort);

      if (!loginResult.jwt_token) {
        // Enhanced error logging with clear cause and effect
        const errorDetails = loginResult.error || "Unknown error";
        const errorReason = loginResult.reason || "Connection to SignPortal failed";
        
        logger.errorWithContext("Failed to obtain JWT token: Authentication with SignPortal failed", {
          requestId,
          component: "SignClient",
          event: "handleSignClientRequest",
          portalPort,
          errorDetails,
          errorReason,
          impact: "Cannot proceed with client authentication flow"
        });
        
        throw new Error(`Failed to obtain JWT token from SignPortal: ${errorReason}`);
      }

      await roditClient.setSignPortalJwtToken(loginResult.jwt_token);
      logger.infoWithContext("Successfully authenticated with SignPortal", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        portalPort
      });
    }

    // Validate that all requested permissions exist in the server's configuration
    try {
      // Parse the requested permissions and the configuration permissions
      const requestedPermissions = JSON.parse(tobesignedValues.permissioned_routes);
      const configPermissions = JSON.parse(config_own_rodit.own_rodit.metadata.permissioned_routes);
      
      // Extract methods from both objects
      const requestedMethods = requestedPermissions?.entities?.methods || {};
      const configMethods = configPermissions?.entities?.methods || {};
      
      // Check for any requested routes that don't exist in the config
      const invalidRoutes = [];
      for (const route of Object.keys(requestedMethods)) {
        if (!configMethods.hasOwnProperty(route)) {
          invalidRoutes.push(route);
          logger.warnWithContext("Invalid route permission requested", {
            requestId,
            component: "SignClient",
            event: "handleSignClientRequest",
            route,
            permission: requestedMethods[route],
            reason: "not_in_config"
          });
        } else {
          logger.debugWithContext("Valid route permission requested", {
            requestId,
            component: "SignClient",
            event: "handleSignClientRequest",
            route,
            permission: requestedMethods[route],
            reason: "present_in_config"
          });
        }
      }
      
      // If there are any invalid routes, reject the request
      if (invalidRoutes.length > 0) {
        const errorMessage = `Invalid permission(s) requested: ${invalidRoutes.join(', ')}`;
        logger.errorWithContext("Permission validation failed - rejecting signing request", {
          requestId,
          component: "SignClient",
          event: "handleSignClientRequest",
          invalidRoutes,
          requestedRouteCount: Object.keys(requestedMethods).length,
          configRouteCount: Object.keys(configMethods).length,
          error: errorMessage
        });
        
        return sendError(res, {
          statusCode: 400,
          requestId: req.requestId || requestId,
          code: "SIGNCLIENT_INVALID_PERMISSIONS",
          message: "Invalid permissions requested",
          details: {
            invalidRoutes,
            availableRoutes: Object.keys(configMethods)
          }
        });
      }
      
      logger.infoWithContext("All requested permissions are valid - proceeding with signing", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        validatedRouteCount: Object.keys(requestedMethods).length
      });
      
    } catch (error) {
      logger.errorWithContext("Failed to validate permissions - rejecting signing request", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        error: error.message,
        permissioned_routes: tobesignedValues.permissioned_routes
      });
      
      return sendError(res, {
        statusCode: 400,
        requestId: req.requestId || requestId,
        code: "SIGNCLIENT_INVALID_PERMISSION_FORMAT",
        message: "Invalid permission format",
        details: { parseError: error.message }
      });
    }

    const tamperproofedValues = {
      openapijson_url: config_own_rodit.own_rodit.metadata.openapijson_url,
      not_after: tobesignedValues.not_after,
      not_before: config_own_rodit.own_rodit.metadata.not_before,
      max_requests: String(tobesignedValues.max_requests),    // Explicit conversion to string
      maxrq_window: String(tobesignedValues.maxrq_window),
      webhook_cidr: config_own_rodit.own_rodit.metadata.webhook_cidr,
      allowed_cidr: config_own_rodit.own_rodit.metadata.allowed_cidr,
      allowed_iso3166list: config_own_rodit.own_rodit.metadata.allowed_iso3166list,
      jwt_duration: config_own_rodit.own_rodit.metadata.jwt_duration,
      permissioned_routes: tobesignedValues.permissioned_routes,
      subjectuniqueidentifier_url: config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url,
      serviceprovider_id: config_own_rodit.own_rodit.metadata.serviceprovider_id,
      serviceprovider_signature: tobesignedValues.serviceprovider_signature,
    };

    // Log critical information at debug level with proper context
    logger.debugWithContext("Prepared tamperproofed values for signing", {
      requestId,
      component: "SignClient",
      event: "handleSignClientRequest",
      serviceprovider_id: tamperproofedValues.serviceprovider_id,
      not_after: tamperproofedValues.not_after,
      not_before: tamperproofedValues.not_before,
      mintingfee,
      mintingfeeaccount
    });
    
    // Sign token using SignPortal
    logger.infoWithContext("Sending request to SignPortal", {
      requestId,
      component: "SignClient",
      event: "handleSignClientRequest",
      operation: "signPortalRodit"
    });
    
    const signResult = await signPortalRodit(
      portalPort,
      tamperproofedValues,
      mintingfee,
      mintingfeeaccount,
      roditClient
    );

    if (!signResult) {
      logger.errorWithContext("Sign operation failed with null result", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
      });
      throw new Error("Sign operation failed");
    }

    // Success response
    const duration = Date.now() - startTime;
    
    logger.infoWithContext("Successfully created new RODiT token", {
      requestId,
      component: "SignClient",
      event: "handleSignClientRequest",
      token_id: signResult.token_id,
      status: "success",
      duration,
      has_fee_signature: !!signResult.fee_signature_base64url
    });
    
    // Log fee signature information
    if (signResult.fee_signature_base64url) {
      logger.debugWithContext("Fee signature received from SignPortal", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        token_id: signResult.token_id,
        fee_signature_length: signResult.fee_signature_base64url.length
      });
    } else {
      logger.warnWithContext("No fee signature received from SignPortal", {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        token_id: signResult.token_id
      });
    }
    
    // Add metric for successful operation
    logger.metric("signclient_operations", duration, {
      operation: "handleSignClientRequest",
      result: "success"
    });

    res.status(201).json(signResult);
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Extract the root cause from the error chain
    const rootCause = error.cause ? error.cause.message : error.message;
    const errorType = error.name || error.constructor.name;
    
    // Enhanced error logging with clear cause and effect
    logger.logErrorWithMetrics(
      `Error in signclient endpoint: ${errorType}`,
      {
        requestId,
        component: "SignClient",
        event: "handleSignClientRequest",
        errorMessage: error.message,
        errorName: errorType,
        rootCause,
        duration
      },
      error,
      "signclient_error",
      {
        operation: "handleSignClientRequest",
        result: "error",
        duration
      }
    );

    // Return a structured error response
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "SIGNCLIENT_FAILED",
      message: "Failed to sign client request",
      details: { reason: errorType, detail: error.message }
    });
  }
});

module.exports = router;