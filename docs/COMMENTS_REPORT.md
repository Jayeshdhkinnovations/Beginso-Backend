# Comments report: backend (Step 0, nothing changed)

Branch `chore/comments-cleanup-backend`, from `main` at `4db019b` (every backend branch from the clean-ups is merged; only six Dependabot branches are open, and they touch `package.json` and the lockfile only, so no source file has to be left alone).
Date: 31 Oct 2026. **No source file was changed.** Nothing is removed until the owner answers section 4.

## 1. How the comments were counted

Every comment was found with the TypeScript compiler (so `//` inside a string, a URL or a regex is never counted) over the **363 tracked** `.ts`, `.js` and `.mjs` files. A comment is a `//` line, a `/* */` block or a `/** */` block; a run of `//` lines counts one comment per line. The kind is a **heuristic sort** (the same rules as the frontend scan, kept outside the repo): good for counting, not proof. Not in the numbers: YAML workflows, `Dockerfile`, `.env.example`, Markdown, JSON, shell scripts (`scripts/*.sh`), lockfiles.

## 2. Counts

| | Value |
|---|---|
| Comments | **3,844** (2,706 in app code, 1,138 in tests) |
| Comment lines | 4,185 of 61,410 lines in the scanned files (6.8%) |
| Files with at least one comment | 328 of 363 |

| Kind | All | App code | Tests | Remove? |
|---|---|---|---|---|
| explanatory (explains a reason or behaviour) | 2,855 (74.3%) | 2,020 | 835 | **keep** |
| short, possibly restating the code | 287 (7.5%) | 132 | 155 | needs your answer (group C) |
| JSDoc / TSDoc | 195 (5.1%) | 189 | 6 | **keep** |
| sprint or QA tag, nothing else | 174 (4.5%) | 147 | 27 | needs your answer (group A) |
| decoration banner (`// ====`) | 149 (3.9%) | 63 | 86 | needs your answer (group D) |
| a reason **plus** a sprint or QA tag | 85 (2.2%) | 66 | 19 | needs your answer (group A) |
| empty (`//` alone) | 54 (1.4%) | 53 | 1 | needs your answer (group E) |
| change-log wording ("used to", "no longer", "bug fix", dates) | 44 (1.1%) | 35 | 9 | needs your answer (group B) |
| commented-out code | 1 | 1 | 0 | none real (see below) |
| tool directives (`eslint-disable`, `@ts-ignore` …) | **0** | | | nothing to list |
| TODO / FIXME | **0** | | | nothing to list |
| debug notes | **0** | | | nothing to remove |

* **Commented-out code: none.** The one hit, `src/scripts/backfillDuplicateDetection.ts:13`, is the documented rollback command (`db.responses.updateMany(…$unset…)`) in a script header: keep.
* There are no `eslint-disable`, `@ts-ignore` or `@ts-expect-error` comments anywhere, so none lacks a reason.

By folder (comments): `src/__tests__` 1,138 · `src/services` 850 · `src/controllers` 564 · `src/scripts` 279 · `src/utils` 260 · `src/models` 209 · `src/middleware` 141 · `src/mail` 137 · `src/routes` 109 · `src/validations` 47 · `src/types` 25 · `src/repositories` 21 · `docker` 14 · `scratch` 13 · `src/app.ts` 11 · `src/data` 9 · `src/server.ts` 6.

Top 20 files by number of comments (comments / lines): `src/services/response.service.ts` 120/962 · `src/services/form.service.ts` 116/1140 · `src/controllers/form.controller.ts` 112/2067 · `src/__tests__/api.test.ts` 109/1194 · `src/mail/templates.ts` 103/1073 · `src/middleware/permission.middleware.ts` 80/555 · `src/__tests__/pbt.test.ts` 65/987 · `src/__tests__/builder_publish_respondent.test.ts` 62/1037 · `src/services/respondent.service.ts` 59/445 · `src/__tests__/team_and_permissions.test.ts` 56/929 · `src/__tests__/insights_search_notifications.test.ts` 51/830 · `src/services/report.service.ts` 49/671 · `src/models/Response.ts` 45/189 · `src/controllers/auth.controller.ts` 41/741 · `src/utils/chartQuery.ts` 41/622 · `src/services/storage.service.ts` 40/345 · `src/__tests__/workspace_and_membership_models.test.ts` 39/726 · `src/services/cleanup.service.ts` 38/259 · `src/services/trash.service.ts` 36/318 · `src/__tests__/chart_query.test.ts` 34/724.

