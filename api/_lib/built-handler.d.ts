// Types for the generated bundle (.build/handler.mjs). The file only exists after `npm run build:function`.
declare module '*/.build/handler.mjs' {
  import type { VercelRequest, VercelResponse } from '@vercel/node';
  const handler: (req: VercelRequest, res: VercelResponse) => Promise<void>;
  export default handler;
}
