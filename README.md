# wAI Pending Resolver

Demo stack for **Bolna-driven automated invoice dispute resolution**.

- `backend/` — Express + Mongoose + node-cron (deploy to Railway via `Production-Backend` workflow)
- `views/` — single `index.html` ops console (deploy to GitHub Pages via `Production-Client` workflow)
- `.github/workflows/` — manual-trigger pipelines (Actions tab → "Run workflow")
- `.vscode/launch.json` — local-debug env vars (replace `REPLACE_ME_*` values)

---

## 1. Local run

```bash
cd backend
npm install
```

Open the **repo root** in VSCode and press **F5** (uses `.vscode/launch.json`).
Or plain CLI:

```bash
PORT=3000 MONGO_URI='mongodb+srv://...' node server.js
```

You should see:

```
[MONGO] Connected.
[SEED] Inserted demo invoice INV-2026-89A.
[CRON] Scheduled "* * * * *" — outstanding-dispute sweeper active.
[HTTP] Listening on :3000
[CRON ACTIVE] Outstanding Pending Detected for Sharma Logistics (ID: INV-2026-89A)...
```

### Quick API checks

```bash
curl http://localhost:3000/api/invoice-state

curl -X POST http://localhost:3000/api/trigger-call

curl -X POST http://localhost:3000/api/bolna-webhook \
  -H 'content-type: application/json' \
  -d '{"extracted_parameters":{"dispute_reason":"duplicate billing","utr_number":"UTR1234"}}'
```

---

## 2. Deploy backend to Railway (workflow)

One-time Railway setup:
1. Create a Railway project, add a service from this repo, **Settings → Root Directory** = `backend`.
2. Set **Variables** in Railway (mirror `backend/.env.example`): `MONGO_URI`, `BOLNA_API_KEY`, `BOLNA_AGENT_ID`. `PORT` is auto-injected.
3. Railway → Project → **Tokens** → create a **Project Token**.
4. GitHub repo → **Settings → Secrets and variables → Actions** → add secret `RAILWAY_TOKEN` with that token.

To deploy:
- GitHub → **Actions** tab → **Production-Backend** → **Run workflow**.

The workflow runs `railway up --detach` from `./backend/` using the project token.

---

## 3. Deploy frontend to GitHub Pages (workflow)

One-time Pages setup:
1. In `views/index.html`, set the constant at the top of the script:
   ```js
   const BACKEND_API_BASE_URL = "https://<your-app>.up.railway.app";
   ```
2. GitHub repo → **Settings → Pages** → Build & deployment source = **GitHub Actions**.
3. Push to `main`.

To deploy:
- GitHub → **Actions** tab → **Production-Client** → **Run workflow**.

The workflow uploads `./views/` as the Pages artifact and deploys it. No secrets required.

---

## 4. Bolna wiring (when ready)

You're on the Bolna trial ($5 balance, calls limited to verified numbers).

**APIs you need (only two):**
- **`POST /v2/agent/{agent_id}/call`** — "Make phone call". Call this from inside `runTriggerCall()` in `server.js` to actually dial out. Currently the function logs & returns; the TODO block at that location shows the exact request shape.
- Your agent's **completion webhook** — configure it in the Bolna dashboard (Agent → Tools / Analytics tab) to POST to:
  `https://<your-railway-url>/api/bolna-webhook`
  The server already handles both `extracted_parameters.dispute_reason` / `utr_number` and top-level variants.

**Audio settings note:** you don't need to change anything in `Audio` for this demo to work — defaults (Deepgram nova-3 STT, ElevenLabs TTS) are fine. The variables your agent's prompt *extracts* (`dispute_reason`, `utr_number`) are what gets posted back to the webhook; make sure those parameter names match what you've defined in the Bolna agent's extraction config.

---

## File map

```
wai-dispute-resolver/
├── .github/workflows/
│   ├── production-client.yml   manual-trigger → uploads views/ → GitHub Pages
│   └── production-backend.yml  manual-trigger → `railway up` from ./backend/
├── .vscode/launch.json         F5 in VSCode runs the backend with env vars
├── backend/
│   ├── server.js               Express + Mongoose + cron, single file
│   ├── package.json
│   ├── .env.example            mirror these into Railway → Variables
│   └── .gitignore
├── views/
│   └── index.html              self-contained; edit BACKEND_API_BASE_URL at top of <script>
├── .gitignore
└── README.md
```