## 3. The share that looks stale or unsure

Groups A to E add up to **793 comments, 20.6% of all** (A 259, B 44, C 287, D 149, E 54). That is over the 10% line, so I stop here for your answer.

## 4. Questions for the owner (the groups)

**A. Sprint and QA tags (259: 213 in app code, 46 in tests).** Examples: `src/models/ScoreCriterion.ts:3` "Workspace-defined scoring criterion (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved 3 Oct 2026)" · `src/routes/workspace.routes.ts:35` "Scoring criteria (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved 3 Oct 2026)" · test section headings such as "BE 0.2: Workspace Member Management".
*Proposal:* in app code, keep the sentence and delete only the tag; delete a comment when only the tag is left. In tests keep the headings (they name what the block proves) unless you say otherwise.

**B. Change-log wording (44: 35 in app code, 9 in tests).** Examples: `src/controllers/response.controller.ts:38` "Sprint 12 fix (30 Sep 2026): mirrors form.controller.ts's listForms `isExplicitPersonal` handling. `!workspaceId` used to mean "show nothing" here…" · `src/controllers/stage.controller.ts:20` "Real bug found in manual QA (30 Sep 2026): `Stage` has no `toJSON` virtuals config…". These explain why the code looks the way it does.
*Proposal:* remove the history words and dates, keep the reason; tests keep all.

**C. Short comments that may restate the code (287: 132 in app code, 155 in tests).** In tests most are numbered or labelled steps (`// 1. Create Workspace`, `// 2. Read Workspace`) or short notes on a value (`// 3MB exceeds 2MB`, `// Soft-deleted!`). In app code they need a line-by-line look.
*Proposal:* tests: keep (the numbered steps and the value notes help the reader). App code: remove only those whose next line says the same, and list every one before removing.

**D. Decoration banners (149: 63 in app code, 86 in tests).** Mostly `// ==========` rulers around a section title (the title is on the line between two rulers), for example `src/__tests__/api.test.ts:86`.
*Proposal:* delete the two ruler lines and keep the title line as a plain comment. Or keep all.

**E. Empty `//` lines (54, 53 in app code).** The blank line inside a multi-line `//` block (paragraph break), for example `src/controllers/auth.controller.ts:539`, `src/mail/templates.ts:79, 151`.
*Proposal:* leave them (removing one only changes how a comment block is laid out), or remove them if you want them gone.

## 5. Things found while counting (nothing changed)

* **No kept TODOs, no directive comments, no debug notes.** Nothing to list under those headings.
* **Four vague comments:** `src/controllers/form.controller.ts:355, 436, 609, 883` each say only `// For compatibility`, without saying with what. They sit beside response-shape fields; I could not tell from the comment which client needs them. Please say whether a client still depends on them (keep, with a better sentence) or not (candidate for removal in a later code change, not in this one).
* **No stale references to the removed routes:** no comment still mentions `getSubmissions`, `updateProfile`, `notify-password-changed` or the removed submissions routes, apart from the test that proves the alias is gone.
* **"Legacy" and "DEPRECATED" comments** (for example `src/models/Response.ts:9` "DEPRECATED (Sprint 12, BE 0.1): kept only so pre-Sprint-12 consumers…", `src/controllers/chart.controller.ts` "legacy Sprint 14 clients", `src/models/Invitation.ts:46` plain tokens in old invitations) describe data and clients that still exist, so they stay. Whether the clients are still alive is a question for the code, not for this clean-up.
* Stale comments that no longer match their code can only be found by reading each one; I spot-checked the wording above, not all 3,844.

## 6. Plan after your answer

One commit per folder (`src/routes`, `src/controllers`, `src/services`, `src/models`, `src/middleware`, `src/utils`, `src/mail`, `src/validations`, `src/types`, `src/repositories`, `src/scripts`, then `docker`, `scratch` and the root files), each followed by the proof script (every changed file compiled before and after with `removeComments: true` must be byte-identical; the script stays outside the repo) and the gate. Gate baseline (31 Oct 2026, main): type-check, lint, 115 test suites and 1,402 tests green (the count in the last CI run), the Express route table (265), `GET /api/health`, and the Docker build in CI. Migrations (`src/scripts/migrate*`) keep their comments, as the task says. The last commit sets the version in `package.json`: it is `1.0.0` today (the backend's own number), below 2.0.0, so it would become `2.0.0`; the places that read the version are the health route and `dist/version.json`, and I will confirm `GET /api/health` keeps the same field names.
