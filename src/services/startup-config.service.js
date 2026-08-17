const fs = require("fs");
const path = require("path");

const CONFIG_REDACT_SKIP_EXACT = new Set(["RODIT_NEAR_CREDENTIALS_SOURCE"]);
const CONFIG_SECRET_PRESENT = "PRESENT-REDACTED";
const CONFIG_SECRET_ABSENT = "ABSENT";
const CONFIG_SNAPSHOT_SUPPLEMENT_KEYS = ["LOKI_URL", "LOKI_BASIC_AUTH"];

const NGINX_PUBLIC_RATE_LIMIT_CONF_PATHS = [
  path.join(__dirname, "../../nginx/nginx.conf")
];

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function shouldRedactConfigKey(pathStr) {
  const upper = pathStr.toUpperCase();
  if (CONFIG_REDACT_SKIP_EXACT.has(upper)) return false;
  const lower = pathStr.toLowerCase();
  if (lower.includes("session_token_retention")) return false;
  if (lower.includes("session_validation_cache")) return false;

  const needles = [
    "password",
    "secret",
    "token",
    "private",
    "basic_auth",
    "credential",
    "api_key",
    "privkey",
    "authorization"
  ];
  return needles.some((n) => lower.includes(n));
}

function isConfigSecretValuePresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function formatSnapshotValue(pathStr, value) {
  if (!shouldRedactConfigKey(pathStr)) return value;
  return isConfigSecretValuePresent(value) ? CONFIG_SECRET_PRESENT : CONFIG_SECRET_ABSENT;
}

function safeConfigResolve(config, pathStr, fallback) {
  try {
    if (typeof config.getResolved === "function") {
      return config.getResolved(pathStr, fallback);
    }
    return {
      value: config.get(pathStr, fallback),
      source: "unknown",
      reason: "config source metadata unavailable"
    };
  } catch {
    return {
      value: fallback,
      source: "default",
      reason: "default, resolution failure"
    };
  }
}

function fillStartupSnapshotFromMerged(config, merged, snapshot) {
  function walk(obj, pathPrefix) {
    if (!isPlainObject(obj)) {
      const resolved = safeConfigResolve(config, pathPrefix, obj);
      snapshot[pathPrefix] = {
        value: formatSnapshotValue(pathPrefix, resolved.value),
        source: resolved.source || "unknown",
        reason: resolved.reason || "resolution reason unavailable"
      };
      return;
    }
    const keys = Object.keys(obj);
    const problematicChild = keys.some((k) => /[/[\]]/.test(k) || k.includes("."));
    if (problematicChild && pathPrefix) {
      const resolved = safeConfigResolve(config, pathPrefix, obj);
      snapshot[pathPrefix] = {
        value: formatSnapshotValue(pathPrefix, resolved.value),
        source: resolved.source || "unknown",
        reason: resolved.reason || "resolution reason unavailable"
      };
      return;
    }
    if (keys.length === 0) {
      snapshot[pathPrefix] = {
        value: formatSnapshotValue(pathPrefix, {}),
        source: "default.json",
        reason: "default.json value provided"
      };
      return;
    }
    for (const k of keys) {
      const nextPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      walk(obj[k], nextPath);
    }
  }
  walk(merged, "");
}

function supplementStartupSnapshot(config, snapshot) {
  for (const pathStr of CONFIG_SNAPSHOT_SUPPLEMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, pathStr)) continue;
    try {
      const resolved = safeConfigResolve(config, pathStr);
      snapshot[pathStr] = {
        value: formatSnapshotValue(pathStr, resolved.value),
        source: resolved.source || "unknown",
        reason: resolved.reason || "resolution reason unavailable"
      };
    } catch {
      /* unset */
    }
  }
}

function buildStartupConfigSnapshot(config) {
  const merged = typeof config.getAllMerged === "function" ? config.getAllMerged() : {};
  const snapshot = {};
  fillStartupSnapshotFromMerged(config, merged, snapshot);
  supplementStartupSnapshot(config, snapshot);
  return Object.keys(snapshot)
    .sort()
    .reduce((acc, k) => {
      acc[k] = snapshot[k];
      return acc;
    }, {});
}

function logResolvedConfigSnapshot(logger, config) {
  try {
    const startupConfig = buildStartupConfigSnapshot(config);
    logger.infoWithContext("Resolved configuration at startup", {
      component: "AppLifecycle",
      config: startupConfig,
      configKeyCount: Object.keys(startupConfig).length
    });
  } catch (snapErr) {
    logger.warnWithContext(
      "Could not build startup configuration snapshot",
      { component: "AppLifecycle" },
      snapErr
    );
  }
}

function parseNginxPublicRateLimitFromConf(confText) {
  const zoneRateMatch = confText.match(
    /limit_req_zone\s+\$public_rate_limit_key\s+zone=public_api_limit:\S+\s+rate=([^;]+);/
  );
  const burstMatch = confText.match(/limit_req\s+zone=public_api_limit\s+burst=(\d+)/);
  return {
    zoneRate: zoneRateMatch ? zoneRateMatch[1].trim() : null,
    burst: burstMatch ? Number(burstMatch[1]) : null
  };
}

function logNginxPublicRateLimitSettings(logger) {
  for (const confPath of NGINX_PUBLIC_RATE_LIMIT_CONF_PATHS) {
    try {
      const confText = fs.readFileSync(confPath, "utf8");
      const { zoneRate, burst } = parseNginxPublicRateLimitFromConf(confText);
      logger.infoWithContext("nginx public route rate limit (edge)", {
        component: "AppLifecycle",
        configFile: confPath,
        zoneRate,
        burst,
        enforcement:
          "limit_req on location / for URIs in public_rate_limit_key map; protected routes excluded"
      });
    } catch (readErr) {
      logger.warnWithContext(
        "Could not read nginx public rate limit settings",
        { component: "AppLifecycle", configFile: confPath },
        readErr
      );
    }
  }
}

function redactRpcHostLabel(rpcUrl) {
  if (!rpcUrl || typeof rpcUrl !== "string") return null;
  try {
    return new URL(rpcUrl).hostname;
  } catch {
    return "unparseable";
  }
}

module.exports = {
  logResolvedConfigSnapshot,
  logNginxPublicRateLimitSettings,
  redactRpcHostLabel
};
