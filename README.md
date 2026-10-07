# QuoteDesk

Turns five messy vendor replies (Excel, PDF, Word, a phone photo, an email) into one normalized, evidence backed comparison, then lets a buyer interrogate it in plain language all the way to an award. The model reads documents; deterministic code does every calculation.

Status: phase 1 of 8 (scaffold and dataset). See `REQUIREMENTS.md`, `DECISIONS.md`, `LEFT_OUT.md`.

## Setup
Node 22, Python 3.

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install -r seed/requirements.txt
cp .env.example .env.local   # fill in values
npm run seed:gen             # generate the dataset into seed/out
npm run db:migrate           # apply migrations, create the read only role
npm run seed:db              # load the saved RFx and upload files to Storage
npm run dev                  # app and /api on http://localhost:5173
```

Checks: `npm run typecheck`, `npm test`.
