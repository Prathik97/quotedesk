// Bundles the API router and all of our own code (api/_lib, engine, shared schemas and types)
// into one ESM file, .build/handler.mjs, so the deployed function does no per file module
// resolution. Packages listed in package.json dependencies stay external; Vercel ships them
// from node_modules. Run by `npm run build`, before the Vite build.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);

rmSync('.build', { recursive: true, force: true });
const result = await build({
  entryPoints: ['api/_lib/router.ts'],
  outfile: '.build/handler.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  logLevel: 'warning',
  metafile: true,
  // Some dependencies are CommonJS and call require(); give the ESM bundle a require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Fail loudly if anything we did not intend to leave external is imported at run time.
const bad = Object.values(result.metafile.outputs)
  .flatMap((o) => o.imports)
  .filter((i) => i.external && !i.path.startsWith('node:') && !external.some((e) => i.path === e || (e.endsWith('/*') && i.path.startsWith(e.slice(0, -1)))));
if (bad.length) {
  console.error('Unexpected external imports in the function bundle:', [...new Set(bad.map((b) => b.path))].join(', '));
  process.exit(1);
}
console.log('Built .build/handler.mjs');
