#!/usr/bin/env node
/**
 * lwdb installer / updater / doctor.
 *
 * One entry point for both humans and AI agents:
 *
 *   node install.mjs install     — first-time setup
 *   node install.mjs update      — pull latest, reinstall deps, refresh skill
 *   node install.mjs doctor      — diagnose the installation
 *   node install.mjs status      — what's installed where
 *   node install.mjs update-skill— refresh only the agent skill snapshot
 *   node install.mjs uninstall   — remove links (preserves ~/.lwdb data)
 *
 * Architecture:
 *
 *   repo/.claude/skills/lwdb/SKILL.md  ──(copy at install/update)──▶  ~/.lwdb/skill/SKILL.md
 *                                                                              ▲
 *                                                                              │ (symlink)
 *                                                                              │
 *   ~/.claude/skills/lwdb                                  ──────────────────┘
 *
 * The snapshot is a *copy* (not a symlink to the repo) so the installed state
 * doesn't change under agents while they're running. The AI-tool skill folder
 * is a symlink to the snapshot so a single update refreshes every tool.
 *
 * Zero runtime deps — Node stdlib only, so this script runs before
 * `npm install` if needed.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants

const REPO_ROOT  = path.dirname(fileURLToPath(import.meta.url));
const HOME       = os.homedir();
const LWDB_DIR   = path.join(HOME, '.lwdb');
const SKILL_DIR  = path.join(LWDB_DIR, 'skill');
const CANONICAL_SKILL = path.join(SKILL_DIR, 'SKILL.md');
const LAUNCHER_MANIFEST = path.join(LWDB_DIR, 'launcher.json');

const REPO_SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'lwdb');
const REPO_SKILL = path.join(REPO_SKILL_DIR, 'SKILL.md');
const REPO_PKG = path.join(REPO_ROOT, 'package.json');

const SKILL_NAME = 'lwdb';

const AI_TOOLS = [
  { id: 'claude-code', name: 'Claude Code', parent: '.claude', skillsRel: '.claude/skills' },
  { id: 'copilot',     name: 'GitHub Copilot', parent: '.copilot', skillsRel: '.copilot/skills' },
  { id: 'codex',       name: 'Codex CLI', parent: '.codex', skillsRel: '.codex/skills' },
];

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
};

const isTTY = process.stdout.isTTY;
const c = (color, s) => (isTTY ? `${C[color]}${s}${C.reset}` : s);

// ---------------------------------------------------------------------------
// Entry point

function main() {
  const arg = process.argv[2] ?? 'install';
  switch (arg) {
    case 'install':       return install();
    case 'update':        return update();
    case 'update-skill':  return updateSkillOnly();
    case 'doctor':        return doctor();
    case 'status':        return status();
    case 'uninstall':     return uninstall();
    case '--help':
    case '-h':
    case 'help':          return printHelp();
    default:
      console.error(`Unknown command: ${arg}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp() {
  console.log(`lwdb installer

Usage:
  node install.mjs install        First-time setup
  node install.mjs update         git pull + reinstall deps + refresh skill
  node install.mjs doctor         Run diagnostics
  node install.mjs status         Show what's installed
  node install.mjs update-skill   Refresh agent skill snapshot only
  node install.mjs uninstall      Remove CLI link + skill symlinks (preserves ~/.lwdb)

After install:
  lwdb --help                     CLI is on PATH
  lwdb doctor                     Same diagnostics as 'node install.mjs doctor'

AI agents:
  The Claude Code skill is symlinked into ~/.claude/skills/lwdb automatically.
  Open a new Claude Code session to pick it up.
`);
}

// ---------------------------------------------------------------------------
// Top-level flows

function install() {
  banner('install');
  const checks = preflight();
  if (!checks.ok) process.exit(1);

  npmInstall();
  npmLink();
  ensureDir(SKILL_DIR);
  snapshotSkill();
  linkSkillsForAllAITools();
  writeLauncherManifest();

  console.log('');
  console.log(c('green', '✓ install complete'));
  console.log('');
  doctor({ exitOnFail: false });
  console.log('');
  console.log(`${c('bold', 'Next:')} add a connection — ${c('cyan', 'lwdb conn-add --label="Local" --host=localhost --user=root')}`);
  console.log(`  or import many at once — ${c('cyan', 'lwdb import connections.example.json')}  (see connections.example.json)`);
  console.log(`  desktop app (optional): ${c('cyan', 'npm run tauri:build')} then install the .deb`);
}

function update() {
  banner('update');
  if (!isGitRepo()) {
    console.error(c('red', `✗ ${REPO_ROOT} is not a git checkout — can't update.`));
    console.error(`  Did you clone the repo? Try: ${c('cyan', 'git clone <repo-url> && cd lwdb && node install.mjs install')}`);
    process.exit(1);
  }
  gitPull();
  npmInstall();
  npmLink();
  snapshotSkill();
  linkSkillsForAllAITools();
  writeLauncherManifest();
  console.log('');
  console.log(c('green', '✓ update complete'));
  console.log('');
  doctor({ exitOnFail: false });
}

function updateSkillOnly() {
  banner('update-skill');
  ensureDir(SKILL_DIR);
  snapshotSkill();
  linkSkillsForAllAITools();
  console.log(c('green', '✓ skill refreshed'));
  console.log(c('dim', '  Open a new agent session to pick up the new content.'));
}

function status() {
  banner('status');
  console.log(`repo:      ${REPO_ROOT}`);
  console.log(`snapshot:  ${CANONICAL_SKILL} ${exists(CANONICAL_SKILL) ? c('green', '✓') : c('red', 'missing')}`);
  console.log(`launcher:  ${LAUNCHER_MANIFEST} ${exists(LAUNCHER_MANIFEST) ? c('green', '✓') : c('yellow', 'missing')}`);
  for (const tool of AI_TOOLS) {
    const link = path.join(HOME, tool.skillsRel, SKILL_NAME);
    const installed = isToolPresent(tool);
    if (!installed) {
      console.log(`${tool.name.padEnd(20)} ${c('dim', '(not installed)')}`);
      continue;
    }
    if (!exists(link)) {
      console.log(`${tool.name.padEnd(20)} ${c('yellow', 'skill not linked')}`);
      continue;
    }
    const target = readlinkSafe(link);
    console.log(`${tool.name.padEnd(20)} ${c('green', '✓')} ${c('dim', `→ ${target || link}`)}`);
  }
  const lwdbBin = which('lwdb');
  console.log(`lwdb on PATH: ${lwdbBin ? c('green', '✓') + ' ' + c('dim', lwdbBin) : c('red', 'no')}`);
}

function uninstall() {
  banner('uninstall');
  // Unlink the npm global package
  tryRun('npm unlink -g lwdb', { allowFailure: true, silent: true });
  // Remove each AI tool's skill symlink
  for (const tool of AI_TOOLS) {
    const link = path.join(HOME, tool.skillsRel, SKILL_NAME);
    if (exists(link)) {
      try { fs.rmSync(link, { recursive: true, force: true }); console.log(c('green', `✓ removed ${link}`)); }
      catch (e) { console.error(c('red', `✗ ${link}: ${e.message}`)); }
    }
  }
  if (exists(LAUNCHER_MANIFEST)) {
    try { fs.rmSync(LAUNCHER_MANIFEST, { force: true }); console.log(c('green', `✓ removed ${LAUNCHER_MANIFEST}`)); }
    catch (e) { console.error(c('red', `✗ ${LAUNCHER_MANIFEST}: ${e.message}`)); }
  }
  // Leave ~/.lwdb in place — the user may want their backups
  console.log('');
  console.log(c('dim', `Preserved: ${LWDB_DIR}  (delete manually if you also want this gone)`));
}

// ---------------------------------------------------------------------------
// Steps

function preflight() {
  const checks = [];
  const node = process.versions.node.split('.').map(Number);
  const okNode = node[0] > MIN_NODE_MAJOR || (node[0] === MIN_NODE_MAJOR && node[1] >= MIN_NODE_MINOR);
  checks.push({ name: `Node ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`, ok: okNode, detail: `current ${process.version}` });

  const npmVersion = tryCapture('npm --version');
  checks.push({ name: 'npm on PATH', ok: !!npmVersion, detail: npmVersion ? `v${npmVersion.trim()}` : 'not found' });

  const git = tryCapture('git --version');
  checks.push({ name: 'git on PATH', ok: !!git, detail: git ? git.trim() : 'not found (update will be unavailable)' });

  const pkg = exists(REPO_PKG);
  checks.push({ name: 'repo package.json', ok: pkg, detail: REPO_PKG });

  const skill = exists(REPO_SKILL);
  checks.push({ name: 'repo SKILL.md', ok: skill, detail: REPO_SKILL });

  const ok = checks.filter((c2) => c2.name !== 'git on PATH').every((c2) => c2.ok);
  console.log('preflight:');
  for (const c2 of checks) printCheck(c2);
  return { ok, checks };
}

function npmInstall() {
  console.log('');
  console.log(c('bold', 'npm install') + c('dim', `  (cwd: ${REPO_ROOT})`));
  run('npm install --no-audit --no-fund --silent', { cwd: REPO_ROOT });
}

function npmLink() {
  console.log('');
  console.log(c('bold', 'npm link') + c('dim', '  (puts `lwdb` on PATH)'));
  try {
    run('npm link --silent', { cwd: REPO_ROOT });
  } catch (err) {
    console.error(c('yellow', `npm link failed: ${err.message}`));
    console.error(c('yellow', 'Falling back to a local symlink in ~/.local/bin'));
    const target = path.join(REPO_ROOT, 'bin', 'lwdb.mjs');
    const localBin = path.join(HOME, '.local', 'bin');
    ensureDir(localBin);
    const linkPath = path.join(localBin, 'lwdb');
    if (exists(linkPath)) fs.rmSync(linkPath);
    fs.symlinkSync(target, linkPath);
    console.log(c('green', `✓ linked ${linkPath} -> ${target}`));
    console.log(c('dim', '  Make sure ~/.local/bin is on your PATH.'));
  }
}

function snapshotSkill() {
  if (!exists(REPO_SKILL)) {
    console.error(c('red', `✗ ${REPO_SKILL} missing — can't snapshot skill.`));
    process.exit(1);
  }
  ensureDir(SKILL_DIR);
  fs.copyFileSync(REPO_SKILL, CANONICAL_SKILL);
  console.log(c('green', `✓ skill snapshot -> ${CANONICAL_SKILL}`));
}

/**
 * Record where the desktop app should find Node + the server. The desktop
 * (which inherits a minimal PATH and can't see nvm/version-manager Node) reads
 * this to launch the server with an absolute, known-good runtime. `process.execPath`
 * is the Node that ran this installer — install.mjs preflight already enforces ≥22.5.
 */
