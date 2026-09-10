import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function assertFile(relativePath) {
  assert(fs.existsSync(path.join(repoRoot, relativePath)), `Missing referenced file: ${relativePath}`);
}

const manifest = JSON.parse(readText("manifest.json"));
assert(manifest.manifest_version === 3, "manifest.json must use Manifest V3.");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must use x.y.z format.");

for (const contentScript of manifest.content_scripts ?? []) {
  for (const file of contentScript.js ?? []) assertFile(file);
  for (const file of contentScript.css ?? []) assertFile(file);
}
for (const file of manifest.background?.scripts ?? []) assertFile(file);
for (const entry of manifest.web_accessible_resources ?? []) {
  for (const file of entry.resources ?? []) assertFile(file);
}
for (const file of Object.values(manifest.icons ?? {})) assertFile(file);
for (const file of Object.values(manifest.action?.default_icon ?? {})) assertFile(file);

const css = readText("assets/overlay.css");
assert(!/(?:linear|radial|conic)-gradient\s*\(/i.test(css), "UI stylesheet contains a gradient.");

const runtimeFiles = ["background.js", "contentScript.js", "manifest.json"];
const runtimeSource = runtimeFiles.map((file) => readText(file)).join("\n");
const forbiddenReportingPatterns = [
  /\bsentry\b/i,
  /\btelemetry\b/i,
  /\banalytics\b/i,
  /\bsendBeacon\s*\(/i,
  /\bposthog\b/i,
  /\bmixpanel\b/i,
  /\bamplitude\b/i,
  /\bdatadog\b/i,
  /\bnewrelic\b/i,
  /\brollbar\b/i,
  /\bsegment\.com\b/i,
];
for (const pattern of forbiddenReportingPatterns) {
  assert(!pattern.test(runtimeSource), `Forbidden reporting/telemetry pattern found: ${pattern}`);
}

const urlMatches = runtimeSource.match(/https?:\/\/[^\s"'`<>]+/g) ?? [];
for (const rawUrl of urlMatches) {
  const normalized = rawUrl.replace(/[),;]+$/, "");
  if (normalized.includes("*.")) continue;
  if (normalized.startsWith("http://www.w3.org/2000/svg")) continue;
  let hostname;
  try {
    hostname = new URL(normalized.replace(/\$\{[^}]+\}/g, "placeholder")).hostname;
  } catch {
    continue;
  }
  const allowed = hostname === "facebook.com" || hostname.endsWith(".facebook.com") || hostname === "fbcdn.net" || hostname.endsWith(".fbcdn.net");
  assert(allowed, `Unexpected external runtime host: ${hostname}`);
}

const forbiddenFeatureTerms = [
  /price\s*drop/i,
  /drop\s*price/i,
  /sentry/i,
];
for (const pattern of forbiddenFeatureTerms) {
  assert(!pattern.test(readText("contentScript.js")), `Removed feature/reporting term still appears in contentScript.js: ${pattern}`);
}

if (failures.length > 0) {
  console.error("Static validation failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Static validation passed for RE:new v${manifest.version}.`);
console.log(`Checked ${runtimeFiles.length} runtime source files and ${urlMatches.length} URL references.`);
