"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const ignored = new Set([".git", "node_modules", "test-results", "coverage"]);
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!/\.(?:js|json|md|css|yml|yaml)$/.test(entry.name)) continue;
    else inspect(full);
  }
}

function reject(file, rule, expression, content) {
  if (expression.test(content)) failures.push(`${path.relative(root, file)}: ${rule}`);
}

function inspect(file) {
  if (file === __filename) return;
  const content = fs.readFileSync(file, "utf8");
  reject(file, "personal absolute path", /\/Users\/[^/]+\/|iCloud~md~obsidian|Desktop\/甜菜/iu, content);
  reject(file, "credential or private key material", /(?:pairing|companion)[_-]?credential\s*[=:]\s*["'][A-Za-z0-9+/_=-]{20,}["']|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu, content);
  reject(file, "secret-bearing environment variable", /(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*[=:]\s*["'][^"']+/u, content);
  if (file.endsWith(".js")) {
    reject(file, "telemetry or analytics dependency", /(?:require\s*\(|from\s+)["'](?:@?sentry|posthog|segment|mixpanel|amplitude)/iu, content);
    const withoutLoopback = content.replaceAll("http://127.0.0.1:41729", "");
    reject(file, "remote URL or network endpoint", /https?:\/\//iu, withoutLoopback);
  }
}

walk(root);
if (failures.length) {
  console.error(JSON.stringify({ status: "failed", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: "ok", scan: "privacy-policy", root }));
