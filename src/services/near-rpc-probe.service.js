/**
 * Lightweight NEAR RPC probe for readiness/health checks.
 */

async function probeNearRpcStatus(rpcUrl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("probeNearRpcStatus: timeoutMs must be a positive number");
  }
  const start = Date.now();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "health-probe",
        method: "status",
        params: []
      }),
      signal: controller.signal
    });
    clearTimeout(id);
    const latencyMs = Date.now() - start;
    if (response.status === 429) {
      return { ok: false, latencyMs, error: "rate_limited" };
    }
    if (!response.ok) {
      return { ok: false, latencyMs, error: `http_${response.status}` };
    }
    await response.json();
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err.name === "AbortError") {
      return { ok: false, latencyMs, error: "timeout" };
    }
    return { ok: false, latencyMs, error: err.message };
  }
}

module.exports = { probeNearRpcStatus };
