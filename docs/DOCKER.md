# Running the backend in Docker

The backend can be built as one image and run the same way on any server. A deploy is "start this tag", and a rollback is "start the previous tag". **Nothing here changes the live server until the owner follows the steps below.** The existing `deploy.yml` (pm2) keeps working untouched.

Who does what: steps marked **[repo owner]** need the owner of the backend repository (the main owner is only a collaborator there). Steps marked **[server]** need someone who can log in to the server. Steps marked **[either]** can be done by whoever has the access.

## 1. What the image is

| | |
|---|---|
| Base | `node:20-bookworm-slim` (the major version in `.nvmrc` and CI; `-slim`, not alpine, so the image matches the platform the dependencies are tested on; there is no browser or native module) |
| User | `node` (uid 1000), never root. `tini` is PID 1, so `docker stop` is a graceful stop |
| Code | `/app`, owned by root, read-only to the app |
| Data | `/data` is a **volume**; the working directory is `/data`, and the app writes only there: `/data/uploads` (uploaded files, `response.json`), `/data/uploads/reports` (report PDFs and CSVs), `/data/uploads/exports` (workspace exports) |
| Port | 5000 inside the container (`PORT`) |
| Health | `GET /api/health` answers 200 `{ "commit": "<7 characters>" }`; `GET /` answers the same commit (the deploy check greps it; the admin Releases page reads it) |
| Version | the build writes `dist/version.json` from `GIT_SHA` and `BUILD_TIME`, the same file and field names the pm2 deploy writes, and `dist/audit.json` (the dependency-audit count System Health shows) |
| Logs | stdout only (no log files); Docker rotates them (`max-size 10m`, 5 files) |
| Time zone | `TZ=UTC` (change with the `TZ` variable) |
| Secrets | none in the image. Settings come from the env file at run time; the Firebase key is mounted read-only |

The container **refuses to start in production** when one of these is missing, and says which one by name (never its value): `JWT_SECRET`, `MONGODB_URI`, `PROXY_SHARED_SECRET`, `APP_URL`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, and the Firebase key file. This check lives in `docker/preflight.js` and runs only in the container.

## 2. Try it on a laptop (QA)

```
docker compose up --build        # API on http://localhost:5000 with its own MongoDB
curl http://localhost:5000/api/health
```

No real credential is involved (the compose file uses `NODE_ENV=development`, so the Firebase key is not needed). Stop with `docker compose down`; add `-v` to also delete the test database and uploads.

To run every proof (fresh build, non-root, no secret in the image, uploads survive, graceful stop, read-only root): `./scripts/docker-proof.sh` on a machine with Docker.

## 3. Prepare the server  **[server]**

