// Runs before the server starts inside the container (see the Dockerfile ENTRYPOINT).
//
// In production the container refuses to start when a required setting is missing, and says WHICH one by name. It never prints a value.
// This file is only used by the image: the pm2 deployment and the tests do not load it, so their behaviour does not change.
//
// Plain JavaScript on purpose: it runs before anything is compiled or loaded and must not depend on the application.
"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED = [
  ["JWT_SECRET", "signs every session"],
  ["MONGODB_URI", "the database connection string"],
  ["PROXY_SHARED_SECRET", "lets the backend believe the real client IP sent by the frontend proxy (rate limits and IP hashes depend on it)"],
  ["APP_URL", "the address used in links inside emails"],
  ["SMTP_HOST", "outgoing mail (verification codes, invitations)"],
  ["SMTP_USER", "outgoing mail"],
  ["SMTP_PASS", "outgoing mail"],
  ["SMTP_FROM_EMAIL", "outgoing mail"],
];

// Said once, never fatal: the defaults are safe for one proxy in front of the container, and the runbook explains the rest.
const ADVISED = ["TRUST_PROXY_HOPS", "CORS_ORIGINS", "SUPER_ADMIN_EMAILS", "UPLOAD_DIR"];

// PREFLIGHT_KEY_PATH exists only so the tests can point at a temporary file.
const FIREBASE_KEY = process.env.PREFLIGHT_KEY_PATH || path.join(__dirname, "dist", "config", "firebase", "serviceAccountKey.json");

const env = process.env;
const missing = REQUIRED.filter(([name]) => !String(env[name] ?? "").trim());
const problems = missing.map(([name, why]) => `${name} is missing (${why})`);

// Three different mistakes, three different messages: no file (Docker then creates an EMPTY FOLDER at the mount path), a folder where the
// file should be, and a file the container user (uid 1000) is not allowed to read. The app itself only says "key is missing" for all three.
try {
  const stat = fs.statSync(FIREBASE_KEY);
  if (!stat.isFile()) {
    problems.push("the Firebase key path is a FOLDER, not a file: the host path in FIREBASE_KEY_PATH did not exist when the container started (Docker created a folder there). Remove that folder, put the key file there, start again");
  } else {
    try {
      fs.accessSync(FIREBASE_KEY, fs.constants.R_OK);
    } catch {
      problems.push("the Firebase key file exists but this container user (uid 1000) cannot read it: on the host run chown 1000:<group> and chmod 440 on the file");
    }
  }
} catch {
  problems.push("the Firebase service-account key file is missing: mount it read-only at dist/config/firebase/serviceAccountKey.json (FIREBASE_KEY_PATH)");
}

const production = env.NODE_ENV === "production";
if (problems.length > 0) {
  const heading = production ? "Refusing to start" : "Warning (would refuse to start in production)";
  console.error(`${production ? "FATAL" : "WARN"}: ${heading}:`);
  for (const p of problems) console.error(`  - ${p}`);
  if (production) process.exit(1);
}

const unset = ADVISED.filter((name) => !String(env[name] ?? "").trim());
if (unset.length > 0) console.warn(`NOTE: not set, defaults apply: ${unset.join(", ")}`);
