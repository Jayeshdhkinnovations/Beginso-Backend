# Super admin metrics

Read-only platform figures for the Beginso Admin console (Overview and Insights). Everything here is an aggregation or an indexed
count behind `protect` and `requireSuperAdmin`. Nothing writes. No collection is loaded into memory (the older
`getHourlyTrends()` behind `GET /api/superadmin/stats` still does; see "Not changed" below).

## Endpoints

All are `GET /api/superadmin/metrics/<name>`, limited to 60 requests a minute per user, answered with `Cache-Control: no-store`.

| Name | What it returns |
|---|---|
| `overview` | The KPI row, the registrations and responses series with the previous period, and the top 5 workspaces by responses |
| `growth` | Registrations per day, cumulative users, workspaces and forms created per day and cumulative |
| `engagement` | Active users (daily, weekly, monthly), new and returning users, weekday by hour heatmaps, publish rate |
| `usage` | Responses per day, average responses per form, top workspaces, top forms, uploads and storage growth, exports per day by format, template usage |
| `attention` | Counts for the "Needs attention" list (not range based) |

### Query (all but `attention`)

| Parameter | Meaning |
|---|---|
| `from`, `to` | UTC. `YYYY-MM-DD` (the whole day) or an ISO timestamp (only its day is used). The range includes the end day. Default: the last 30 days ending today. Longest range: 366 days. |
| `compare` | `1` or `0` (also `true` or `false`). Default on: the previous period has the same number of days and ends the day before `from`. |
| `refresh` | `1` skips the 60 second cache and recomputes. |

Anything else in the query is rejected with `422`, as is a malformed date, `from` after `to`, or a range over 366 days.
`attention` accepts only `refresh`.

### Response

```json
{
  "success": true,
  "data": { },
  "meta": {
    "from": "2026-11-01T00:00:00.000Z",
    "to": "2026-11-21T23:59:59.999Z",
    "days": 21,
    "previous": { "from": "2026-10-11T00:00:00.000Z", "to": "2026-10-31T23:59:59.999Z" },
    "timezone": "UTC",
    "computedAt": "2026-11-21T14:32:05.120Z",
    "cached": false
  }
}
```

`computedAt` is when the numbers were computed; the console shows it ("Updated 14:32 UTC") and offers Refresh. `meta.previous` is
`null` when `compare=0`. `data` series are dense: one number per day in `data.days`, `0` for a day with no rows.

A figure that cannot be known is an object `{ "available": false, "reason": "..." }`. The console shows "Not available" and the
reason, never an estimate.

## Definitions

- **Day**: a UTC calendar day. Every date in a request and a response is UTC.
- **User**: an account with `role: "admin"` (a workspace owner or member who signed up). Super admins are never counted.
- **Registrations**: users by `createdAt`.
- **Active user (30 days)**: a distinct user with at least one session whose `lastActiveAt` falls in the last 30 days, counted back
  from now. `lastActiveAt` is refreshed at most once a minute while the user makes requests. A revoked session still counts.
  Weekly and daily use the same rule over 7 and 1 days.
- **Responses**: stored responses by `submittedAt`, excluding test submissions (`isTest`) and trashed responses (`deletedAt`).
- **Forms**: live forms (not trashed). **Published** is `status: "published"`.
- **Publish rate**: published forms over live forms, now. The per-day figure counts each form's latest `publishedAt` (an unpublish
  and republish overwrites it).
- **Storage used**: the sum of `User.storageUsedBytes` over users (the counter the console already uses).
- **Delta against the previous period**: shown by the console only when the previous period has data; otherwise "No prior data".
- **Top workspaces and forms**: responses in the range grouped by form, then by workspace. Only names and counts are returned: no
  answers, no respondent emails.
- **Heatmap**: 7 rows (Monday first) by 24 columns (hour 0 to 23, UTC). `responses` counts submissions; `adminActivity` counts
  sessions by their last activity.
- **New and returning**: active users in the range who registered inside the range (new) or before it (returning).
- **Uploads**: files created by `createdAt`. A deleted file is gone from the collection, so the cumulative figure is growth in
  uploads, not net storage.
- **Exports**: reports by `createdAt`, split by format (`csv`, `pdf`) and a count of failed ones.
- **Template usage**: live forms by `templateId`; the top 10 templates and the forms made from a template in the range and in total.

## Cannot be known today

| Metric | Why |
|---|---|
| Completion rate | `Form.viewsCount` is never incremented, so there is no view count to divide by. |
| Verified against unverified accounts | Email verification lives in Firebase, not in the database. |
| Sign-in method | Read from the Firebase token at login and not stored. |
| Active users on a past day, or in a window that does not end now | A session keeps only its latest activity time. Daily, weekly and monthly active users are exact for windows ending now; the previous period of active users is reported as unavailable. `newVsReturning` is marked `approximate`. |
| Net storage over time | Deleted uploads are not kept, so only upload growth can be shown. |
| Mail and abuse history beyond 30 days | `maillogs` and `systemlogs` expire after 30 days. |

## Indexes the owner may want

The new queries run today without these, but several scan a whole collection. **None has been created.** Run them on the primary,
off peak, after checking `db.<collection>.getIndexes()`. (Collection names are Mongoose defaults; confirm with
`db.getCollectionNames()`.)

```js
// users: registrations, growth, new vs returning
db.users.createIndex({ role: 1, createdAt: 1 })

// workspaces: workspaces created per day
db.workspaces.createIndex({ createdAt: 1 })

// forms: forms created per day, template usage, publishes per day
db.forms.createIndex({ createdAt: 1 })
db.forms.createIndex({ templateId: 1 }, { partialFilterExpression: { templateId: { $type: "objectId" } } })
db.forms.createIndex({ publishedAt: 1 }, { partialFilterExpression: { publishedAt: { $type: "date" } } })

// uploads: uploads and storage growth
db.uploads.createIndex({ createdAt: 1 })

// reports (exports): exports per day by format
db.reports.createIndex({ createdAt: 1, format: 1 })

// systemlogs: error count and abuse hits (30 day TTL collection)
db.systemlogs.createIndex({ level: 1, createdAt: -1 })
db.systemlogs.createIndex({ "meta.type": 1, createdAt: -1 })

// maillogs: failed mail in the last day (30 day TTL collection)
db.maillogs.createIndex({ outcome: 1, createdAt: -1 })
```

Already indexed and used: `sessions.lastActiveAt`, `responses {submittedAt:-1}` and `{formId:1, submittedAt:-1, status:1}`,
`forms.deletedAt`, `reports {status:1, createdAt:1}`, `users.storageUsedBytes`.

Rollback: `db.<collection>.dropIndex("<name>")`. The queries keep working without them.

## Caching and cost

Each endpoint caches its result for 60 seconds per range, per server instance (in memory; a restart empties it). Concurrent requests
for the same range share one computation. Heavy parts (top workspaces) group responses by form first, so the work is bounded by
the number of forms with responses in the range.

## Not changed

- `GET /api/superadmin/stats` and its `getHourlyTrends()` still load the users, forms, responses and uploads collections and
  filter them 24 times in memory. The Overview rebuild uses `metrics/overview` and no longer needs it. Retire or rewrite it when the
  console stops calling it.
- `GET /api/superadmin/admins` still reports `updatedAt` as the last login and runs a few queries per row. Phase 4 changes it.
- `blockSuspended` is not applied under `/api/superadmin` (it exempts that URL prefix by design: only super admins pass `requireSuperAdmin`).

## Privacy

No password, token, IP address, answer, or respondent email appears in any response. Workspace and form titles are the only free text.
Nothing here exports user lists.
