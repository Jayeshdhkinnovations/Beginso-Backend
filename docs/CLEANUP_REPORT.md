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
