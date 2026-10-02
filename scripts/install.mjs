#!/usr/bin/env node
/**
 * Build the installable tarball and stage it inside the DSH profile.
 *
 * Why a staged copy rather than a `file:` path straight from this workspace:
 * pnpm dependency specs break on whitespace, and this project lives under
 * `/Users/wangjian/dsh-pj/normal staff/…`. The profile's own `vendor/`
 * directory is also exactly where `dsh-our-free-model` keeps its tarball, so
 * this follows the pattern already proven in this profile.
 *
 * Usage:  node scripts/install.mjs [--profile desktop]
 * Then:   install it with the plugin-manager tool as
 *             file:vendor/dsh-mac-keep-awake-<version>.tgz
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const tarballName = `${pkg.name}-${pkg.version}.tgz`

const profileFlag = process.argv.indexOf('--profile')
const profile = profileFlag === -1 ? 'desktop' : process.argv[profileFlag + 1]
if (!profile) throw new Error('--profile needs a value')

const profileDir = join(homedir(), '.dsh', 'profiles', profile)
const vendorDir = join(projectRoot, 'vendor')
const tarball = join(vendorDir, tarballName)

// ── 1. Pack ──────────────────────────────────────────────────────────────────
//
// COPYFILE_DISABLE=1 is load-bearing on macOS: without it tar also archives the
// `._*` AppleDouble sidecars for files carrying extended attributes, and those
// junk entries land in the installed package.
mkdirSync(vendorDir, { recursive: true })
rmSync(tarball, { force: true })
execFileSync(
  'tar',
  [
    '--exclude=./vendor',
    '--exclude=./.DS_Store',
    '--exclude=./._*',
    '-czf',
    tarball,
    '-C',
    projectRoot,
    './package.json',
    './index.js',
    './src',
    './cordis.patch.yml',
  ],
  { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } },
)
console.log(`packed  ${tarball} (${statSync(tarball).size} bytes)`)

// ── 2. Stage inside the profile so the spec has no spaces ────────────────────
const stagedDir = join(profileDir, 'vendor')
mkdirSync(stagedDir, { recursive: true })
const staged = join(stagedDir, tarballName)
copyFileSync(tarball, staged)
console.log(`staged  ${staged}`)

// ── 3. Warn about the stale-spec trap ────────────────────────────────────────
//
// The profile's package.json pins the exact tarball filename it installed. If
// that file is deleted — because a new version was packed and the old tarball
// cleaned up — pnpm fails with ENOENT on the NEXT operation, even one that has
// nothing to do with this plugin. Keeping every previously-installed tarball
// around is what makes an upgrade safe.
const profilePkgPath = join(profileDir, 'package.json')
let pinned = null
try {
  pinned = JSON.parse(readFileSync(profilePkgPath, 'utf8')).dependencies?.[pkg.name] ?? null
} catch {
  /* profile not readable — the note below is advisory only */
}

const pinnedFile = typeof pinned === 'string' && pinned.startsWith('file:')
  ? pinned.slice('file:'.length)
  : null
if (pinnedFile && pinnedFile !== `vendor/${tarballName}`) {
  // Resolve against the profile root — the spec is `file:vendor/<name>.tgz`.
  const stillThere = existsSync(join(profileDir, pinnedFile))
  console.log(
    stillThere
      ? `note    the profile still pins ${pinnedFile} (kept, so pnpm can resolve it)`
      : `WARNING the profile still pins ${pinnedFile}, which is MISSING.\n` +
        `        Re-create it before any further pnpm operation, or that operation\n` +
        `        will fail with ENOENT even though it is unrelated to this plugin.`,
  )
}

console.log(`
Next: install it through the DSH plugin manager with the spec

    file:vendor/${tarballName}

(or run the plugin-manager tool with action=install_bundle and that target).
After it lands, the profile patch layer already mounts it — the bundle's own
cordis.patch.yml carries the insert row.
`)
