# QA backend fixes (Oct 2026)

Backward compatible with the deployed frontend. Verified by `src/__tests__/qa_backend_fixes.test.ts` (in-memory MongoDB), not production.

## Contract changes

| Area | Change |
|---|---|
| `POST /api/forms/:id/grants` | `400 GRANT_TARGET_HAS_FULL_ACCESS` when the grantee is the form's owner (personal creator / workspace owner) or a workspace admin. By **email**, the response is identical for known and unknown addresses: `201 { success, message, grant: { formId, email, role, accessLevel, permission } }` with no `userId`, name or avatar (refetch `GET /grants` for the row). By `userId` the response is unchanged. Only owner/admin could already create grants. |
| Access resolver (`requirePermission`) | A per-form grant can only add access. The owner and workspace owner/admin always resolve through their real role; a (legacy) lower grant is ignored. |
| `GET /api/analytics/trends` | `formId` is optional. Without it: every form in the caller's scope (workspace, or own personal forms). This was the 400 on dashboard/analytics/insights (the `timezone` was never the cause: `Asia/Calcutta` already passed). |
| `GET /api/responses?stageId=` | `new` / `in_progress` / `completed` are accepted as a category slug (filters by status). Real stage ids work as before. |
| `PUT/DELETE /api/forms/:id/pin`, `pinned` on `GET /api/forms` | Already implemented and routed in the repo (`pin.controller.ts`, `form.routes.ts`). The 404 means production runs an older build: deploy. |
| `POST/GET /api/reports`, `GET /api/reports/:id[/file]` | Personal scope: with no workspace (or `x-workspace-id: personal`) a report is private to its requester; `workspaceId` is `null` on the wire. It covers the caller's personal forms plus forms shared to them by a grant whose role can export (`member`, `editor`, `admin`). A `formId` shared by grant from outside the active workspace is exported as a personal report. |
| `PATCH/PUT /api/workspaces/:id/members/:memberId` | Sessions are revoked only when the role is lowered. Same role or a promotion keeps sessions. |
| Roles | `reviewer` and `viewer` now hold `responses:write` (tag, assign, note, score, change stage, clear "edited after review"). Still no `responses:delete`, `forms:write`, `reports:create`. |
| `GET /api/dashboard/analytics` | New `analytics.counts` (also under `data.counts`): `{ forms: { total, published, draft, closed, archived }, responses: { total, new, in_progress, completed, thisMonth } }`. True totals, no page cap, for the workspace home stat cards. Existing keys unchanged. |

## Performance

- `GET /api/dashboard/analytics`: forms loaded with a projection and `lean()`; counts run in parallel; recent rows projected.
- `GET /api/responses` and `/stats`: form scope now reads ids only (was whole form documents, up to 10,000, with fields/pages).
- `GET /api/reports`: one page of reports with `lean()`; form titles resolved only for the forms that page names (was every form in the workspace).
- New index `Report { requestedBy: 1, createdAt: -1 }` (personal report list). Mongoose creates it on startup; no migration.

## One-off data fix

`scratch/removeOwnerSelfGrants.ts` removes grants whose grantee is the form's owner (stuck form `6ac6036aae63dd7f0e97a3d7`). Dry run by default; `--apply` to delete. Not run against any database.
