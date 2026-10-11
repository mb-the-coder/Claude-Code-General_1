#!/usr/bin/env node
// Runs the PRODUCTION function bundles on real Deno (the Base44 runtime) against fakes.
// Needs Deno: set DENO_BIN or have `deno` on PATH. Not part of `npm run check` because it needs Deno and
// network access to the npm registry (Deno downloads the pinned npm: dependencies on first run).
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FUNCTION_NAMES, ROOT, bundleFunction } from './lib.mjs';

const OUT = path.join(ROOT, 'build', 'deno-smoke');
const deno = process.env.DENO_BIN ?? 'deno';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'sdk-stub.ts'), `export function createClientFromRequest(req: Request) { return (globalThis as any).__base44Factory(req); }\n`);

for (const name of FUNCTION_NAMES) {
  const code = (await bundleFunction(name)).replace('"npm:@base44/sdk@0.8.40"', '"./sdk-stub.ts"');
  await writeFile(path.join(OUT, `${name}.ts`), code);
}

const run = spawnSync(deno, ['run', '--allow-net', '--allow-env', '--allow-read', path.join(ROOT, 'scripts', 'deno-harness.ts'), OUT], {
  stdio: 'inherit',
  env: { ...process.env, NO_COLOR: '1' },
});
if (run.error) {
  console.error(`Could not run Deno (${run.error.message}). Install Deno or set DENO_BIN.`);
  process.exit(2);
}
process.exit(run.status ?? 1);
