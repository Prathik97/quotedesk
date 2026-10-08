// The single Vercel function for the whole API (the Hobby plan allows 12).
// Vercel must not compile our source file by file (strict ESM would reject extensionless imports),
// so this file only re-exports the bundle that `npm run build` writes with esbuild from
// api/_lib/router.ts. See DEPLOY.md and DECISIONS.md D67.
import handler from '../.build/handler.mjs';

export default handler;
