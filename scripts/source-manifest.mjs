#!/usr/bin/env node
import { readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './manifest-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Only project-owned source trees and explicitly named root inputs are considered.
const trees = ['src', 'apps', 'packages', 'scripts', 'tests', 'configs', 'infra', 'docs', '.github/workflows'];
const rootFiles = ['VERSION', 'README.md', 'CHANGELOG.md', 'pyproject.toml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.gitignore', '.dockerignore', '.editorconfig', '.gitattributes', 'workerctl'];
const extensions = new Set(['.py', '.pyi', '.toml', '.json', '.jsonc', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.rs', '.lock', '.sh', '.ps1', '.md', '.txt', '.conf', '.caddy', '.cron', '.sql', '.png', '.ico', '.svg']);
const excludedDirs = new Set(['node_modules', 'dist', 'build', 'target', 'gen', 'coverage', '__pycache__', '.expo', '.next', '.git', 'secrets', 'backups', 'postgres']);
const sensitive = /(^|[._-])(secret|secrets|credential|credentials|password|token|private|apikey|api-key|keystore)([._-]|$)|\.(pem|key|p12|pfx|jks|keystore)$/i;

async function walk(path, files) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || sensitive.test(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name.toLowerCase()) && !entry.name.endsWith('.egg-info')) await walk(full, files);
    } else if (entry.isFile() && (extensions.has(extname(entry.name).toLowerCase()) || ['Dockerfile', 'workerctl'].includes(entry.name))) {
      files.push(full);
    }
  }
}

try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/source-manifest.mjs > source-manifest.json');
  const files = rootFiles.map((file) => join(root, file));
  for (const tree of trees) await walk(join(root, tree), files);
  files.sort((a, b) => relative(root, a).split(sep).join('/').localeCompare(relative(root, b).split(sep).join('/'), 'en'));
  const entries = [];
  for (const file of files) {
    if (!(await lstat(file)).isFile()) throw new Error(`Not a regular file: ${file}`);
    entries.push({ path: relative(root, file).split(sep).join('/'), ...await hashFile(file) });
  }
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  console.log(JSON.stringify({ schema: 1, version, files: entries }, null, 2));
} catch (error) {
  console.error(`Source manifest failed: ${error.message}`);
  process.exitCode = 1;
}
