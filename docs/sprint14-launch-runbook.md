# Sprint 14 launch runbook (steps for a human)

Everything here is a command or check that needs production, a prod clone or a person. Nothing in this file has been run against real data. Commands are from `package.json`, `src/scripts/` and `bruno/`.

## 1. Migration rehearsal #2 (fresh prod clone)

The Sprint 14 data change is additive: `migrateSprint14` only builds 3 indexes (Notification, MailLog `dedupeKey`, SavedChart) and rewrites no document.

1. Restore a FRESH copy of production into a separate database (never the live one).
2. `set MONGODB_URI=<clone uri>` (PowerShell: `$env:MONGODB_URI="<clone uri>"`).
3. Dry run (reports counts, builds nothing): `npm run migrate:sprint14 -- --dry-run`
4. Run: `npm run migrate:sprint14` (idempotent; run it twice and confirm the second run is a no-op).
5. Rollback (drops only the indexes this script created; data untouched): `npm run migrate:sprint14 -- --rollback`
6. Run step 4 again after the rollback. Record the before/after counts printed. Exercise the rollback BEFORE doing the real deploy.
7. Start the new build against the clone and confirm null-safety: old forms (no `templateId`), old notifications (no `workspaceId`), and `GET /api/analytics/*` all return 200.

## 2. Query timing and search p95

Script: `src/scripts/timeSearchAndAnalytics.ts` (seeds workspaces, forms and responses, then times `GET /api/search` and the analytics endpoints; prints p50/p95/max).

- Safe default (in-memory MongoDB): `npm run time:sprint14`
- Bigger local volume: `$env:WORKSPACES=20; $env:FORMS=10; $env:RESPONSES=500; $env:RUNS=60; npm run time:sprint14`
- Your own LOCAL or CLONE database (it WRITES seed data; refuses URIs that do not look local/test/staging/clone): `$env:TIMING_MONGODB_URI="mongodb://localhost:27017/beginso-clone-test"; npm run time:sprint14`
- Search is rate limited per user (`SEARCH_RATE_LIMIT_MAX`, default 120/min; 0 disables). Raise `RUNS` only with `SEARCH_RATE_LIMIT_MAX=0`.
- Pass bar from tasks.md: no query above 100 ms and search p95 within the OQ-5 figure (300 ms). A 10-sample in-memory smoke run printed p95 20-120 ms (first-call warmup); that is NOT the measurement, the real run on volume is still to do.
- Also run `seed:v2a-volume` (existing, 100k responses) on a local DB if you want the older volume shape.

## 3. Environment variables to verify in Render

Required / security-relevant (names read from `src/`):

| Var | Why |
|---|---|
| `NODE_ENV=production` | server refuses to start without `MONGODB_URI`; dev CORS origins dropped |
| `MONGODB_URI`, `JWT_SECRET` | `JWT_SECRET` is also the IP/email hash key unless `AUTH_EMAIL_HASH_PEPPER` is set: set a dedicated `AUTH_EMAIL_HASH_PEPPER` and never rotate it casually (hashes in Event/Session change) |
| `APP_URL` | links in emails (default `https://beginso.com`) |
| `API_PUBLIC_URL` | host for the notification unsubscribe link; no trailing slash, no `/api`. Default `<APP_URL>/api/backend` (the BFF), so only set it if the API has its own public host |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | mail; `SMTP_TLS_REJECT_UNAUTHORIZED` must NOT be `false` in production. Send one real test mail (`src/scripts/sendTestAllEmails.ts`, uses real SMTP: run deliberately) and check a `MailLog` row |
| `TRUST_PROXY_HOPS` | number of proxies in front (default 1); wrong value = wrong IPs in rate limits/hashes |
| `PROXY_SHARED_SECRET` | must equal the frontend BFF's secret or `x-client-ip` is ignored |
| `CORS_ORIGINS` | extra origins only |
| `SUPER_ADMIN_EMAILS` | admin console access |
| `UPLOAD_DIR` | must be a persistent disk (see section 5) |
| `RATE_LIMIT_ALLOWLIST` | leave empty in production unless needed |

Cookie flags: `auth.controller.ts` sets the `token` cookie with `httpOnly: true, secure: true, sameSite: "lax"` unconditionally (30 days). To verify on the deployed service: log in via the real HTTPS host and check the `Set-Cookie` header (`curl -si` the session endpoint or browser devtools) shows `HttpOnly; Secure; SameSite=Lax`. `secure: true` means plain-HTTP local tests will not keep the cookie. Also confirm no secrets or raw IPs appear in Render logs (errors now log `ipHash`, not `ip`).

## 4. Health check

`curl https://<api-host>/api/health` returns `success: true` plus `commit`, `commitMessage`, `deployedAt` (from `dist/version.json`, written by the deploy workflow). After deploy, `commit` must equal the commit you intended; `null` means the version file was not written.

## 5. R2 lifecycle rule (suggestion)

Caveat: this repo stores uploads and report files on local disk (`UPLOAD_DIR`, default `./uploads`); `upload.controller.ts` notes R2/S3 as a future move. If an R2 bucket really is in use outside this repo, suggested rules: (a) abort incomplete multipart uploads after 7 days, (b) expire `reports/` objects after 30 days (reports are regenerable; confirm the app's own report TTL first), (c) leave form-response attachments with no expiry. If storage is the Render disk, ensure it is a persistent disk and plan the R2 migration separately.

## 6. Bruno regression

Needs a running backend and a database (local or staging, not production data you care about).
1. Fill the `REPLACE_WITH_*` vars in `bruno/environments/Development.bru` (tokens, form/workspace ids; `base_url` defaults to `http://localhost:5000`).
2. `npm run dev` in one terminal, then `npm run bruno` (= `bru run bruno --env Development`) in another.
3. All requests green, including the `Failure - *` negative cases. Record the pass count.

## 7. Tag v2.0.0 (human, after all of the above is green)

1. Confirm `npm run type-check`, `npm run lint`, `npm run build`, `npm test` are clean on the release commit and the frontend release commit is ready.
2. Deploy to Render; check `/api/health` shows the commit.
3. `git tag -a v2.0.0 -m "Beginso V2.0.0" <commit>` then `git push origin v2.0.0` (do the same in the frontend and admin repos if they are tagged together).
4. Watch Render error rate / logs for 24 h; keep the migration rollback command from section 1 and the previous deploy ready.
