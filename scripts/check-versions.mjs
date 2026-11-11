#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const section = (text, name) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start < 0) throw new Error(`Missing [${name}] section`);
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
const match = (text, pattern, label) => {
  const result = text.match(pattern);
  if (!result) throw new Error(`Cannot find ${label}`);
  return result[1];
};

try {
  const version = read('VERSION').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VERSION must be a numeric major.minor.patch version');
  const failures = [];
  const check = (label, actual) => {
    if (actual !== version) failures.push(`${label}: expected ${version}, got ${JSON.stringify(actual)}`);
  };
  const pyproject = read('pyproject.toml');
  const project = section(pyproject, 'project');
  if (/^\s*dynamic\s*=\s*\[[^\]]*["']version["']/m.test(project)) {
    const dynamic = section(pyproject, 'tool.setuptools.dynamic');
    const file = match(dynamic, /^\s*version\s*=\s*\{\s*file\s*=\s*["']([^"']+)["']\s*\}/m, 'setuptools dynamic version file');
    if (file !== 'VERSION') failures.push(`pyproject.toml: dynamic version must use VERSION, got ${file}`);
  } else {
    check('pyproject.toml', match(project, /^\s*version\s*=\s*["']([^"']+)["']/m, 'Python project version'));
  }
  const packageInit = read('src/rescene/__init__.py');
  if (!/__version__\s*=\s*version\(["']rescene["']\)/.test(packageInit)) {
    check('src/rescene/__init__.py', match(packageInit, /^\s*__version__\s*=\s*["']([^"']+)["']/m, 'Python package version'));
  }
  const apiMain = read('src/rescene_api/main.py');
  if (!/FastAPI\s*\([^)]*?version\s*=\s*package_version\(["']rescene["']\)/s.test(apiMain)) {
    check('src/rescene_api/main.py', match(apiMain, /\bFastAPI\s*\([^)]*?\bversion\s*=\s*["']([^"']+)["']/s, 'FastAPI version'));
  }
  const rootPackage = json('package.json');
  check('package.json', rootPackage.version);
  if (rootPackage.packageManager !== 'pnpm@10.18.3') failures.push(`package.json: expected pnpm@10.18.3, got ${JSON.stringify(rootPackage.packageManager)}`);
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${group}/${entry.name}/package.json`;
      check(path, json(path).version);
    }
  }
  check('apps/desktop/src-tauri/tauri.conf.json', json('apps/desktop/src-tauri/tauri.conf.json').version);
  check('apps/desktop/src-tauri/Cargo.toml', match(section(read('apps/desktop/src-tauri/Cargo.toml'), 'package'), /^\s*version\s*=\s*["']([^"']+)["']/m, 'Rust package version'));
  const cargoLock = read('apps/desktop/src-tauri/Cargo.lock');
  const lockEntry = cargoLock.split(/\r?\n\[\[package\]\]\r?\n/).find((block) => /^name = "rescene-desktop"$/m.test(block));
  if (!lockEntry) throw new Error('Cargo.lock has no rescene-desktop package');
  check('apps/desktop/src-tauri/Cargo.lock', match(lockEntry, /^version = ["']([^"']+)["']$/m, 'Cargo.lock package version'));
  const expo = json('apps/mobile/app.json').expo;
  check('apps/mobile/app.json expo.version', expo.version);
  if (expo.android?.versionCode !== undefined && (!Number.isSafeInteger(expo.android.versionCode) || expo.android.versionCode < 1)) {
    failures.push('apps/mobile/app.json: android.versionCode must be a positive integer');
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Version metadata is consistent: ${version}`);
} catch (error) {
  console.error(`Version check failed: ${error.message}`);
  process.exitCode = 1;
}
