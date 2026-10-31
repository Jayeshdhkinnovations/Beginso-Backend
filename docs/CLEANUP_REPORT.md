# Cleanup report: backend (Step 0, inventory only)

Branch `chore/cleanup-backend`, from `main` (6f6f9e5). **No source file was changed.** Nothing below is deleted until the owner approves the list.
Date of the inventory: 31 Oct 2026.

## 0. How the evidence was gathered, and what was not done

| Check (section 2 of the task) | Done in Step 0 | Note |
|---|---|---|
| 1 Static search (`git grep`) | yes | |
| 2 Tool report | **partly** | `knip` could not be installed: the npm registry was unreachable from the build machine (`ETIMEDOUT`). Replaced by an import-graph script (entries: `src/server.ts`, `src/app.ts`, root files; tests counted separately). Output is a list of suspects, not proof. Re-run with `knip` and `depcheck` once the network is back. |
| 3 Entry points tools miss (`package.json` scripts, workflows, Dockerfile, compose, `docs/`) | yes | `src/scripts/*` are entry points started by `ts-node`, so the graph flags all of them; each was checked against `package.json` and `docs/` by hand. |
| 4 Framework conventions (models by side effect, routes mounted dynamically) | yes | `app.ts` mounts routers by explicit import; no directory scan was found. |
| 5 Behaviour check (remove, run the gate) | **no, Step 1** | |
| 6 History | yes | |
| 7 Runtime check (print the Express route table before and after) | **no, Step 1** | |

Not checked: `depcheck` for dependencies (no network), `madge` for import cycles (not installed), whether the Admin repo's `Beginso-Admin/src` calls every endpoint (it was searched by text only, see section 5), the `bruno/` collection contents.

## 1. Ask the owner (decide these first)

| # | Path | Why it needs the owner |
|---|---|---|
| 1 | `src/types/index.ts`, `src/types/template.ts` | No import anywhere in `src`, tests or docs. **Touched 29 Oct** (two days ago). Dead, or a half-finished change? |
| 2 | `scratch/` (4 files: `removeOwnerSelfGrants.ts`, `soak_test.ps1`, `soak_test_results.json`, `test_mail_server.ts`) | A tracked "scratch" folder. `removeOwnerSelfGrants.ts` is named in `docs/qa-backend-fixes-2026-10.md` (keep until the owner confirms the clean-up ran). The soak test and its results are from 24 Jul; the mail server test from 7 Aug. |
| 3 | `run_bruno_runner.ts` (root) | No reference anywhere; the `bruno` script uses the `bru` CLI, not this file. Last touched 13 Jul. Likely dead. |
| 4 | One-off scripts with **no** caller in `package.json`, `docs/`, workflows (section 4): `generateSeeds`, `importKalaChashmaCsv`, `seedKalaChasmaTemplate`, `seedKingsData`, `seedProjectPitch`, `sendTemplatePreview`, `testPdfReport`, `backfillResponseReference`, `backfillReferenceFormat` | A script that already ran its job is dead, but only the owner knows whether it will be needed again. `backfillReferenceFormat` was touched 26 Oct and `importKalaChashmaCsv` 19 Oct, so they are recent. |
| 5 | `bruno/` (122 request files) | The API collection behind `npm run bruno`. Not dead, but it needs a check that it still matches the live API; not part of this task. |
| 6 | **Seed and one-off scripts with no production guard** (section 4) | Adding `refuseInProduction` is a behaviour change; the task says add it only with approval. |

## 2. Files and folders

| Path | What it is | Verdict | Evidence | Last commit |
|---|---|---|---|---|
| `src/types/index.ts`, `template.ts` | types | ask the owner (item 1) | 1: zero imports | 2026-10-29 |
| `run_bruno_runner.ts` | bruno helper | ask the owner (item 3) | 1, 3: zero references | 2026-07-13 |
| `scratch/*` | scratch folder | ask the owner (item 2) | | 2026-07 to 10 |
| `src/data/kalaChasmaTemplate.ts` | seed data | keep for now | used by `seedKalaChasmaTemplate`, `seedTemplates`, `importKalaChashmaCsv` | 2026-10-19 |
| `src/utils/fieldShowcaseTemplate.ts` | showcase template | **keep** | used by `seedFieldShowcase`, `seedTemplates` and `field_showcase.test.ts` | |
| `scripts/*.sh`, `docker/preflight.js`, `Dockerfile`, compose files, `copyAssets.js`, `.gitleaks.toml` | build, deploy, CI helpers | **keep** | referenced by workflows, `package.json` (`build`), Docker | |
| `bruno/*.bru` | API requests | keep (item 5) | `npm run bruno` | |
| `.env.example`, `.env.docker.example` | templates | **keep** | referenced by `docs/DOCKER.md` and the README | |

