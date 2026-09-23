/**
 * Catches the packaging bug that a normal test run cannot see: a new module that every
 * local test imports happily from the repo, but which `files` in package.json omits — so
 * the published package crashes on require. Also checks the bin target and engines.
 */
import { readFileSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let fail = 0
const ok = (n, c, d = '') => { if (c) console.log(`ok    ${n}`); else { fail++; console.log(`FAIL  ${n}  ${d}`) } }

const shipped = (rel) => pkg.files.some((f) => (f.endsWith('/') ? rel.startsWith(f) : f === rel))

// every local import, transitively from the bin entry and the hooks, must be shipped
const seen = new Set()
const walk = (rel) => {
  if (seen.has(rel)) return
  seen.add(rel)
  const abs = join(root, rel)
  if (!existsSync(abs)) { ok(`import target exists: ${rel}`, false); return }
  for (const m of readFileSync(abs, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = join(dirname(rel), m[1]).replace(/^\/+/, '')
    ok(`${rel} imports ${target}, which package.json ships`, shipped(target), `add "${target}" to files[]`)
    walk(target)
  }
}
walk(pkg.bin.jev.replace('./', ''))
walk('hooks/watch.mjs')
walk('hooks/remember.mjs')

ok('bin target is listed in files[]', shipped(pkg.bin.jev.replace('./', '')))
ok('bin target exists and is executable-ish', existsSync(join(root, pkg.bin.jev)))
ok('engines pins node >=20 (fetch + AbortSignal.timeout)', /(>=|\^)2[0-9]/.test(pkg.engines?.node ?? ''))
ok('no runtime dependencies', Object.keys(pkg.dependencies ?? {}).length === 0)
ok('LICENSE and README ship', shipped('LICENSE') && shipped('README.md'))

// the skill the agents load must ship too
ok('skill ships', pkg.files.some((f) => f.startsWith('skills')))
ok('skill has frontmatter with a name and description', (() => {
  const s = readFileSync(join(root, 'skills/jev/SKILL.md'), 'utf8')
  return /^---\n[\s\S]*?\bname:\s*\S/.test(s) && /\bdescription:\s*\S/.test(s)
})())

console.log(fail ? `\n${fail} PACKAGING FAILURES` : '\npackaging OK')
process.exit(fail ? 1 : 0)
