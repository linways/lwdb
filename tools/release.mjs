#!/usr/bin/env node
/**
 * Cut a release by tagging — tag-driven versioning.
 *
 *   node tools/release.mjs <patch|minor|major>
 *   (or: npm run release:patch | release:minor | release:major)
 *
 * Computes the next semver from the latest `vX.Y.Z` git tag, creates that tag,
 * and pushes it. Pushing a `v*` tag triggers .github/workflows/release.yml,
 * which stamps the version into the build and publishes the GitHub Release.
 *
 * The git tag is the version of record — there are no version files to edit.
 */
import { execSync } from 'node:child_process';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('usage: node tools/release.mjs <patch|minor|major>');
  process.exit(2);
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const shq = (cmd) => { try { return sh(cmd); } catch { return ''; } };
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// Releases are cut from a clean, in-sync main.
const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`on '${branch}', not main — releases are cut from main (git checkout main).`);
// Ignore untracked files — they aren't part of the tagged commit. Only block
// on uncommitted changes to tracked files.
if (sh('git status --porcelain --untracked-files=no')) fail('tracked files have uncommitted changes — commit or stash first.');
sh('git fetch --tags --quiet origin');
const local = sh('git rev-parse @');
const upstream = shq('git rev-parse @{u}');
if (upstream && local !== upstream) fail('local main differs from origin/main — run: git pull');

// Latest v* tag → next version.
const tags = shq("git tag --list 'v*' --sort=-v:refname").split('\n').filter(Boolean);
const latest = tags[0] || 'v0.0.0';
const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(latest);
if (!m) fail(`latest tag '${latest}' is not in vX.Y.Z form — tag a baseline first.`);

let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
if (bump === 'major') { maj += 1; min = 0; pat = 0; }
else if (bump === 'minor') { min += 1; pat = 0; }
else { pat += 1; }
const next = `v${maj}.${min}.${pat}`;
if (tags.includes(next)) fail(`${next} already exists.`);

console.log(`Releasing ${latest} → ${next} (${bump}) from main @ ${local.slice(0, 7)}`);
sh(`git tag ${next}`);
sh(`git push origin ${next}`);
console.log(`✓ pushed ${next}. CI is building: https://github.com/linways/lwdb/actions`);
