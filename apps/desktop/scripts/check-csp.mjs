#!/usr/bin/env node
/**
 * Guards the desktop image CSP. Share QR codes are plain <img> elements whose
 * source comes from ResceneClient.shareQrUrl(): `${apiBaseUrl}/v1/public/shares/
 * {token}/qr.png`. If the API origin is missing from img-src the workbench shows
 * broken images, so fail the build (or dev server start) instead of shipping it.
 *
 * Usage: check-csp.mjs [--mode=build|dev]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_API = 'https://api.rescene.xyz';
const DEV_API = 'http://localhost:8000';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.on('uncaughtException', (error) => {
  console.error(`CSP check failed: ${error.message}`);
  process.exit(1);
});
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'build';
if (mode !== 'build' && mode !== 'dev') throw new Error(`Unknown mode ${JSON.stringify(mode)}; use build or dev`);

function parseCsp(label, csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (directives.has(name)) throw new Error(`${label} repeats CSP directive ${name}`);
    directives.set(name, sources);
  }
  return directives;
}

function apiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_API_URL must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`VITE_API_URL must use http(s), got ${JSON.stringify(value)}`);
  return url.origin;
}

const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const security = config.app?.security;
if (typeof security?.csp !== 'string' || security.csp.trim() === '') throw new Error('app.security.csp must be a non-empty string');
if (typeof security.devCsp !== 'string' || security.devCsp.trim() === '') throw new Error('app.security.devCsp must be a non-empty string');

const override = process.env.VITE_API_URL ? apiOrigin(process.env.VITE_API_URL) : undefined;
const profiles = [
  { label: 'app.security.csp', csp: security.csp, api: (mode === 'dev' ? undefined : override) ?? RELEASE_API },
  { label: 'app.security.devCsp', csp: security.devCsp, api: (mode === 'dev' ? override : undefined) ?? DEV_API },
];

const failures = [];
for (const { label, csp, api } of profiles) {
  const directives = parseCsp(label, csp);
  const img = directives.get('img-src');
  if (!img) {
    failures.push(`${label}: missing img-src`);
    continue;
  }
  if (!img.includes(api)) failures.push(`${label}: img-src must allow the share QR origin ${api}`);
  const wildcard = img.find((source) => source === '*' || source === 'http:' || source === 'https:');
  if (wildcard !== undefined) failures.push(`${label}: img-src must not allow arbitrary ${wildcard} sources; add exact hosts`);
  const required = [
    ['default-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['frame-ancestors', "'none'"],
  ];
  for (const [directive, expected] of required) {
    const actual = directives.get(directive);
    if (!actual || actual.length !== 1 || actual[0] !== expected) {
      failures.push(`${label}: ${directive} must stay ${expected}`);
    }
  }
}
if (failures.length) throw new Error(failures.join('\n'));
console.log(`Desktop CSP img-src covers share QR origins: ${profiles.map(({ api }) => api).join(', ')} (${mode})`);
