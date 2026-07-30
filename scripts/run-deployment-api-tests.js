#!/usr/bin/env node
/**
 * Deployment-time API test suite (findings-only).
 * Compares live responses to api-docs/swagger.json (@target-swagger.json).
 * Does not fail the process — log findings for operators.
 *
 * Usage (in API container):
 *   API_BASE_URL=http://127.0.0.1:8080 node scripts/run-deployment-api-tests.js
 */

const fs = require("fs");
const path = require("path");

const API_BASE_URL = (process.env.API_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const TARGET_SWAGGER =
  process.env.TARGET_SWAGGER ||
  path.join(__dirname, "../api-docs/swagger.json");

const findings = [];

function finding(test, specExpectation, observed) {
  findings.push({ test, specExpectation, observed });
  console.log(
    JSON.stringify({
      level: "finding",
      test,
      specExpectation,
      observed
    })
  );
}

function pass(test, detail) {
  console.log(JSON.stringify({ level: "pass", test, detail }));
}

async function fetchJson(urlPath, options = {}) {
  const res = await fetch(`${API_BASE_URL}${urlPath}`, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

function loadSwaggerPaths() {
  const raw = fs.readFileSync(TARGET_SWAGGER, "utf8");
  const spec = JSON.parse(raw);
  return Object.keys(spec.paths || {});
}

async function run() {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Starting deployment API tests",
      API_BASE_URL,
      TARGET_SWAGGER
    })
  );

  let swaggerPaths;
  try {
    swaggerPaths = loadSwaggerPaths();
    pass("swagger.load", `${swaggerPaths.length} paths in spec`);
  } catch (err) {
    finding("swagger.load", "Readable OpenAPI paths", err.message);
    return;
  }

  const { status: healthStatus, body: healthBody } = await fetchJson("/health");
  if (healthStatus !== 200) {
    finding("/health", "HTTP 200", `HTTP ${healthStatus}`);
  } else if (!healthBody || typeof healthBody.status !== "string") {
    finding("/health", "JSON with status field", healthBody);
  } else if (!["healthy", "degraded"].includes(healthBody.status)) {
    finding("/health", 'status in ["healthy","degraded"]', healthBody.status);
  } else {
    pass("/health", `status=${healthBody.status}`);
  }

  const { status: tsStatus, body: tsBody } = await fetchJson("/api/login/timestamp");
  if (tsStatus !== 200) {
    finding("/api/login/timestamp", "HTTP 200", `HTTP ${tsStatus}`);
  } else if (!tsBody?.timestamp || !tsBody?.timestamp_iso) {
    finding(
      "/api/login/timestamp",
      "Body includes timestamp and timestamp_iso",
      tsBody
    );
  } else {
    pass("/api/login/timestamp", "challenge pair present");
  }

  const { status: rootStatus, body: rootBody } = await fetchJson("/");
  if (rootStatus !== 200) {
    finding("/", "HTTP 200 welcome", `HTTP ${rootStatus}`);
  } else if (!Array.isArray(rootBody?.endpoints) && !Array.isArray(rootBody?.endpointsList)) {
    finding("/", "endpoints or endpointsList array in JSON", rootBody);
  } else {
    const list = rootBody.endpointsList || rootBody.endpoints;
    pass("/", `${list.length} endpoints listed`);
  }

  const requiredPublic = ["/health", "/api/login/timestamp"];
  for (const p of requiredPublic) {
    if (!swaggerPaths.includes(p)) {
      finding("swagger.paths", `Path ${p} documented`, "missing from swagger");
    }
  }

  if (findings.length === 0) {
    console.log(JSON.stringify({ level: "summary", result: "no_findings" }));
  } else {
    console.log(
      JSON.stringify({ level: "summary", result: "findings", count: findings.length })
    );
  }
}

run().catch((err) => {
  console.log(
    JSON.stringify({
      level: "finding",
      test: "runner.fatal",
      specExpectation: "Suite completes",
      observed: err.message
    })
  );
});
