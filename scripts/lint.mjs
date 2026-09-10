import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];

const sourceFiles = [
  "background.js",
  "contentScript.js",
  "scripts/lint.mjs",
  "scripts/validate.mjs",
];

const textFiles = [
  ...sourceFiles,
  "assets/overlay.css",
  "manifest.json",
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
  ".gitattributes",
  ".github/workflows/ci.yml",
  ".githooks/pre-commit",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

for (const relativePath of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", path.join(repoRoot, relativePath)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${relativePath}: JavaScript syntax check failed\n${result.stderr.trim()}`);
  }
}

for (const relativePath of textFiles) {
  const text = read(relativePath);
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) fail(`${relativePath}:${index + 1}: trailing whitespace`);
  });
  if (!text.endsWith("\n")) fail(`${relativePath}: file must end with a newline`);
}

for (const relativePath of ["background.js", "contentScript.js"]) {
  const source = read(relativePath);

  if (/\bdebugger\s*;/.test(source)) fail(`${relativePath}: debugger statement found`);
  if (/\beval\s*\(/.test(source)) fail(`${relativePath}: eval() is not allowed`);
  if (/\bnew\s+Function\s*\(/.test(source)) fail(`${relativePath}: new Function() is not allowed`);

  const functionMatches = source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g);
  for (const match of functionMatches) {
    const name = match[1];
    if (name.length < 3) fail(`${relativePath}: named function '${name}' is too short to be descriptive`);
  }

  const todoCount = (source.match(/\b(?:TODO|FIXME)\b/g) ?? []).length;
  if (todoCount > 0) warnings.push(`${relativePath}: ${todoCount} TODO/FIXME marker(s)`);
}

try {
  JSON.parse(read("manifest.json"));
} catch (error) {
  fail(`manifest.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

try {
  JSON.parse(read("package.json"));
} catch (error) {
  fail(`package.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

try {
  JSON.parse(read("tsconfig.json"));
} catch (error) {
  fail(`tsconfig.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (failures.length > 0) {
  console.error("Lint failed:\n" + failures.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}

console.log(`Lint passed (${sourceFiles.length} JavaScript files, ${textFiles.length} text files).`);