1. **Install Docker** (Docker's own apt repository, "Install using the apt repository" in the Docker documentation for your Ubuntu version), then create a deploy user that is **not root** and let it use Docker without `sudo`:
   ```
   sudo adduser --disabled-password --gecos "" deploy
   sudo usermod -aG docker deploy
   ```
   Everyday commands are then run as `deploy`. (Membership of the `docker` group is equivalent to root on this machine: give it only to the deploy user.)
2. **Make the folders** (as `deploy`):
   ```
   sudo mkdir -p /opt/beginso-backend/data /opt/beginso-backend/secrets
   sudo chown -R deploy:deploy /opt/beginso-backend
   sudo chown -R 1000:1000 /opt/beginso-backend/data     # the `node` user inside the image is uid 1000
   chmod 700 /opt/beginso-backend/secrets
   ```
3. **The env file.** Create `/opt/beginso-backend/.env` from `.env.example` (same names, the values the live server already uses; copy them from the current `.env` of the pm2 app, do not retype). Then:
   ```
   chmod 600 /opt/beginso-backend/.env      # readable only by the deploy user
   ```
   Set `TRUST_PROXY_HOPS` to the number of proxies **in front of the container** (nginx only = 1; Cloudflare plus nginx = 2). Leave `UPLOAD_DIR` unset: the image sets `/data/uploads`.
4. **The Firebase key.** Copy `serviceAccountKey.json` (the file the pm2 app has in `dist/config/firebase/`) to `/opt/beginso-backend/secrets/serviceAccountKey.json` and `chmod 600` it. It is mounted read-only into the container and never enters the image.
5. **Tell the deploy script where things are**, in `/opt/beginso-backend/.deploy/env` (create the folder):
   ```
   UPLOADS_PATH=/opt/beginso-backend/data
   FIREBASE_KEY_PATH=/opt/beginso-backend/secrets/serviceAccountKey.json
   HOST_PORT=5001
   ```
   `HOST_PORT=5001` is a **spare port**, so the new container can run next to the current backend (which uses 5000) while you test.

## 4. Copy the existing uploads  **[server]**

The uploads today live in `/root/Onboarding-backend/uploads` (or wherever `UPLOAD_DIR` points on the live server; check the live `.env`). **Copy, never move**, and compare before trusting the copy:

```
sudo rsync -a --info=progress2 /root/Onboarding-backend/uploads/ /opt/beginso-backend/data/uploads/
sudo chown -R 1000:1000 /opt/beginso-backend/data
# compare: the numbers must be identical
sudo find /root/Onboarding-backend/uploads -type f | wc -l
sudo find /opt/beginso-backend/data/uploads -type f | wc -l
( cd /root/Onboarding-backend/uploads && sudo find . -type f -print0 | sort -z | xargs -0 sha256sum ) > /tmp/uploads-before.sha
( cd /opt/beginso-backend/data/uploads && sudo find . -type f -print0 | sort -z | xargs -0 sha256sum ) > /tmp/uploads-after.sha
diff /tmp/uploads-before.sha /tmp/uploads-after.sha && echo "copy verified"
```

**Do not delete the original** until the Docker container has been the live backend for a while and the copy has been verified. New uploads made on the old server while you test are not in the copy: run `rsync` again just before the switch (it only copies the difference).

## 5. Get the image  **[repo owner] once, then [either]**

The image comes from GitHub Container Registry, built by the workflow **Publish backend image** (manual: Actions → Publish backend image → Run workflow). Before its first run, the **repo owner** must:

1. allow the workflow to write packages: Settings → Actions → General → Workflow permissions → "Read and write permissions";
2. after the first publish, open Packages → `beginso-backend` → Package settings, link it to this repository and keep it **private**;
3. give the server a way to pull a private image: create a personal access token with only `read:packages` and run `docker login ghcr.io -u <user>` once as `deploy` (the token is stored by Docker, not in this repository).

Tags: `sha-<7 characters of the commit>` (use this one for deploys) and `main`. Never deploy `latest`.

Without a registry you can build on the server instead: `docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t beginso-backend:sha-$(git rev-parse --short=7 HEAD) .` and deploy that tag.

## 6. Start it next to the current backend and test  **[server]**

```
cd /opt/beginso-backend
# copy docker-compose.prod.yml and scripts/ here from the repository (the deploy workflow does this for you)
./scripts/deploy-docker.sh deploy ghcr.io/<owner>/beginso-backend:sha-abc1234
curl http://127.0.0.1:5001/api/health         # {"success":true,...,"commit":"abc1234"}
./scripts/deploy-docker.sh status
docker logs --tail 100 beginso-backend
```

The container listens only on `127.0.0.1:5001`; the old backend on 5000 is untouched. Test through a temporary proxy rule or by pointing a test copy of the frontend at it. The script puts the previous tag back by itself if the health check or the commit check fails.

## 7. Switch the proxy  **[server]**

1. Run the uploads `rsync` once more (step 4).
2. In the proxy (nginx or Caddy), change the upstream from port 5000 to 5001 and reload it. `TRUST_PROXY_HOPS` must match the proxy chain (step 3).
3. Stop the old process: `pm2 stop onboarding-backend` (do not `pm2 delete` for the first weeks; it is the way back).
4. Check: sign in, open a form, submit a test response with a file, open the file, export a PDF.

Rollback to pm2: point the proxy back to 5000 and `pm2 start onboarding-backend`. Rollback between Docker tags: `./scripts/deploy-docker.sh rollback`.

When you want the container on port 5000 itself: stop pm2 first, then set `HOST_PORT=5000` in `.deploy/env` and deploy again.

## 8. Day to day

| Task | Command |
|---|---|
| Logs (live) | `docker logs -f --tail 200 beginso-backend` |
| Is it healthy? | `docker ps` (the Status column says `healthy`), or `curl http://127.0.0.1:5001/api/health` |
| Update | publish a new image, then `./scripts/deploy-docker.sh deploy ghcr.io/<owner>/beginso-backend:sha-<new>` |
| Roll back | `./scripts/deploy-docker.sh rollback` (starts the previous tag, checks health and the commit) |
| What is running | `./scripts/deploy-docker.sh status` |
| Back up the uploads | `tar -czf uploads-$(date +%F).tar.gz -C /opt/beginso-backend/data uploads` (or rsync the folder to another machine); a database backup is separate (MongoDB Atlas) |
| Change a setting | edit `/opt/beginso-backend/.env`, then redeploy the same tag (`deploy` with the current tag restarts it) |

A deploy is a **few seconds** of refused connections: one container behind one proxy means the old container stops before the new one starts. Zero downtime (two containers behind the proxy, switched one at a time) is **not recommended** yet: the server runs timers (close expired forms, purge Trash every 5 minutes, a daily storage reconcile, the report queue) and only the Trash purge is documented as safe to run on several instances. Use stop-then-start.

## 9. If the health check fails

1. `docker logs --tail 200 beginso-backend`. The first lines say what the container refused: a **missing setting is named** (`JWT_SECRET is missing (...)`), the Firebase key is named, a database that cannot be reached shows "MongoDB connection attempt N failed" (it retries 10 times, 5 seconds apart).
2. The deploy script has already started the previous tag again. Confirm with `./scripts/deploy-docker.sh status`.
3. Missing setting: add it to `.env`, redeploy. Database: check the Atlas IP allow-list includes this server. Permission error writing `/data`: `sudo chown -R 1000:1000 /opt/beginso-backend/data`.
4. Still stuck: `./scripts/deploy-docker.sh rollback`, or point the proxy back to pm2 (step 7).

## 10. Decisions and limits

- **MongoDB stays on Atlas** (`MONGODB_URI`). It is not containerised for production; the dev compose file has its own MongoDB for local work only.
- **Uploads stay on local disk** (a volume). Moving them to object storage is a separate, later plan.
- **Memory and CPU limits** (`1536m`, 1.5 CPUs) come from reading the code, not from measuring: reports and PDFs are generated inside the API process. Watch `docker stats` for the first week and adjust `mem_limit` in `docker-compose.prod.yml`.
- **Client IP:** the app trusts `TRUST_PROXY_HOPS` proxies (default 1) and, separately, an `x-client-ip` header only when `x-proxy-secret` equals `PROXY_SHARED_SECRET` (the frontend's own proxy). If the container's port were reachable from the internet with the default of 1, a caller could forge their address with `X-Forwarded-For` and sidestep the rate limits. That is why the compose file publishes the port on `127.0.0.1` only.
- **Shutdown:** SIGTERM stops new connections, lets requests in flight finish for up to 25 seconds, closes the database connection and exits 0 (Docker waits 30 seconds before it kills).
- **Not verified here:** the image was written on a machine without Docker. The build, the container checks in `scripts/docker-proof.sh` and the CI job `docker` have to run before the first real deploy. The base image is pinned by tag; pin it by digest after the first build.
