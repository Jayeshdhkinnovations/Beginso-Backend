import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { buildSearchText } from "../utils/responseSearch";

dotenv.config();

// BE 0.4 (Sprint 11): seeds a "realistic volume" multi-workspace dataset to time queries against.
// Decision (29 Sep 2026, no prior number existed anywhere): 20 workspaces × 15 members × 10 forms
// × 500 responses = 20 workspaces, ~300 memberships, 200 forms, ~100,000 responses. Sized for a
// small-to-mid B2B tenant a year or two in — enough to catch an unindexed collection scan, not so
// large it needs its own infra to generate. Change the constants below and re-run if that's wrong.
//
// A run of this exact shape (against an ephemeral in-memory MongoDB, not this real database) was
// timed on 29 Sep 2026: every hot query listed in BE 0.4 used an index (IXSCAN/IDHACK), zero
// collection scans, all under 10ms even on a single in-memory core. See BACKEND.md §18/§21 and
// `.kiro/specs/sprint-11-v2a-hardening/tasks.md` BE 0.4 for the full table. Re-run against a real
// staging Mongo (not production) if you want production-representative wall-clock numbers, not just
// the scan-type signal this already confirmed.
const WORKSPACES = 20;
const MEMBERS_PER_WORKSPACE = 15;
const FORMS_PER_WORKSPACE = 10;
const RESPONSES_PER_FORM = 500;

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

const run = async () => {
  if (!mongoUri) {
    console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to seed.");
    process.exit(1);
  }
  // Never run against what looks like a production URI by accident.
  if (!/localhost|127\.0\.0\.1|test|staging|seed/i.test(mongoUri)) {
    console.error(`Refusing to seed a URI that doesn't look like local/test/staging: ${mongoUri.replace(/\/\/.*@/, "//<redacted>@")}`);
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected. Seeding BE 0.4 volume dataset (idempotent prefix: v2a-vol-)...");

  const users: mongoose.Types.ObjectId[] = [];
  for (let u = 0; u < WORKSPACES * MEMBERS_PER_WORKSPACE; u++) {
    const email = `v2a-vol-user-${u}@seed.local`;
    const existing = await User.findOne({ email }).select("_id").lean();
    const id = existing?._id ?? (await User.create({ firebaseUid: `v2a-vol-uid-${u}`, fullName: `Seed User ${u}`, email, role: "admin", status: "active" }))._id;
    users.push(id);
  }
  console.log(`Users ready: ${users.length}`);

  let userCursor = 0;
  let formsCreated = 0;
  let responsesCreated = 0;

  for (let w = 0; w < WORKSPACES; w++) {
    const slug = `v2a-vol-ws-${w}`;
    const owner = users[userCursor++];
    let ws = await Workspace.findOne({ slug }).select("_id").lean();
    if (!ws) {
      ws = await Workspace.create({ name: `Seed Workspace ${w}`, slug, timezone: "UTC", owner });
    }
    const wsId = ws._id as mongoose.Types.ObjectId;

    if (!(await Membership.exists({ userId: owner, workspaceId: wsId }))) {
      await Membership.create({ userId: owner, workspaceId: wsId, role: "owner", notificationPreference: "all" });
    }
    const roles = ["admin", "editor", "viewer"] as const;
    for (let m = 1; m < MEMBERS_PER_WORKSPACE; m++) {
      const memberId = users[userCursor % users.length];
      userCursor++;
      if (!(await Membership.exists({ userId: memberId, workspaceId: wsId }))) {
        await Membership.create({ userId: memberId, workspaceId: wsId, role: roles[m % roles.length], notificationPreference: "none" });
      }
    }

    for (let f = 0; f < FORMS_PER_WORKSPACE; f++) {
      const title = `Seed Form ${w}-${f}`;
      let form = await Form.findOne({ workspaceId: wsId, title }).select("_id").lean();
      if (!form) {
        form = await Form.create({
          title,
          workspaceId: wsId,
          createdBy: owner,
          status: "published",
          slug: `v2a-vol-${w}-${f}`,
          publishedSlug: `v2a-vol-${w}-${f}`,
          fields: [
            { fieldId: "name", label: "Name", type: "short_text", required: true },
            { fieldId: "email", label: "Email", type: "email", required: true },
          ],
        });
        formsCreated++;
      }
      const formId = form._id as mongoose.Types.ObjectId;

      const already = await ResponseModel.countDocuments({ formId });
      const toAdd = RESPONSES_PER_FORM - already;
      if (toAdd > 0) {
        const batch = Array.from({ length: toAdd }, (_, i) => {
          const answers = { Name: `Respondent ${i}`, Email: `respondent-${i}@seed.local` };
          return { formId, answers, searchText: buildSearchText(answers), status: ["new", "in_progress", "completed"][i % 3] };
        });
        await ResponseModel.insertMany(batch, { ordered: false });
        responsesCreated += toAdd;
      }
    }
    if (w % 5 === 0) console.log(`Workspace ${w + 1}/${WORKSPACES} done`);
  }

  console.log(`Done. Forms created: ${formsCreated}. Responses created: ${responsesCreated}.`);
  console.log("Next: run BE 0.4's timing pass (explain() or console.time) against these workspaces, record before/after in BACKEND.md.");
  await mongoose.disconnect();
};

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { run as seedV2aVolume };