No `*.bak`, `*.old`, `*.orig`, copies, screenshots, traces, logs, dumps or generated output (`dist`, `coverage`, `node_modules`) are tracked. The only tracked file over 200 KB is `package-lock.json` (490 KB). `.gitignore` needs no additions.

## 3. Models, controllers, services, routes, middleware, utils

The import graph found **no unreachable model, controller, service, route, middleware or util** (every file under `src/` outside `scripts/` and the two type files is imported from `server.ts`/`app.ts` or from another live file). The only utility reachable from tests only is covered in section 2 (it is used by a seed script).

## 4. Seed and one-off scripts (`src/scripts`, 33 files)

"Writes" means the file connects to MongoDB and calls a write method; it does **not** mean it was run. `_guard.ts` exports `refuseInProduction`, which stops a destructive script when `NODE_ENV=production`.

| Script | In `package.json` / docs | Writes to the database | Production guard | Last commit | Verdict |
|---|---|---|---|---|---|
| `migrateV1ToMemberships`, `migrateUserTheme`, `migrateStagesFromStatus`, `migrateAccessMode`, `migrateInsightsIndexes`, `migrateInvitationIndexes`, `migrateChartsV2` | yes (`migrate:*`) | yes | none, **on purpose** (they must run in production) | 09-28 to 10-17 | keep |
| `reconcileStorage`, `auditUploads`, `backfillReadState`, `backfillResponseSearchText`, `backfillDuplicateDetection` | yes | yes (audit only reads) | none, on purpose | 09-28 to 10-16 | keep |
| `timeSearchAndAnalytics` | `package.json`, runbook | creates test data | **none** | 10-13 | keep, report |
| `seedTemplates`, `seedPitchTemplate`, `seedResponseGeo` | yes | yes | **guarded** | 10-12 to 10-19 | keep |
| `seedFieldShowcase`, `seedFullForm`, `seedSuperAdmin`, `seedTestUsers`, `seedUserResponses`, `seedV2aVolume` | yes (`seed:*`) | yes | **none** | 07-22 to 10-13 | keep; guard is item 6 |
| `seedKalaChasmaTemplate`, `seedKingsData` | no | yes | guarded | 10-13 to 10-19 | ask the owner (item 4) |
| `seedProjectPitch`, `importKalaChashmaCsv`, `testPdfReport` | no | yes | **none** | 07-29 to 10-19 | ask the owner (items 4, 6) |
| `backfillResponseReference`, `backfillReferenceFormat` | no | yes | none | 09-29, 10-26 | ask the owner (item 4) |
| `generateSeeds`, `sendTemplatePreview` | no | no (read, or send mail) | none | 07-29, 10-07 | ask the owner (item 4) |
| `sendTestAllEmails` | runbook only | sends mail | none | 09-11 | keep (documented) |
| `_guard.ts` | imported by 5 scripts | no | the guard itself | 10-13 | **keep** |

Scripts that write without a guard and are **not** meant for production: `seedFieldShowcase`, `seedFullForm`, `seedSuperAdmin`, `seedTestUsers`, `seedUserResponses`, `seedV2aVolume`, `seedProjectPitch`, `testPdfReport`, `importKalaChashmaCsv`, `timeSearchAndAnalytics`. If the owner approves, the one-line guard is added in a separate commit.

## 5. Endpoints with no known caller (report only, never deleted in this task)

193 routes were read from the route files and the mounts in `src/app.ts`; each was searched by its last static path segments in `Beginso/src` (frontend), `Beginso-Admin/src`, the backend `docs/` and `bruno/`. The match is by text, so a route built from a variable can be missed.

| Route | Finding |
|---|---|
| `POST /api/auth/notify-password-changed` | no caller found. Possibly called by an email or the Firebase flow. |
| `PUT /api/users/profile`, `DELETE /api/users/profile` | no caller found (the frontend uses `/api/me`). Possibly the old profile API. |
| `GET /api/forms/:formId/score-comparison` | no caller found. |
| `GET` and `POST /api/public/notifications/unsubscribe/:token` | no caller found in code. The link is in emails, so it is **used by external callers**: keep. |
| `POST /api/superadmin/storage/reconcile` | no caller found; the `reconcile:storage` script does the same. Keep, it is an operator endpoint. |
| `GET /api/forms/:formId/submissions`, `POST /api/forms/:formId/submissions` | only in `bruno/` and docs; no code caller. |
| Called by the **Admin** only (so they must stay) | `superadmin/abuse`, `logs`, `mail-logs`, `admins` (list, get, create, update, delete), `storage/over-quota`, `GET /api/health` |

