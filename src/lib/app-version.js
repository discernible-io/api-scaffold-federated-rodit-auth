/**
 * API release version — read only from api-docs/swagger.json info.version.
 */
const path = require("path");
const fs = require("fs");

const SWAGGER_PATH = path.join(__dirname, "../../api-docs/swagger.json");

function loadOpenApiSpec() {
  return JSON.parse(fs.readFileSync(SWAGGER_PATH, "utf8"));
}

function readApiVersion() {
  const version = loadOpenApiSpec().info?.version;
  if (!version || typeof version !== "string") {
    throw new Error("api-docs/swagger.json must define info.version");
  }
  return version;
}

const version = readApiVersion();

module.exports = {
  version,
  loadOpenApiSpec,
  readApiVersion
};
