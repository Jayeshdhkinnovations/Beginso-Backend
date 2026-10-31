# Endpoint review: six routes with no known caller

Read-only review. **No code was changed.** Read from `main` at `1ff1821` (31 Oct 2026). For each route: what it does, the checks it has, whether a newer route does the same job, and what a user could do with it. Callers were searched by text in `Beginso/src` (frontend), `Beginso-Admin/src`, `docs/` and `bruno/`; none was found for any of the six, except where stated.

How the checks work, so the tables are short: `protect` = a valid session token is required; `blockSuspended` = suspended accounts are refused; `requirePermission("x", { resourceType: "form" })` = the caller must hold permission `x` through their role in the form's workspace (or a share grant on that form). Roles in `permission.middleware.ts`: `admin`, `editor`, `member`, `reviewer` and `viewer` **all** hold `responses:read` **and** `responses:write`; `responses:write` is the "act on responses" tier (tag, assign, note, score, stage), and the comment in the file says the app's one non-editor role ("Reviewer") is the wire role `viewer`.

## Summary

| Route | Verdict | Why |
|---|---|---|
| `PUT /api/users/profile` | **weak, replaceable** | writes `fullName` with no validation; also lets the caller write `isActive`, a field nothing reads. `PATCH /api/users/me` does the same job with validation. |
| `DELETE /api/users/profile` | **fine, keep** | same handler as `DELETE /api/workspaces/current`; **it does require re-authentication**. |
| `POST /api/forms/:formId/submissions` | **real gap** | any workspace member, including the lowest role, can create real responses on a form, including on a draft or archived form, past the public form's protections. |
| `GET /api/forms/:formId/submissions` | **works, older shape** | returns raw stored response documents; the newer responses list is the one the app uses. |
| `GET /api/forms/:formId/score-comparison` | **works, loads everything** | correct checks; sorts and pages in memory; includes test submissions. |
| `POST /api/auth/notify-password-changed` | **real gap (shared with its twin)** | unauthenticated; sends a "your password was changed" email to any address given. A duplicate of `POST /api/auth/password-changed`. |

## 1. `PUT /api/users/profile` (`updateProfile`, `user.controller.ts`)

* **Does:** loads the signed-in user, sets `fullName` and `isActive` from the request body, saves, returns the whole user document.
* **Checks:** `protect`, `blockSuspended`. It only ever edits the caller's own record (`req.user._id`). No `requirePermission`, no validation schema, no rate limit.
* **Newer route:** `PATCH /api/users/me` (`patchProfileMe`, `user_settings.controller.ts`) with a Zod schema: name 1 to 100 characters, a valid avatar URL, a theme enum. The frontend uses `/api/users/me` and `/api/me`.
* **Misuse:**
  * `fullName` is stored as sent: no length limit (only the request body size limit), no trimming, empty string allowed. The name is shown to other workspace members and used in emails, so a user can set a very long or blank name that the newer route would refuse.
  * `isActive` is accepted from the user. Nothing in `src` reads `User.isActive` (suspension uses `status`, which this route does not touch), so today it has **no effect**; but it is a client-controlled field on a security-looking name, and any later feature that trusts it would be bypassable.
  * The response returns the full user document (including `firebaseUid`, `loginHistory`, storage counters), to the owner only.
* **Recommendation (not done):** retire the route or make it delegate to the `PATCH /me` schema.

## 2. `DELETE /api/users/profile` (`deleteProfile`, an alias of `deleteAccountFlow`)

* **Does:** closes the caller's account: deletes the Firebase user, then the owned workspaces and all associated data. It is the same handler as `DELETE /api/workspaces/current` (the app's "Delete workspace" button, whose confirmation says it deletes the account).
* **Checks:** `protect`, `blockSuspended`, and then **re-authentication inside the handler**: `verifyRecentReauth` needs a fresh Firebase ID token for the same user (`REAUTH_REQUIRED` if missing, `REAUTH_MISMATCH` for another account, `REAUTH_EXPIRED` if the sign-in is older than 5 minutes, `REAUTH_INVALID` otherwise). It also refuses (409) while the caller owns workspaces other people belong to.
* **Newer route:** none; this is the current implementation, shared with the workspace route.
* **Misuse:** **a user cannot delete a profile without re-authenticating**, and cannot delete someone else's. A stolen session token alone is not enough, because the confirmation needs a Firebase token minted within 5 minutes. Firebase is deleted first, so a failure leaves nothing half-deleted. No finding.