export function writeLauncherManifest(dir = LWDB_DIR) {
  ensureDir(dir);
  const pkg = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8'));
  const manifest = {
    version: pkg.version,
    node: process.execPath,
    serverEntry: path.join(REPO_ROOT, 'server', 'index.mjs'),
    cli: path.join(REPO_ROOT, 'bin', 'lwdb.mjs'),
    cwd: REPO_ROOT,
    writtenAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'launcher.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(c('green', `✓ launcher manifest -> ${path.join(dir, 'launcher.json')}`));
  return manifest;
}

function linkSkillsForAllAITools() {
  for (const tool of AI_TOOLS) {
    if (!isToolPresent(tool)) continue;
    const dir = path.join(HOME, tool.skillsRel);
    ensureDir(dir);
    const link = path.join(dir, SKILL_NAME);
    // Replace existing link/file/dir with a fresh symlink to SKILL_DIR.
    if (exists(link)) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(SKILL_DIR, link, 'dir');
    console.log(c('green', `✓ ${tool.name}: linked ${link} -> ${SKILL_DIR}`));
  }
}

function doctor({ exitOnFail = true } = {}) {
  console.log(c('bold', 'doctor'));
  const checks = [];

  // 1. Node version
  const node = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'Node version',
    ok: node[0] > MIN_NODE_MAJOR || (node[0] === MIN_NODE_MAJOR && node[1] >= MIN_NODE_MINOR),
    detail: `current ${process.version} (required ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})`,
  });

  // 2. node_modules present
  checks.push({
    name: 'dependencies installed',
    ok: exists(path.join(REPO_ROOT, 'node_modules')),
    detail: path.join(REPO_ROOT, 'node_modules'),
  });

  // 3. lwdb on PATH
  const lwdbPath = which('lwdb');
  checks.push({
    name: 'lwdb on PATH',
    ok: !!lwdbPath,
    detail: lwdbPath || 'run `npm link` in repo root',
  });

  // 4. SKILL.md snapshot
  checks.push({
    name: 'skill snapshot',
    ok: exists(CANONICAL_SKILL),
    detail: CANONICAL_SKILL,
  });

  // 5. Claude Code skill link
  const claudeLink = path.join(HOME, '.claude', 'skills', SKILL_NAME);
  const claudeLinkExists = exists(claudeLink);
  const claudeTarget = claudeLinkExists ? readlinkSafe(claudeLink) : null;
  checks.push({
    name: 'Claude Code skill link',
    ok: claudeLinkExists,
    detail: claudeLinkExists ? `${claudeLink} -> ${claudeTarget || '(no symlink target)'}` : claudeLink,
  });

  // 6. desktop launcher manifest (Node + server path the .deb uses)
  if (!exists(LAUNCHER_MANIFEST)) {
    checks.push({ name: 'desktop launcher manifest', ok: false, detail: `${LAUNCHER_MANIFEST} (run install to create)` });
  } else {
    try {
      const m = JSON.parse(fs.readFileSync(LAUNCHER_MANIFEST, 'utf8'));
      const nodeOk = !!m.node && exists(m.node);
      const entryOk = !!m.serverEntry && exists(m.serverEntry);
      checks.push({
        name: 'desktop launcher manifest',
        ok: nodeOk && entryOk,
        detail: `node ${nodeOk ? '✓' : 'missing'}, serverEntry ${entryOk ? '✓' : 'missing'}`,
      });
    } catch (e) {
      checks.push({ name: 'desktop launcher manifest', ok: false, detail: `invalid JSON: ${e.message}` });
    }
  }

  // 8. lwdb config loads
  if (lwdbPath) {
    const r = spawnSync(lwdbPath, ['--json', 'servers'], { encoding: 'utf8', timeout: 10_000 });
    let parsed = null;
    try { parsed = r.stdout && JSON.parse(r.stdout); } catch (_) { /* ignore */ }
    const okExit = r.status === 0 && Array.isArray(parsed);
    checks.push({
      name: 'lwdb servers loads',
      ok: okExit,
      detail: okExit ? `${parsed.length} server(s) loaded` : (r.stderr || `exit ${r.status}`).trim().split('\n')[0],
    });
  }

  for (const ck of checks) printCheck(ck);
  const failed = checks.filter((c2) => !c2.ok).length;
  console.log('');
  if (failed === 0) console.log(c('green', '✓ doctor: all clear'));
  else console.log(c('yellow', `! doctor: ${failed} check(s) failed`));
  if (exitOnFail && failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers

function banner(verb) {
  const pkg = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8'));
  console.log(c('bold', `lwdb ${verb}`) + c('dim', `  v${pkg.version}`));
  console.log(c('dim', `  repo: ${REPO_ROOT}`));
  console.log('');
}

function printCheck(check) {
  const mark = check.ok ? c('green', '✓') : c('red', '✗');
  const name = check.name.padEnd(28);
  const detail = check.detail ? c('dim', check.detail) : '';
  console.log(`  ${mark} ${name} ${detail}`);
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (_) { return false; }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readlinkSafe(p) {
  try { return fs.readlinkSync(p); } catch (_) { return null; }
}

function isToolPresent(tool) {
  return exists(path.join(HOME, tool.parent));
}

function which(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim().split('\n')[0];
    return null;
  } catch (_) { return null; }
}

function tryCapture(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { return null; }
}

function tryRun(cmd, { allowFailure = false, silent = false, cwd } = {}) {
  try { execSync(cmd, { stdio: silent ? 'ignore' : 'inherit', cwd }); return true; }
  catch (err) {
    if (allowFailure) return false;
    throw err;
  }
}

function run(cmd, { cwd } = {}) {
  execSync(cmd, { stdio: 'inherit', cwd });
}

function isGitRepo() {
  return exists(path.join(REPO_ROOT, '.git'));
}

function gitPull() {
  console.log('');
  console.log(c('bold', 'git pull'));
  try { run('git pull --ff-only', { cwd: REPO_ROOT }); }
  catch (_) {
    console.error(c('yellow', '  fast-forward failed — leaving working tree as-is.'));
    console.error(c('yellow', '  Resolve manually (commit/stash/discard) and run update again.'));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
