// Fails when src/api/schema.d.ts is out of date with spec/openapi.yaml.
// The same comparison runs in the test suite (src/api/schema.test.ts).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const spec = new URL('../../spec/openapi.yaml', import.meta.url);
const committed = new URL('../src/api/schema.d.ts', import.meta.url);

export async function generate() {
  return astToString(await openapiTS(spec));
}

export async function isUpToDate() {
  const [fresh, current] = await Promise.all([generate(), readFile(committed, 'utf8')]);
  return normalise(fresh) === normalise(current);
}

function normalise(source) {
  // The CLI prepends a banner comment that the programmatic API does not.
  return source
    .replace(/\r\n/g, '\n')
    .replace(/^\/\*\*[\s\S]*?\*\/\s*/, '')
    .trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (await isUpToDate()) {
    console.log('src/api/schema.d.ts is up to date with spec/openapi.yaml');
  } else {
    console.error('src/api/schema.d.ts is stale. Run: pnpm --filter web gen:api');
    process.exit(1);
  }
}
