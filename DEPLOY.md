# Deploying QuoteDesk to Vercel

This file lists the exact settings and the environment variable names. It never holds a value. Put values in the Vercel dashboard only.

## 1. Project settings

| Setting | Value |
|---|---|
| Git repository | `Prathik97/quotedesk`, branch `main` |
| Framework preset | Vite |
| Root directory | repository root (leave blank) |
| Install command | `npm ci` |
| Build command | `npm run build` (runs `tsc --noEmit`, then `npm run build:function`, then `vite build`) |
| Output directory | `dist` |
| Node.js version | 22.x (Project Settings, General, Node.js Version). `package.json` also pins `22.x` and `.nvmrc` says 22 |

`vercel.json` already sets the framework, commands and output directory, so the dashboard values only need to agree with it. It also holds the three things that are easy to miss:

- **One API function, bundled.** `api/[[...path]].ts` serves every `/api/<name>` route, but it is a two line file that re-exports `.build/handler.mjs`. That file is written at build time by `scripts/build-function.mjs` (esbuild): it bundles `api/_lib` (router and routes), `engine` and the shared `src/lib` schemas and types into one ESM file. Packages in `dependencies` stay external and ship from `node_modules`. Vercel therefore never resolves our modules file by file, which is what broke the first deploy (extensionless imports such as `./certainty` fail in strict Node ESM). `.build/` is generated and gitignored. Routes live in `api/_lib/routes/` (a folder starting with an underscore is never deployed as its own function), which keeps the project under the Hobby limit of 12 functions.
- **`maxDuration` 60** for that function, and **`includeFiles: {prompts/**,.build/**}`** so the versioned prompt files (read from disk at run time) and the bundle are shipped with it.
- **SPA fallback rewrite.** Every path that is not `/api/...` and not a real file in `dist` returns `index.html`, so a refresh on `/eval` or `/analyst` works.

## 2. Environment variables

Add these under Project Settings, Environment Variables. **All of them are server side only.** None starts with `VITE_`, so none can enter the browser bundle (`npm run check:bundle` verifies this on every build you care about). Tick **Production** only: a preview deployment with these keys could spend your money from an unreviewed branch.

Mark the ones in the Sensitive column as Sensitive in the dashboard so they cannot be read back.

| Name | Required | Sensitive | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | yes | Used by the Anthropic SDK on the server. |
| `MODEL_EXTRACT` | yes | no | Same model id as `.env.example`. |
| `MODEL_ANALYST` | yes | no | Same. |
| `MODEL_FAST` | yes | no | Same. |
| `SUPABASE_URL` | yes | no | Used for signed Storage reads (source view) only, on the server. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | yes | Server only. Also salts the IP hash if `IP_HASH_SALT` is not set. |
| `SUPABASE_DB_URL` | yes | yes | Session pooler connection string for the `postgres` role. |
| `SUPABASE_DB_READONLY_URL` | yes | yes | The `quotedesk_ro` role, written to `.env.local` by `npm run db:migrate`. The analyst SQL tool will not work without it. |
| `DAILY_SPEND_CAP_INR` | yes | no | Daily spend cap in rupees across all model routes. `0` turns live model calls off. |
| `PER_IP_HOURLY_CALLS` | yes | no | Live model requests per hour from one address (hashed). `0` turns them off. |
| `DEFAULT_USD_INR` | yes | no | Use the same value as `.env.local`. Reset demo restores the FX assumption to this. |
| `DEFAULT_GST_PCT` | yes | no | Same. |
| `DEMO_ADMIN_TOKEN` | optional | yes | Lets your script call Reset demo without the per IP limit. Without it, a script is limited like anyone else. Generate a long random string. |
| `IP_HASH_SALT` | optional | yes | Salt for the IP hash. Defaults to a value derived from the service role key. |
| `SESSION_BUDGET_INR` | optional | no | Lowers the hard session cap. Do not copy the value from `.env.local`: that is a Phase 5 development budget. Leave unset in production. |
| `QD_BUDGET_SESSION` | optional | no | Pins the budget guard to one fixed session id. Leave unset in production, where the guard uses one session per Indian calendar day. |

