#!/usr/bin/env node
/**
 * Move every version source to one release number.
 *
 * VERSION is authoritative; this script rewrites the generated duplicates and
 * then runs the consistency check, so a partial bump can never be committed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const write = (path, text) => writeFileSync(join(root, path), text);

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/bump-version.mjs <major.minor.patch>');
  process.exit(1);
}

function runCheck() {
  try {
    console.log(execFileSync(process.execPath, [join(root, 'scripts/check-versions.mjs')], { cwd: root, encoding: 'utf8' }).trim());
  } catch (error) {
    console.error(error.stdout || error.message);
    process.exit(1);
  }
}

if (read('VERSION').trim() === version) {
  // Re-running must not inflate android.versionCode, which only moves forward.
  console.log(`VERSION is already ${version}; nothing to bump`);
  runCheck();
  process.exit(0);
}

/** Rewrite one JSON file while keeping its two-space layout and trailing newline. */
function bumpJson(path, mutate) {
  const data = JSON.parse(read(path));
  mutate(data);
  write(path, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/** Replace only the version line inside the named TOML table. */
function bumpTomlSection(text, table, key, value) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start < 0) throw new Error(`Missing [${table}] section`);
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const limit = end < 0 ? lines.length : end;
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*["'])[^"']*(["'].*)$`);
  for (let index = start + 1; index < limit; index += 1) {
    const match = lines[index].match(pattern);
    if (match) {
      lines[index] = `${match[1]}${value}${match[2]}`;
      return lines.join('\n');
    }
  }
  throw new Error(`Missing ${key} in [${table}]`);
}

/** Cargo.lock pins the workspace crate version; `cargo --locked` rejects drift. */
function bumpCargoLock(text, crate, value) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  let matched = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '[[package]]') {
      inPackage = true;
      matched = false;
      continue;
    }
    if (!inPackage) continue;
    if (line === `name = "${crate}"`) {
      matched = true;
      continue;
    }
    if (matched && /^version = /.test(line)) {
      lines[index] = `version = "${value}"`;
      return lines.join('\n');
    }
  }
  throw new Error(`Missing ${crate} in Cargo.lock`);
}

write('VERSION', `${version}\n`);

bumpJson('package.json', (data) => {
  data.version = version;
});

for (const group of ['apps', 'packages']) {
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    bumpJson(`${group}/${entry.name}/package.json`, (data) => {
      data.version = version;
    });
  }
}

bumpJson('apps/desktop/src-tauri/tauri.conf.json', (data) => {
  data.version = version;
});

write(
  'apps/desktop/src-tauri/Cargo.toml',
  bumpTomlSection(read('apps/desktop/src-tauri/Cargo.toml'), 'package', 'version', version),
);
write(
  'apps/desktop/src-tauri/Cargo.lock',
  bumpCargoLock(read('apps/desktop/src-tauri/Cargo.lock'), 'rescene-desktop', version),
);

const appJson = bumpJson('apps/mobile/app.json', (data) => {
  data.expo.version = version;
  const code = data.expo.android?.versionCode;
  if (Number.isSafeInteger(code) && code >= 1) data.expo.android.versionCode = code + 1;
});
const versionCode = appJson.expo.android?.versionCode;

runCheck();

console.log(`Bumped to ${version}${versionCode ? ` (Android versionCode ${versionCode})` : ''}`);
