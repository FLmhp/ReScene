#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './manifest-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const args = process.argv.slice(2);
  if (args[0] !== '--source-manifest' || !args[1] || args[1].startsWith('--') || args.length < 3) {
    throw new Error('Usage: node scripts/release-manifest.mjs --source-manifest <source-manifest.json> <artifact> [artifact ...] > release-manifest.json');
  }
  const sourcePath = args[1];
  if (!(await lstat(sourcePath)).isFile()) throw new Error(`Not a regular file: ${sourcePath}`);
  const sourceManifest = { name: basename(sourcePath), ...await hashFile(sourcePath) };
  const paths = args.slice(2);
  const names = new Set();
  const artifacts = [];
  for (const path of paths) {
    const name = basename(path);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate artifact name: ${name}`);
    names.add(name.toLowerCase());
    if (!(await lstat(path)).isFile()) throw new Error(`Not a regular file: ${path}`);
    artifacts.push({ name, ...await hashFile(path) });
  }
  artifacts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  console.log(JSON.stringify({ schema: 1, version, sourceManifest, artifacts }, null, 2));
} catch (error) {
  console.error(`Release manifest failed: ${error.message}`);
  process.exitCode = 1;
}
