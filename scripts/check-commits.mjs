#!/usr/bin/env node
/**
 * Reject commits whose subject does not follow the conventional-commit grammar.
 *
 * Merge commits are exempt because GitHub writes them.
 */
import { execFileSync } from 'node:child_process';

const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+/;

function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const range = option('--range');
if (!range) {
  console.error('Usage: node scripts/check-commits.mjs --range <git range>');
  process.exit(1);
}

const log = execFileSync('git', ['log', '--format=%s', range], { encoding: 'utf8' });
const bad = log
  .split(/\r?\n/)
  .filter((subject) => subject.trim() && !subject.startsWith('Merge '))
  .filter((subject) => !SUBJECT.test(subject));

if (bad.length) {
  console.error(`commit subjects must match "<type>(<scope>)?: <subject>" (types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert)\n`);
  for (const subject of bad) console.error(`  ${subject}`);
  process.exit(1);
}

console.log(`Commit subjects look conventional: ${range}`);
