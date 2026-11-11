#!/usr/bin/env node
// Print the CHANGELOG.md section for the current VERSION, for use as GitHub release notes.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VERSION must be a numeric major.minor.patch version');
  const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const heading = new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section; write release notes before tagging`);
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section "## ${version}" is empty`);
  console.log(body);
} catch (error) {
  console.error(`Release notes failed: ${error.message}`);
  process.exitCode = 1;
}