`VERCEL` is set by Vercel itself. Do not add it.

## 3. How the caps work in production

- **Daily cap.** Every live model call is refused if today's spend (summed from `usage_log`, Indian calendar day, all routes together) plus the call's worst case would pass `DAILY_SPEND_CAP_INR`. The analyst route and the extraction route also refuse at the door, before any work, when less than one analyst turn (Rs 12) is left.
- **Session budget guard.** The extraction and analyst guard from earlier phases is unchanged and still sums `usage_log`. On Vercel its session id is derived from the Indian date, so every function instance shares it and no file is involved. It has a hard ceiling of Rs 300 per day that the environment can lower but never raise. **Your effective daily ceiling is therefore the lower of `DAILY_SPEND_CAP_INR` and Rs 300.**
- **Per IP limit.** Each request to a model route is recorded in `request_log` against a salted hash of the address (never the address), and refused above `PER_IP_HOURLY_CALLS` per hour.
- **When a cap is reached.** The footer says so, the analyst shows the real saved runs from development under the label "Showing stored results from an earlier live run", and a re run of extraction is refused without touching the stored results. Everything else keeps working.

## 4. Database and storage

The deployed app uses the same Supabase project you already migrated and seeded. Before the first visit it must have:

1. Migrations 0001 to 0010 applied: `npm run db:migrate`.
2. The seed loaded: `npm run seed:db` (RFx, vendors, the files in the private `documents` bucket).
3. The stored extraction results and analyst runs from development. They are rows in the database, so a new Supabase project would not have them and the cap fallback would have nothing to show. Use the existing project.

## 5. After the first deploy: checks

Replace `<app>` with your production URL.

```bash
curl -s https://<app>/api/health          # ok true. Touches nothing else: if this fails the function itself does not load
curl -s https://<app>/api/ready           # 200 and layers all ok. On 503, "failed" names the layer (config, prompts, database, readonly_database); missing_settings lists names only
curl -s https://<app>/api/usage           # calls today, cost today, capped false
curl -s -o /dev/null -w "%{http_code}\n" https://<app>/eval    # 200 (the SPA fallback)
```

Open the app in a private window, then the Comparison page, the Evaluation page (refresh it), and the footer (usage meter and Reset demo).

## 6. Reset demo from a script

Reset demo clears corrections, assumption changes and chat sessions, and keeps extraction results and the saved analyst runs. It makes no model call.

```bash
# Directly against the database, no HTTP and no limit (uses .env.local):
npm run demo:reset

# Against the deployed app (needs DEMO_ADMIN_TOKEN set on Vercel):
curl -s -X POST https://<app>/api/reset-demo -H "x-admin-token: $DEMO_ADMIN_TOKEN"
```

Without the token, the button and the endpoint allow 3 resets per hour per address and 20 per hour overall.

## 7. Before every push

```bash
npm run check:function    # Node 22. Builds, loads .build/handler.mjs in plain Node, calls health, ready, usage, compare
```

It reads `.env.local`, never prints a value, forces both spend caps to 0 for the child process, and makes no model call. Any route that does not return 200 fails the check and names the failing layer.

## 8. Rehearse the production build on your machine

```bash
npm run build
npm run check:bundle                                   # PASS or FAIL per check, no values printed
DAILY_SPEND_CAP_INR=0 PER_IP_HOURLY_CALLS=0 npm run serve:prod   # http://localhost:4173, caps at 0
```

`serve:prod` serves `dist` with the same SPA fallback as `vercel.json` and runs the same built single API function (`.build/handler.mjs`). It is not Vercel itself, so the first real deploy is still the final test of the function bundling.
