#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MINIMUM_AGE_DAYS = 3;
const MINIMUM_AGE_EXCEPTIONS = new Set(["@rodit/rodit-auth-be"]);
const PACKAGE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

function npmView(spec, field) {
  try {
    const output = execFileSync("npm", ["view", spec, field, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    return output ? JSON.parse(output) : null;
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`npm view failed: ${stderr}`);
  }
}

function resolveVersion(name, range) {
  const value = npmView(`${name}@${range}`, "version");

  if (Array.isArray(value)) {
    return value[value.length - 1];
  }

  return value;
}

function getPublishTime(name, version) {
  const value = npmView(`${name}@${version}`, "time");

  if (!value || !value[version]) {
    throw new Error(`publish time not found for ${name}@${version}`);
  }

  return new Date(value[version]);
}

function collectDependencies(packageJson) {
  return PACKAGE_SECTIONS.flatMap((section) => {
    const dependencies = packageJson[section] || {};

    return Object.entries(dependencies).map(([name, range]) => ({
      name,
      range,
      section,
    }));
  });
}

function main() {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = collectDependencies(packageJson);
  const now = Date.now();
  const minimumAgeMs = MINIMUM_AGE_DAYS * 24 * 60 * 60 * 1000;
  const tooNew = [];

  for (const dependency of dependencies) {
    if (MINIMUM_AGE_EXCEPTIONS.has(dependency.name)) {
      continue;
    }

    try {
      const version = resolveVersion(dependency.name, dependency.range);
      const publishedAt = getPublishTime(dependency.name, version);
      const ageMs = now - publishedAt.getTime();

      if (ageMs < minimumAgeMs) {
        tooNew.push({
          ...dependency,
          version,
          publishedAt,
          ageHours: ageMs / (60 * 60 * 1000),
        });
      }
    } catch (error) {
      console.error(
        `[minimum-package-age] Failed to evaluate ${dependency.name}@${dependency.range}: ${error.message}`,
      );
      process.exit(1);
    }
  }

  if (tooNew.length > 0) {
    console.error(
      `[minimum-package-age] Install blocked. Dependencies must be at least ${MINIMUM_AGE_DAYS} days old.`,
    );

    for (const dependency of tooNew) {
      console.error(
        `  - ${dependency.name}@${dependency.version} (${dependency.section}) published ${dependency.publishedAt.toISOString()} (${dependency.ageHours.toFixed(1)}h old)`,
      );
    }

    process.exit(1);
  }

  console.log(
    `[minimum-package-age] OK. All dependencies are at least ${MINIMUM_AGE_DAYS} days old.`,
  );
}

main();
