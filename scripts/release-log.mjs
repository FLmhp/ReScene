#!/usr/bin/env node
// Combine the artifact hashes with the deploy record into one release log, so a
// published release names the exact bytes it shipped and where they went.
import { readFile } from 'node:fs/promises';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

try {
  const tag = argument('--tag');
  const commit = argument('--commit');
  const deployResult = argument('--deploy-result');
  const manifest = await readJson(argument('--release-manifest'));
  if (!manifest) throw new Error('The release manifest is missing');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('The release manifest lists no artifacts');
  }
  const deployLog = await readJson(argument('--deploy-log'));

  const assets = [...manifest.artifacts, manifest.sourceManifest].map((entry) => ({
    name: entry.name,
    size: entry.size,
    sha256: entry.sha256,
  }));
  const duplicated = assets.filter((asset, index) => assets.findIndex((other) => other.name === asset.name) !== index);
  if (duplicated.length > 0) throw new Error(`Duplicate asset names: ${duplicated.map((asset) => asset.name).join(', ')}`);
  assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const deploy = deployLog
    ? {
        ok: deployLog.ok === true,
        failedStep: deployLog.failedStep ?? null,
        host: deployLog.host ?? null,
        ...deployLog.deploy,
      }
    : null;
  console.log(
    JSON.stringify(
      {
        schema: 1,
        version: manifest.version,
        tag,
        commit,
        runUrl: `${server}/${repository}/actions/runs/${runId}`,
        generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        deployResult,
        assets,
        // A deploy that never ran is recorded as absent, never as a success.
        deploy,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Release log failed: ${error.message}`);
  process.exitCode = 1;
}
