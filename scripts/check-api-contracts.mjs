/**
 * Parse the checked-in golden API responses with the shared zod contracts.
 *
 * `scripts/generate_contract_fixtures.py` captures what FastAPI returns for the
 * endpoints the clients consume; this script proves the server still satisfies
 * `@rescene/schemas`. A rename, a retyped field, or an unexpected key makes the
 * client's `schema.parse` fail at runtime, so it must fail here first.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const contractsDir = new URL("../tests/contracts/", import.meta.url);
const schemasEntry = fileURLToPath(new URL("../packages/schemas/src/index.ts", import.meta.url));

// Node cannot import the workspace's TypeScript sources directly; transpile them
// in-process the same way the other dependency-free check scripts do.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, ...rest) {
  try {
    return resolveFilename.call(this, request, parent, ...rest);
  } catch (error) {
    if (request.startsWith(".") && parent?.filename?.endsWith(".ts")) {
      return resolveFilename.call(this, `${request}.ts`, parent, ...rest);
    }
    throw error;
  }
};
require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const schemas = require(schemasEntry);

const ProjectOverviewSchema = schemas.ProjectSummarySchema.or(schemas.ProjectDetailSchema);

const cases = {
  "asset_page.json": schemas.AssetPageSchema,
  "auth_me.json": schemas.UserSchema,
  "job.json": schemas.JobSchema,
  "job_page.json": schemas.JobPageSchema,
  "job_stages.json": schemas.JobStageSchema.array(),
  "notification_count.json": schemas.NotificationCountSchema,
  "notifications.json": schemas.NotificationSchema.array(),
  "project_detail.json": schemas.ProjectDetailSchema,
  // The workspace screen accepts both the summary and the legacy full response.
  "project_summary.json": ProjectOverviewSchema,
  "projects_list.json": schemas.ProjectSchema.array(),
  "share.json": schemas.ShareSchema,
  "shares.json": schemas.ShareSummarySchema.array(),
  "upload_session.json": schemas.UploadGrantSchema,
};

const files = readdirSync(contractsDir)
  .filter((name) => name.endsWith(".json"))
  .sort();
const failures = [];

for (const name of files) {
  const schema = cases[name];
  if (!schema) {
    failures.push(`${name}: no zod schema is bound to this fixture`);
    continue;
  }
  const fixture = JSON.parse(readFileSync(new URL(name, contractsDir), "utf8"));
  const result = schema.safeParse(fixture);
  if (!result.success) {
    failures.push(`${name}: ${result.error.message}`);
    continue;
  }
  try {
    // The client strips unknown keys silently; comparing the parse result back
    // against the fixture turns an added server field into a CI failure.
    assert.deepStrictEqual(result.data, fixture);
  } catch (error) {
    failures.push(`${name}: response does not match the zod key set (${error.message})`);
  }
}

for (const name of Object.keys(cases)) {
  if (!files.includes(name)) failures.push(`${name}: fixture is missing; run the Python generator`);
}

if (failures.length) {
  console.error("API contract drift:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`Parsed ${files.length} contract fixtures against the zod schemas.`);
