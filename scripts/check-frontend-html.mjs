#!/usr/bin/env node
/**
 * check-frontend-html.mjs — 前端 HTML/JS 静态检查（防“npm test 通过但页面已坏”）
 *
 * 1. 提取 public/*.html 内联 <script>，逐个 node --check 语法校验；
 * 2. 对 public/js/*.js（拆解后的独立前端脚本）逐个 node --check 语法校验；
 * 3. 扫描静态 HTML（非 script 区域）残留的 ${...} 模板占位符——
 *    它们在浏览器里不会被插值，会原样显示成 `${icon('x', 18)}` 文本。
 *
 * 用法：node scripts/check-frontend-html.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const FILES = ['public/ios.html', 'public/macos.html']
const JS_DIR = join(ROOT, 'public/js')

const failures = []

function extractInlineScripts(html) {
  const blocks = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue
    const code = m[2] || ''
    if (code.trim()) blocks.push(code)
  }
  return blocks
}

function checkJsSyntax(code, label) {
  const dir = mkdtempSync(join(tmpdir(), 'frontend-html-'))
  const file = join(dir, 'inline.js')
  try {
    writeFileSync(file, code, 'utf8')
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30_000 })
    if (r.status === 0) return null
    const err = String(r.stderr || r.stdout || '').trim()
    return `${label} 脚本语法错误:\n${err.split('\n').slice(0, 8).join('\n')}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function checkJsFileSyntax(abs, label) {
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 30_000 })
  if (r.status === 0) return null
  const err = String(r.stderr || r.stdout || '').trim()
  return `${label} 脚本语法错误:\n${err.split('\n').slice(0, 8).join('\n')}`
}

// 1. HTML 内联脚本
for (const rel of FILES) {
  const abs = join(ROOT, rel)
  const html = readFileSync(abs, 'utf8')

  for (const [i, code] of extractInlineScripts(html).entries()) {
    const err = checkJsSyntax(code, `${rel}#${i + 1}`)
    if (err) failures.push(err)
  }

  const staticHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const lines = staticHtml.split('\n')
  lines.forEach((line, idx) => {
    const m = line.match(/\$\{[^}]*\}/)
    if (m) failures.push(`${rel} 第 ${idx + 1} 行静态 HTML 残留模板占位符（浏览器会原样显示）: ${m[0].slice(0, 100)}`)
  })
}

// 2. 拆解后的独立前端 JS 文件
for (const name of readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort()) {
  const err = checkJsFileSyntax(join(JS_DIR, name), `public/js/${name}`)
  if (err) failures.push(err)
}

if (failures.length > 0) {
  console.error('❌ 前端 HTML 检查未通过:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ 前端检查通过：${FILES.join(', ')} 内联脚本 OK，静态 HTML 无 ${'${'} 占位符残留，${readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).length} 个外部 JS 语法 OK`)
