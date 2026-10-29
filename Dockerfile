# syntax=docker/dockerfile:1.7
#
# Beginso backend image.
#
# Base: node:20-bookworm-slim, the major version in .nvmrc and CI. -slim and not alpine: the glibc image is the one every dependency here
# is tested on (alpine's musl is a different platform for no benefit, there is no browser and no native module to keep small).
# TODO(owner): pin the base to a digest once an image has been built on a machine with Docker (`docker buildx imagetools inspect
# node:20-bookworm-slim`), then let Dependabot move the digest. The tag is pinned to the major version until then.
#
# No secret is ever copied or set in a layer: every value arrives at run time (--env-file, or the host's secret store), and the Firebase
# key is mounted read-only. Build arguments are only the commit id and the build time, which are public.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---- 1. build: compile TypeScript, record the version and the dependency audit --------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# The package files first, so a source-only change reuses the cached install.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json copyAssets.js ./
COPY src ./src
RUN npm run build

# The two files the deploy workflow writes today, in the same shape: GET / and GET /api/health read `commit` (7 characters) from
# dist/version.json, and System Health reads dist/audit.json. `npm audit` exits non-zero on findings, so its result never fails the build.
ARG GIT_SHA=unknown
ARG GIT_MESSAGE=
ARG BUILD_TIME=
ENV GIT_SHA=${GIT_SHA} GIT_MESSAGE=${GIT_MESSAGE} BUILD_TIME=${BUILD_TIME}
RUN node -e "const fs=require('fs');const e=process.env;fs.writeFileSync('dist/version.json',JSON.stringify({commit:(e.GIT_SHA||'unknown').slice(0,7),commitMessage:(e.GIT_MESSAGE||'').split('\n')[0],deployedAt:e.BUILD_TIME||new Date().toISOString()}))" \
 && (npm audit --omit=dev --json > audit-raw.json || true) \
 && node -e "const fs=require('fs');let v={};try{v=JSON.parse(fs.readFileSync('audit-raw.json','utf8')).metadata.vulnerabilities||{}}catch(e){}const n=k=>Number(v[k])||0;if(typeof v.total==='number'){fs.writeFileSync('dist/audit.json',JSON.stringify({total:n('total'),critical:n('critical'),high:n('high'),checkedAt:new Date().toISOString()}))}" \
 && rm -f audit-raw.json

# ---- 2. production dependencies only ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 3. runtime ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# The commit and build time travel with the image as labels too, so a deploy script can read them without starting it.
ARG GIT_SHA=unknown
ARG BUILD_TIME=
LABEL org.opencontainers.image.title="beginso-backend"
LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"

# tini is PID 1: it passes SIGTERM on to node and reaps children, so `docker stop` is a clean, graceful stop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5000 \
    TZ=UTC \
    UPLOAD_DIR=/data/uploads

WORKDIR /app
COPY --from=deps  --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root docker/preflight.js ./preflight.js

# Uploaded files, report PDFs and CSVs and workspace exports live under /data/uploads, on a volume. The working directory is /data, so
# the report and export folders, which the code builds from the working directory, land on the same volume (see docs/DOCKER.md).
# The code under /app belongs to root and is read-only to the app; only /data is writable.
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data"]
WORKDIR /data
USER node

EXPOSE 5000

# Node, not curl: nothing extra to install. Healthy = GET /api/health answers 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||5000,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node /app/preflight.js && exec node /app/dist/server.js"]
