const os = require("os");
const { probeNearRpcStatus } = require("./near-rpc-probe.service");

async function buildHealthPayload(app, config) {
  const serviceName = config.get("SERVICE_NAME");
  const rpcUrl = config.has("NEAR_RPC_URL") ? config.get("NEAR_RPC_URL") : null;
  const probeTimeoutMs = Number(config.get("NEAR_RPC_TIMEOUT"));
  const rpcResult = rpcUrl
    ? await probeNearRpcStatus(rpcUrl, probeTimeoutMs)
    : { ok: false, latencyMs: 0, error: "NEAR_RPC_URL_not_configured" };

  const roditClient = app.locals?.roditClient;
  const authOk = !!(roditClient && typeof roditClient.authenticate === "function");

  const checks = {
    nearRpc: rpcUrl
      ? {
          status: rpcResult.ok ? "pass" : "fail",
          latencyMs: rpcResult.latencyMs,
          ...(rpcResult.error && { error: rpcResult.error })
        }
      : { status: "skipped", reason: "NEAR_RPC_URL_not_set" },
    roditAuth: {
      status: authOk ? "pass" : "fail",
      detail: authOk ? "client_ready" : "client_missing_or_incomplete"
    }
  };

  const nearReady = checks.nearRpc.status === "pass";
  const degraded = !nearReady || !authOk;

  return {
    status: degraded ? "degraded" : "healthy",
    degraded,
    checks,
    service: serviceName,
    timestamp: new Date().toISOString(),
    instance: {
      hostname: os.hostname(),
      pid: process.pid
    }
  };
}

function createHealthHandler({ app, config, logger, cacheMs }) {
  let healthChecksCache = { at: 0, payload: null };

  return async function healthHandler(req, res) {
    const now = Date.now();
    if (healthChecksCache.payload && now - healthChecksCache.at < cacheMs) {
      res.status(200).json(healthChecksCache.payload);
      return;
    }
    try {
      const payload = await buildHealthPayload(app, config);
      healthChecksCache = { at: now, payload };
      res.status(200).json(payload);
    } catch (err) {
      logger.errorWithContext(
        "Health check dependency probe failed",
        { component: "AppLifecycle", operation: "health.probe" },
        err
      );
      res.status(200).json({
        status: "degraded",
        degraded: true,
        checks: { probe: { status: "fail", error: err.message } },
        service: config.get("SERVICE_NAME"),
        timestamp: new Date().toISOString(),
        instance: { hostname: os.hostname(), pid: process.pid }
      });
    }
  };
}

module.exports = { buildHealthPayload, createHealthHandler };
