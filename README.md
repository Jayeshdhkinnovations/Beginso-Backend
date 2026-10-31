# Beginso Backend

**Status: Beginso V2.0.0 complete, 31 Oct 2026** (declared by the owner). The `version` field in `package.json` is `1.0.0` and is set to the release number in a separate step. Status, open items and verification: `Beginso-Report/PROJECT_STATUS.md`.

*Last updated 31 Oct 2026, checked against `main` `77969ed`: type-check, lint and build clean; 115 test suites and 1,403 tests pass; the printed Express route table has 265 routes; `GET /api/health` answers 200.*

The REST API of Beginso, a multi-tenant form platform. It is the only data authority: the frontend (`Beginso`) and the Super Admin console (`Beginso-Admin`) both call it. Node 20, Express 5, MongoDB with Mongoose 9, Firebase Admin (identity), Zod 4, Jest.

## Run it

```bash
npm install
cp .env.example .env      # then fill in your own values; never commit .env
npm run dev               # nodemon + ts-node, default port 5000
```

| Command | What it does |
|---|---|
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` |
| `npm test` | Jest (about 6 minutes; the suites share one in-memory MongoDB) |
| `npm run build` / `npm start` | compile to `dist/` and run it |
| `npm run bruno` | the Bruno API regression collection in `bruno/` |
| `npm run migrate:*`, `backfill:*`, `reconcile:storage`, `audit:uploads` | data scripts meant for production use (run the dry run first where the script has one) |
| `npm run seed:*` | development seed scripts; they refuse to run when `NODE_ENV=production` (`seed:superadmin` needs `ALLOW_SUPERADMIN_BOOTSTRAP=yes` for that one run) |

## Deploy

The backend ships as a Docker image (`Dockerfile`, `docker-compose.yml` for development, `docker-compose.prod.yml` for the server). Workflows in `.github/workflows/`: `ci.yml` (type-check, lint, tests, build, and a Docker job), `publish-image.yml`, `deploy-docker.yml` (runs only when the repository variable `DOCKER_DEPLOY_ENABLED` is `true`) and `security.yml`. The switch from pm2 to the container is `scripts/cutover.sh`; rollback is `scripts/deploy-docker.sh rollback`. The step-by-step runbook is in the documentation repository.

## Documentation

All documentation lives in the **Beginso-Report** repository, not here:

| What | Where |
|---|---|
| Status, open items, risks | `PROJECT_STATUS.md` |
| The shared API contract | `API_CONTRACT.md` |
| What changed for the frontend | `backend_updates_for_frontend.md` |
| The backend in short points | `Beginso-Backend-Report/BACKEND.md` |
| Docker and cutover runbook, launch runbook, clean-up and endpoint reports | `Beginso-Backend-Report/docs/` |
| Every route, model and permission (generated from code) | `handbook/reference/` |

No markdown files are kept in this repository's `docs/` folder.