## 6. Dependencies

Not yet checked: `depcheck` and `knip` need the network. Step 2 starts with them. The tool list is therefore empty in this report, and no package is proposed for removal yet.

## 7. Dead code inside live files (Step 3)

* 170 exported names appear nowhere else in the repo. Most are interface or type exports of models (`IAuthOtp`, `IEvent`, `IMembership`, `IBranding`, …) and options types. Non-type examples: `deleteFileAndEmptyParents` (`upload.controller.ts`), `createRateLimiter` (`rateLimiter.ts`), `divider` (`mail/layout.ts`), `EXTRA_FIELD_TYPES` (`models/Form.ts`).
* An exported name used only inside its own file is not dead; only the `export` keyword is unnecessary.
* Not yet inventoried: `console.log` debug code, commented-out blocks, TODO/FIXME list, duplicate helpers.

## 8. Secret scan (names only)

* Tracked env files: `.env.example` and `.env.docker.example` only. History shows the same two, added once each; no real `.env`, `*.pem`, `*.key` or service-account file was ever committed.
* A pattern scan (AWS keys, private-key blocks, GitHub and Slack tokens, `sk_live_`) of every tracked file matched only `.gitleaks.toml` (the scanner's own rules).
* `gitleaks` is not installed on this machine, so old commits were not scanned for secret-shaped content. The `security` workflow runs it on every pull request and push.

## 9. Numbers before (main, 6f6f9e5)

| | Value |
|---|---|
| Tracked files | 515 |
| Lines | 79,609 |
| Size of tracked files | about 3.3 MB |
| Type-check, lint, build | clean |
| Tests | 111 suites, 1,375 tests. In a full run on a loaded machine 1 suite (`event_coverage`) timed out; it passes alone (17 of 17, 6.8 s). It is a slow-start problem, not a code defect. |
| Express route table, server start, `GET /api/health`, `dist` size, Docker build | taken at the start of Step 1 |

## 10. Open branches that touch the same files

* `chore/remove-pm2-deploy` (commit `3865060`, not merged): `.github/workflows/*`, `docs/DOCKER.md`, one test comment.
* `fix/cutover-test-diagnostics` (commit `7788e51`, local): `scripts/test-cutover.sh`.

Neither touches anything listed above for deletion.

## 11. Proposed Step 1 (after approval)

Whatever the owner approves from section 1. The only certain candidates are none yet: every file found is either live, documented, recent, or needs the owner's decision.

---

## Owner decisions and Step 1 to 3 results (31 Oct 2026)

### Decisions on section 1 and what was done

| # | Decision | Done |
|---|---|---|
| 1 | keep `src/types/index.ts`, `template.ts`; report commit and branches | Kept. Last commit to `index.ts`: `c35bda8` (29 Oct) "feat: form header text and links; remove dead types and the unused logo asset", which removed its line `export * from "./form.types"` (it is a barrel of type exports that is now almost empty, 4 lines). `template.ts` (12 lines) was last changed earlier (`a03948a`, 26 Sep, "fix"). No open local or remote branch touches either file or mentions them in a commit message. |
| 2 | keep `removeOwnerSelfGrants.ts` and the soak test; delete the mail-server test | `scratch/test_mail_server.ts` deleted (no reference anywhere). |
| 3 | delete `run_bruno_runner.ts` after confirming `npm run bruno` does not use it | Confirmed: the script is `bru run bruno --env Development` (the Bruno CLI); the runner had no reference in `package.json`, `bruno/`, workflows, Docker files or docs. Deleted. |
| 4 | delete seven scripts unless they hold real personal data | See the next table. |
| 5 | keep `bruno/` | Kept. |
| 6 | production guard on seven scripts; explicit flag for `seedSuperAdmin` | Done in commit `326f9b6` (branch `chore/script-production-guards`). |

### Item 4: personal data check

| Script | Personal data found | Action |
|---|---|---|
| `seedKalaChasmaTemplate.ts` | none | **deleted** |
| `testPdfReport.ts` | none | **deleted** |
| `generateSeeds.ts` | only `piyush@example.com` (an example domain) | **kept**: its output `seeds.json` is read by `seedProjectPitch.ts` (kept), and `.gitleaks.toml`, which the CI security scan reads, names this file |
| `importKalaChashmaCsv.ts` | real-looking address `kalachashmaent@gmail.com`; imports a client's CSV | **kept, not deleted** |
| `seedKingsData.ts` | `kingsssss027@gmail.com` (and a generated list of respondent names) | **kept, not deleted** |
| `seedProjectPitch.ts` | `deepaknangalia@gmail.com`, `piyush270205@gmail.com` | **kept, not deleted** |
| `sendTemplatePreview.ts` | `piyush270205@gmail.com` as the default recipient (and example addresses) | **kept, not deleted** |

Also noted: `seedTestUsers.ts` (kept) holds `piyushthedev27@gmail.com` and `kingsssss027@gmail.com`; `importKalaChashmaCsv.ts` imports `csv-parse`, which is **not** in `package.json` (depcheck "missing"), so that script cannot run on a fresh install. `src/data/kalaChasmaTemplate.ts` has no personal data; it stays (used by `seedTemplates`). These addresses are in git history already; this report does not recommend rewriting history.

### Item 6: guards

`seedFieldShowcase`, `seedFullForm`, `seedTestUsers`, `seedUserResponses`, `seedV2aVolume` and `timeSearchAndAnalytics` import `./_refuseProduction` **first**; it exits 1 with `Refusing to run <script>: NODE_ENV is "production"...` before anything else loads or connects. `ALLOW_DESTRUCTIVE_SEED=yes` overrides, as for the already guarded seeders. `seedSuperAdmin` is the only way to create the first super admin, so it is **not** blocked: in production it needs `ALLOW_SUPERADMIN_BOOTSTRAP=yes` for that run (`_bootstrapGuard.ts`), documented in `docs/insights-launch-runbook.md` ("First super admin"). Ten tests in `src/__tests__/script_production_guards.test.ts`: one per script, two for the flag, two for the helpers. The guard reads `NODE_ENV` from the real environment, before `dotenv` runs, like the existing guarded seeders.

### Step 1 (branch `chore/cleanup-backend-step1`, commit `af1a388`)

Deleted `scratch/test_mail_server.ts`, `run_bruno_runner.ts`, `src/scripts/seedKalaChasmaTemplate.ts`, `src/scripts/testPdfReport.ts`: 4 files, 254 lines.

| | Before | After |
|---|---|---|
| Type-check, lint | clean | clean |
| Tests | 111 suites, 1,385 tests (1,375 + the 10 new guard tests) | 112 suites, 1,385 tests; 1 failed under load (`chart_query.test.ts`) and **passes alone, 65 of 65** |
| Express route table (printed by walking the router tree) | 269 routes | **identical, 269** |
| `GET /api/health` | 200 | 200 |
| Build | succeeds | succeeds |
| `dist` | 4,121 KB, 380 files | 4,121 KB, 380 files: `tsc` does not delete stale files, so `dist` on a developer machine does not shrink; the Docker image builds from a clean tree |
| Docker build | not possible on this machine (no Docker installed) | covered by the `docker` job in `ci.yml` on push |

The test failures seen on this machine in full runs (`event_coverage` earlier, `chart_query` now) are time-outs under load; each suite passes alone.

### Step 2: dependencies (no change)

`knip` and `depcheck` both report **no unused dependency and no unused devDependency**. One copy of each kind of library (one HTTP server, one ORM, one validator, one mailer, one PDF library, no date or HTTP client library). Findings, not changed (adding or moving dependencies needs your approval):
* Used but not declared in `package.json`: `mongodb` (a test helper), `mongodb-memory-server-core` (two tests), and `csv-parse` (the held `importKalaChashmaCsv` script). They are present only through other packages.
* `@types/pdfkit` is under `dependencies`; type packages belong in `devDependencies` (it only matters for the production install size).
* `knip` flags `.github/workflows/deploy.yml` for using `pm2`; that workflow is removed on branch `chore/remove-pm2-deploy` (not merged yet).

### Step 3 (conservative rules): nothing to remove

`knip` lists 26 unused exports and 57 unused exported types. Only two names are also unused inside their own file: `kalaChasmaCsvUrlFields` and `kalaChasmaCsvLabelOverrides` in `src/data/kalaChasmaTemplate.ts`, and that file was touched on 19 Oct (inside the 30-day window). They exist for the held `importKalaChashmaCsv` script. No file that `knip` flags has been untouched since before 1 Oct. No code changed.

### Numbers

| | Step 0 | Now |
|---|---|---|
| Tracked files | 516 (515 + this report) | 515 |
| Lines | 79,609 + report | 79,604 + this section |

Endpoints: none deleted. The ten scripts that write to the database without the production guard were all guarded (list in section 4 and item 6 above).
