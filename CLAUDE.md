# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other assistants working in this repository, the Beginso backend (Node 20, Express 5, MongoDB with Mongoose 9, Firebase Admin, Zod 4, Jest).

## Branch rule: never push to `main`; all work goes to `develop` (set 2 Nov 2026)

`main` is **not touched** until the V3 work is finished; the owner then updates it in one go. Until then:

- **Never push to `main`, never open or merge a pull request into `main`, never reset or fast-forward `main`, never create a tag or a release.** Reading `origin/main` to compare is fine.
- **Start every work branch from the latest `origin/develop`** (`feat/`, `fix/`, `chore/` or `docs/`). Push the branch and say "pushed, ready to merge into develop". The pull request's base is `develop`. The owner merges; the assistant never merges, and never pushes straight to `develop` unless the owner says so.
- If an instruction, a skill, a memory or a document says "branch from main" or "merge to main", this rule wins.
- Before `git checkout -b`, `git push` and any pull-request text: check the base is `develop` and the target is not `main`.
- **Deploys:** `publish-image.yml` and `deploy-docker.yml` run from `main` (and only when the repository variable `DOCKER_DEPLOY_ENABLED` is `true`). Do not extend their triggers to `develop`, or a push to `develop` could build and deploy.
- **CI note:** `ci.yml` and `security.yml` run only for pull requests and pushes that target `main`, so a pull request into `develop` runs no checks until their triggers are extended (a separate decision). Until then, run the full gate locally (`npm run type-check`, `npm run lint`, `npm test`, `npm run build`, the route table and `GET /api/health`) and report the result.
- The same rule is written in `Beginso-Report/Git-Workflow.md` and applies to the frontend repository too.

## Commands

```bash
npm run dev          # nodemon + ts-node, port 5000
npm run type-check   # tsc --noEmit
npm run lint         # eslint src
npm test             # jest (about 6 minutes; one shared in-memory MongoDB)
npm run build        # tsc + copyAssets.js
```

A change is not done until type-check, lint, test and build are all clean. Tests ship with the change, under `src/__tests__/`.

## Documentation

All documentation lives in the **Beginso-Report** repository (`PROJECT_STATUS.md`, `API_CONTRACT.md`, `backend_updates_for_frontend.md`, `Beginso-Backend-Report/`), not in this repository. Do not add markdown files under `docs/` here.

## Safety

- Never print or store a credential, a token or the contents of `.env`.
- Seed and test-data scripts refuse to run when `NODE_ENV=production`; do not bypass that.
- No production writes and no server commands unless the owner asks for them explicitly.
- No dependency upgrades inside an unrelated task.