## 3. `POST /api/forms/:formId/submissions` (`submitForm`, `form.controller.ts`)

* **Does:** creates a response on the form from `req.body.answers`, through `formService.submitForm`.
* **Checks:** `protect`, `blockSuspended`, `requirePermission("responses:write", { resourceType: "form" })`. That permission is held by **every workspace role, `viewer` included**.
* **Newer route:** the public form flow (`POST /api/public/:slug/submit`, with a submit ticket for signed-in respondents) and `POST /api/forms/:formId/test-submissions` (needs `forms:write`, marked as a test).
* **What this route skips that the public route has:** the honeypot, the submit rate limiter, the access mode (who may respond), respondent email verification, the submit ticket, IP hash and geo (stored as empty). And it calls `checkFormAvailability` as a non-public route, so the **draft and archived checks are skipped** (they only apply `isPublicRoute`); a close date or a full response limit still apply.
* **Misuse:** any member of a workspace, even with the most limited role, can add **real, non-test** responses to any form in it, including drafts and archived forms. Each one takes a reference number (`#n`), counts toward the response limit (and can close the form), writes a "Respondent" entry in the workspace activity feed and can trigger duplicate detection, with no rate limit. That is data pollution and a way to fill a limit, not a data leak. No frontend, Admin or doc caller exists.
* **Recommendation (not done):** remove it, or restrict it to `forms:write` and mark the result as a test.

## 4. `GET /api/forms/:formId/submissions` (`getSubmissions`)

* **Does:** pages through the stored responses of a form (`page`, `limit` up to 500, newest first), excluding trashed ones.
* **Checks:** `protect`, `blockSuspended`, `requirePermission("responses:read", { resourceType: "form" })`, then `resolveFormAccess` (404 if the form is not found, 403 if the user has no access); it rejects a `workspaceId` in the body or params.
* **Newer route:** `GET /api/responses` and the per-form responses endpoints (`response.routes.ts`, `responses:read`, with stages, filters, search and read state), which the app uses.
* **Misuse:** returns the raw stored documents: this includes `ipHash`, `geo`, `respondentEmail`, `respondentUserId`, `isTest` and internal fields, to any role with `responses:read`. I did not diff that field set against the newer list; if the newer endpoints deliberately hide any of those fields from lower roles, this one bypasses that. It also returns test submissions.

## 5. `GET /api/forms/:formId/score-comparison` (`getScoreComparison`, `score.controller.ts`)

* **Does:** one row per response with its average score and score count, sortable ascending or descending, 20 per page.
* **Checks:** `protect`, `blockSuspended`, `requirePermission("responses:read", { resourceType: "form" })`. Same permission as the response list, so no extra exposure beyond what a reader already sees.
* **Newer route:** none that does the same; the scoring endpoints on a single response (`scoreResponse`, `getResponseScore`) are used by the app.
* **Misuse:** none beyond normal read access. Two quality notes: it loads **all** responses of the form, aggregates, sorts and pages **in memory** (a form with tens of thousands of responses makes every call heavy), and it includes test submissions. The first check is `Form.findById` without a workspace filter, but the permission middleware has already resolved access to that form.

## 6. `POST /api/auth/notify-password-changed` (`notifyPasswordChanged`, `auth.controller.ts`)

* **Does:** sends the "password changed" confirmation email to an address.
* **Checks:** `authRateLimiter` and `emailTargetRateLimiter` only (per IP, plus 5 emails per hour per target address). **No `protect`.** If a `Bearer` token is present and valid (verified with the backend JWT secret) the address comes from the token; **if the token is missing or invalid it silently falls back to `req.body.email`.**
* **Newer route:** `POST /api/auth/password-changed` is the **same handler with the same limiters**, mounted one line above; the frontend calls that one (`settings.ts`). So `notify-password-changed` is a duplicate alias with no extra protection.
* **Misuse:** anyone who can reach the API can make Beginso send a "Your password was changed" email, with a link to the login page, to **any address**, up to 5 per hour per address and the IP limit. That is usable to alarm or phish a person ("your password was changed, click here") from the real Beginso sender, and as a small email-bomb through many addresses. It does not reveal whether the address has an account, because it never looks the address up.
* **Recommendation (not done):** require `protect` and send only to the signed-in user's own address (ignore `req.body.email`), on the surviving route; remove the alias.

## What I did not check

Frontend render of any field these routes return; whether the Admin console calls them through a path I could not search by text; the Express-level body size limit (it bounds `fullName`); the production data (no database was read).
