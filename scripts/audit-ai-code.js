#!/usr/bin/env node
import { builtinModules } from 'node:module'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const SECRET_NAME = /(?:api[_-]?key|secret|password|private[_-]?key|access[_-]?token)/i
const SECRET_VALUE = /^(?:sk|pk|ghp|xox[baprs]|AKIA)[-_A-Za-z0-9]{10,}$/

function finding(file, node, sourceFile, rule, message, severity = 'error') {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { file, line: point.line + 1, column: point.character + 1, rule, severity, message }
}

function textContains(node, sourceFile, pattern) { return pattern.test(node.getText(sourceFile)) }

export function auditSource(source, file = 'inline.ts') {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const findings = []
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && SECRET_NAME.test(node.name.text) && node.initializer && ts.isStringLiteralLike(node.initializer) && (node.initializer.text.length >= 16 || SECRET_VALUE.test(node.initializer.text))) {
      findings.push(finding(file, node, ast, 'hardcoded-secret', 'Secret-like value is hardcoded'))
    }
    if (ts.isCatchClause(node) && node.block.statements.length === 0) findings.push(finding(file, node, ast, 'swallowed-rejection', 'Empty catch block swallows a rejection or exception'))
    if (ts.isJsxAttribute(node) && node.name.text === 'dangerouslySetInnerHTML' && node.initializer && !/sanitize|DOMPurify/.test(node.initializer.getText(ast))) {
      findings.push(finding(file, node, ast, 'unsanitized-html', 'dangerouslySetInnerHTML must use an approved sanitizer'))
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast)
      const args = node.arguments
      if (callee === 'eval' || callee === 'Function') findings.push(finding(file, node, ast, 'dynamic-code', 'Dynamic code execution is forbidden'))
      if (callee === 'fetch' && args.length > 2) findings.push(finding(file, node, ast, 'unverified-api-signature', 'fetch accepts at most two arguments'))
      if (/\.(?:getItem|setItem)$/.test(callee) && ((callee.endsWith('.getItem') && args.length !== 1) || (callee.endsWith('.setItem') && args.length !== 2))) findings.push(finding(file, node, ast, 'unverified-api-signature', 'Storage API argument count is invalid'))
      if (/^(?:fetch|exec|execFile|spawn)$/.test(callee) && args.some((arg) => textContains(arg, ast, /\breq\.(?:body|query|params)\b/)) && !args.some((arg) => textContains(arg, ast, /sanitize|validate|parse|encodeURIComponent/))) {
        findings.push(finding(file, node, ast, 'unsanitized-input', 'Request input reaches a sensitive sink without visible validation'))
      }
      if (/\.(?:invoke|submitTransaction|sendTransaction)$/.test(callee)) {
        let scope = node.parent
        while (scope && !ts.isFunctionLike(scope)) scope = scope.parent
        if (!scope || !textContains(scope, ast, /auth|authoriz|verify|sign/i)) findings.push(finding(file, node, ast, 'unauthenticated-contract-call', 'Contract submission lacks an authorization check in its function scope'))
      }
      // ISP-094: Taint-aware detection for network sinks and base64 sinks
      if (/^(?:WebSocket|XMLHttpRequest|dgram\.createSocket|dns\.lookup|dns\.resolve)$/.test(callee)) {
        findings.push(finding(file, node, ast, 'sensitive-network-sink', `Sensitive network sink ${callee} detected in AI-touched file; requires manual review`))
      }
    }
    // ISP-094: Detect split-string and obfuscated fetch calls (e.g. "fe" + "tch")
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const leftText = node.left.getText(ast).replace(/['"]/g, '')
      const rightText = node.right.getText(ast).replace(/['"]/g, '')
      if ((leftText + rightText).toLowerCase() === 'fetch' || (leftText + rightText).toLowerCase() === 'child_process') {
        findings.push(finding(file, node, ast, 'obfuscated-sink', `Obfuscated network sink "${leftText}" + "${rightText}" detected; flagged for review`))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return findings
}

function packageName(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] }

async function collect(paths) {
  const files = []
  async function walk(path) {
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const name of await readdir(path)) if (!['node_modules', 'dist', 'coverage', '.git'].includes(name)) await walk(resolve(path, name))
    } else if (SOURCE_EXTENSIONS.has(extname(path)) && !/\.(?:test|spec)\.[^.]+$/.test(path)) files.push(path)
  }
  for (const path of paths) await walk(resolve(path))
  return files
}

export async function auditFiles(paths, root = process.cwd()) {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const allowed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
  const findings = []
  for (const file of await collect(paths)) {
    const source = await readFile(file, 'utf8')
    findings.push(...auditSource(source, file))
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith('.') && !allowed.has(packageName(specifier))) findings.push(finding(file, statement, ast, 'unverified-import', `Package "${packageName(specifier)}" is not declared`))
    }
  }
  return findings
}

export async function main(args = process.argv.slice(2)) {
  const targets = args.length ? args : ['src', 'server']
  const findings = await auditFiles(targets)
  for (const item of findings) console.error(`${item.file}:${item.line}:${item.column} [${item.rule}] ${item.message}`)
  console.log(`AI-code security audit: ${findings.length} finding(s) across ${targets.join(', ')}`)
  if (findings.some((item) => item.severity === 'error')) process.exitCode = 1
  return findings
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main()
