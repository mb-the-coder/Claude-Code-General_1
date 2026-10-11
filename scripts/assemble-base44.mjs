#!/usr/bin/env node
// Assembles a drop-in Base44 tree from the source layout:
//
//   build/base44-bundle/
//     base44/entities/*.jsonc                    <- entities/
//     base44/functions/<name>/entry.ts           <- backend/functions/<name>.ts (bundled, self-contained)
//     src/omnicompetitor/{components,pages,lib}  <- frontend sources (relative imports preserved)
//
// Copy the contents into your Base44 app repo (or run `base44 deploy` from it).

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENTITY_NAMES, FRONTEND_FILES, FUNCTION_NAMES, ROOT, bundleFunction, findUnresolvedImports, frontendImportGraph } from './lib.mjs';

const OUT = path.join(ROOT, 'build', 'base44-bundle');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

await rm(OUT, { recursive: true, force: true });

// 1. Entities ---------------------------------------------------------------------------------
for (const name of ENTITY_NAMES) {
  const dest = path.join(OUT, 'base44', 'entities', `${name}.jsonc`);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(ROOT, 'entities', `${name}.jsonc`), dest);
  console.log(`entity    ${name}.jsonc`);
}

// 2. Backend functions -----------------------------------------------------------------------
for (const name of FUNCTION_NAMES) {
  const code = await bundleFunction(name);
  const unresolved = findUnresolvedImports(code);
  if (unresolved.length > 0) {
    throw new Error(`${name}: bundle still imports ${unresolved.join(', ')} - Deno could not resolve these.`);
  }
  if (!/export\s*\{[^}]*\bas default\b[^}]*\}|export default/.test(code)) {
    throw new Error(`${name}: bundle has no default export; Base44 requires one.`);
  }
  const dest = path.join(OUT, 'base44', 'functions', name, 'entry.ts');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, code);
  console.log(`function  ${name}/entry.ts (${kb(code.length)})`);
}

// 3. Frontend ----------------------------------------------------------------------------------
// Fail the build if the page imports anything we are not shipping (or anything from backend/ or lib/ai).
const graph = await frontendImportGraph();
const missing = graph.filter((f) => !FRONTEND_FILES.includes(f));
if (missing.length > 0) throw new Error(`The page imports files that are not in FRONTEND_FILES: ${missing.join(', ')}`);

for (const rel of FRONTEND_FILES) {
  const dest = path.join(OUT, 'src', 'omnicompetitor', rel);
  await mkdir(path.dirname(dest), { recursive: true });
  const source = await readFile(path.join(ROOT, rel), 'utf8');
  await writeFile(dest, source);
}
console.log(`frontend  ${FRONTEND_FILES.length} files -> src/omnicompetitor/`);

console.log(`\nDone: ${path.relative(ROOT, OUT)}`);
