#!/usr/bin/env node
import { parse } from "@babel/parser";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const critical = file => /\/src\/(db\/|core\/(runtime|agent|fabric)\/|platform\/|adapters\/)/.test(file);
const unwrap = node => node && ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression"].includes(node.type) ? unwrap(node.expression) : node;
const member = (node, object, property) => node?.type === "MemberExpression" &&
  node.object.type === "Identifier" && node.object.name === object &&
  (node.computed ? node.property.value : node.property.name) === property;
const empty = node => node?.type === "BlockStatement" && node.body.length === 0;

/** Production findings are unconditional failures; there is no debt allowance. */
export function scanTigerStyle(source, file = "packages/zelavis/src/db/example.ts") {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const findings = [];
  const effectNames = new Set();
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration" && node.source.value === "effect") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.imported.name === "Effect") effectNames.add(specifier.local.name);
      }
    }
  }
  const effectMember = (node, names) => [...effectNames].some(name => names.some(method => member(node, name, method)));
  const add = (node, rule, owner) => findings.push({ file, line: node.loc.start.line, rule, owner });
  function visit(node, owner = "module") {
    if (!node?.type) return;
    const binding = node.type === "VariableDeclarator" ? node.id?.name :
      ["ObjectMethod", "ClassMethod", "ObjectProperty"].includes(node.type) ? node.key?.name :
      node.type === "FunctionDeclaration" ? node.id?.name : undefined;
    const current = binding ? `${owner}/${binding}` : owner;
    if (node.type === "CatchClause" && empty(node.body)) add(node, "silent-catch", current);
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee?.type === "MemberExpression" && (callee.computed ? callee.property.value : callee.property.name) === "catch") {
        const handler = node.arguments[0];
        if (["ArrowFunctionExpression", "FunctionExpression"].includes(handler?.type) && empty(handler.body)) add(node, "silent-catch", current);
      }
      if (effectMember(callee, ["ignore", "ignoreCause"])) add(node, "effect-ignore", current);
      if (effectMember(callee, ["all", "forEach"])) {
        for (const argument of node.arguments) {
          if (argument.type !== "ObjectExpression") continue;
          for (const property of argument.properties) {
            if (property.type === "ObjectProperty" && (property.key.name ?? property.key.value) === "concurrency" &&
              property.value.type === "StringLiteral" && property.value.value === "unbounded") add(node, "unbounded-concurrency", current);
          }
        }
      }
    }
    if (critical(file) && ["TSAsExpression", "TSTypeAssertion"].includes(node.type)) {
      const value = unwrap(node.expression);
      if (node.typeAnnotation.type !== "TSUnknownKeyword" && value?.type === "CallExpression" && member(value.callee, "JSON", "parse")) {
        add(node, "unchecked-json-cast", current);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) { for (const child of value) visit(child, current); }
      else if (value?.type) visit(value, current);
    }
  }
  visit(ast.program);
  return findings;
}

export async function inventory(directory = join(root, "packages/zelavis")) {
  const findings = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", ".git", ".react-router", "test", "tests"].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        findings.push(...scanTigerStyle(await readFile(full, "utf8"), relative(root, full)));
      }
    }
  }
  await walk(directory);
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

async function main() {
  if (process.argv.length > 2) throw new Error("Usage: check-tigerstyle.mjs");
  const problems = await inventory();
  if (problems.length) {
    for (const problem of problems) console.error(`${problem.file}:${problem.line} ${problem.rule} (${problem.owner})`);
    console.error("TigerStyle check failed. Preserve typed failures, bound concurrency, and validate decoded data. See .agents/references/tigerstyle-typescript.md. No baseline or suppression allowances exist.");
    process.exitCode = 1;
    return;
  }
  console.log("TigerStyle check passed; zero production violations. Semantic invariants still require tests and review.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
