import mongoose from "mongoose";
import dotenv from "dotenv";
import crypto from "crypto";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Tag from "../models/Tag";
import Note from "../models/Note";
import Notification from "../models/Notification";
import { StageService } from "../services/stage.service";
import { allocateReference } from "../services/reference.service";

dotenv.config();

// Seeds random forms, responses (spread over a timeline), stages, tags, assignees, notes (the
// response "chat"), duplicates and soft-deleted rows for two real accounts. Re-runnable: rows it
// created are tagged with SEED_MARK and wiped + regenerated on every run.
//   npm run seed:test-users            (optionally: RESPONSES_PER_FORM=60 DAYS=90)
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";
const EMAILS = ["piyushthedev27@gmail.com", "kingsssss027@gmail.com"];
const SEED_MARK = "seed-test-users"; // Response.ipHash value; Notification messages end with it too
const PER_FORM = Number(process.env.RESPONSES_PER_FORM) || 40;
const DAYS = Number(process.env.DAYS) || 90;
const DAY_MS = 86400000;

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;
const between = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

const FIRST = ["Alex", "Sophia", "Marcus", "Elena", "David", "Aaliyah", "Liam", "Zoe", "Carlos", "Priya", "Ethan", "Maya", "Noah", "Olivia", "Arjun", "Isha", "Lucas", "Chloe", "Rohan", "Mia"];
const LAST = ["Rivera", "Chen", "Vance", "Rostova", "Miller", "Khan", "O'Connor", "Takahashi", "Gomez", "Sharma", "Wright", "Lin", "Patel", "Kim", "Silva", "Dupont", "Becker", "Mehta", "Rossi", "Brown"];
const CITIES = ["New York", "London", "Berlin", "Mumbai", "Toronto", "Sydney", "Singapore", "Delhi"];
const ROLES = ["Frontend Engineer", "Backend Engineer", "Product Manager", "UI/UX Designer", "Data Analyst"];
const TICKETS = ["General Admission", "VIP Pass", "Workshop Pass"];
const BIOS = [
  "Full-stack engineer with 6 years building scalable cloud services.",
  "Designer focused on SaaS interfaces and design systems.",
  "Data analyst who loves turning messy spreadsheets into dashboards.",
  "Product manager who has shipped three B2B launches.",
  "Backend developer, mostly Node, some Go, strong opinions on observability.",
];

const TAGS = [
  { name: "Priority", colour: "red" },
  { name: "Follow up", colour: "amber" },
  { name: "Shortlisted", colour: "emerald" },
  { name: "Needs docs", colour: "blue" },
  { name: "VIP", colour: "violet" },
  { name: "Spam?", colour: "slate" },
];

const NOTE_LINES = [
  "Looks strong, moving this one forward.",
  "Can you double-check the details they gave?",
  "Called them — no answer, will try again tomorrow.",
  "Waiting on the missing documents.",
  "Good fit. Let's schedule a call this week.",
  "Possible duplicate of an earlier submission, please confirm.",
  "Approved on my side.",
  "Needs a second opinion before we decide.",
  "Replied by email, ball is in their court.",
  "Closing this out — all done.",
];

const FORM_DEFS = [
  {
    title: "Seed – Job Application",
    slug: "seed-job-application",
    fields: [
      { label: "Full Name", type: "short_text" },
      { label: "Email Address", type: "email" },
      { label: "Phone Number", type: "phone" },
      { label: "Position", type: "dropdown", options: ROLES },
      { label: "Years of Experience", type: "number" },
      { label: "Short Bio", type: "long_text" },
    ],
  },
  {
    title: "Seed – Event Registration",
    slug: "seed-event-registration",
    fields: [
      { label: "Attendee Name", type: "short_text" },
      { label: "Work Email", type: "email" },
      { label: "Company", type: "short_text" },
      { label: "Ticket", type: "multiple_choice", options: TICKETS },
      { label: "Dietary", type: "checkbox", options: ["Vegetarian", "Vegan", "Gluten-Free", "None"] },
    ],
  },
];

const answerFor = (type: string, label: string, name: string, email: string, options?: string[]): any => {
  switch (type) {
    case "email": return email;
    case "phone": return `+1${between(2000000000, 9999999999)}`;
    case "number": return between(1, 15);
    case "long_text": return pick(BIOS);
    case "dropdown":
    case "multiple_choice": return pick(options!);
    case "checkbox": return [pick(options!)];
    default: return /company/i.test(label) ? `${pick(LAST)} Labs` : name;
  }
};

const seedForUser = async (email: string, users: any[]) => {
  const user = users.find((u) => u.email.toLowerCase() === email)!;

  let ws = await Workspace.findOne({ owner: user._id });
  if (!ws && user.workspaceId) ws = await Workspace.findById(user.workspaceId);
  if (!ws) {
    ws = await Workspace.create({ name: `${user.fullName}'s Workspace`, owner: user._id });
  }
  if (!user.workspaceId) {
    user.workspaceId = ws._id as any;
    await user.save();
  }
  const wsId = ws._id.toString();

  // Both accounts are members of each other's workspace so assignment / @mention / chat can be
  // tested from either login.
  for (const u of users) {
    await Membership.updateOne(
      { userId: u._id, workspaceId: ws._id },
      { $setOnInsert: { role: u._id.equals(user._id) ? "owner" : "admin", notificationPreference: "all" } },
      { upsert: true }
    );
  }

  const stages = await new StageService().ensureDefaultStages(wsId);

  const tags = [];
  for (const t of TAGS) {
    const tag = await Tag.findOneAndUpdate(
      { workspaceId: ws._id, nameLower: t.name.toLowerCase() },
      { $setOnInsert: { name: t.name, colour: t.colour } },
      { upsert: true, new: true }
    );
    tags.push(tag!);
  }

  const counts = await fill(ws, user, users, stages, tags);
  console.log(`  ${email}: workspace "${ws.name}" → ${counts.responses} responses, ${counts.notes} notes, ${tags.length} tags, ${stages.length} stages`);
};

// ws === null is the user's Personal space: forms with workspaceId null + createdBy = user. Stages,
// tags, memberships and notifications are all workspace-scoped, so Personal gets status-only
// responses (no stageId), no tags/assignees, and notes from the owner alone.
const fill = async (ws: any | null, user: any, users: any[], stages: any[], tags: any[]) => {
  const scope = ws ? { workspaceId: ws._id } : { workspaceId: null, createdBy: user._id };
  const where = ws ? "ws" : "personal";

  // Forms (created once, reused after).
  const forms = [];
  for (const def of FORM_DEFS) {
    let form = await Form.findOne({ ...scope, title: def.title });
    if (!form) {
      const pageId = new mongoose.Types.ObjectId().toString();
      const slug = `${def.slug}-${where}-${user._id.toString().slice(-4)}`;
      form = await Form.create({
        title: def.title,
        description: "Generated by seedTestUsers",
        ...scope,
        status: "published",
        slug,
        publishedSlug: slug,
        publishedAt: new Date(Date.now() - DAYS * DAY_MS),
        pages: [{ id: pageId, order: 0, title: "Page 1" }],
        fields: def.fields.map((f, i) => ({
          fieldId: new mongoose.Types.ObjectId().toString(),
          pageId,
          order: i,
          required: true,
          ...f,
        })) as any,
      });
    }
    forms.push(form);
  }

  // Wipe what a previous run created for this workspace.
  const formIds = forms.map((f) => f._id);
  const old = await ResponseModel.find({ formId: { $in: formIds }, ipHash: SEED_MARK }).select("_id");
  const oldIds = old.map((r) => r._id);
  await Note.deleteMany({ responseId: { $in: oldIds } });
  await ResponseModel.deleteMany({ _id: { $in: oldIds } });
  if (ws) await Notification.deleteMany({ workspaceId: ws._id, message: { $regex: `${SEED_MARK}$` } });

  let responses = 0, notes = 0;
  for (const form of forms) {
    const fields = form.fields as any[];
    const emailField = fields.find((f) => f.type === "email");
    // Timeline: mostly random across DAYS (biased recent), plus a few guaranteed today/yesterday.
    const times = Array.from({ length: PER_FORM }, (_, i) =>
      i < 3 ? Date.now() - between(1, 20) * 3600000 * (i + 1)
        : Date.now() - Math.pow(Math.random(), 1.4) * DAYS * DAY_MS
    ).sort((a, b) => a - b);

    const usedEmails: string[] = [];
    for (const t of times) {
      const submittedAt = new Date(t);
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      // ~12% repeat an earlier email so the duplicate flag has something to show.
      const isDup = usedEmails.length > 0 && chance(0.12);
      const respEmail = isDup
        ? pick(usedEmails)
        : `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${between(1, 99)}@example.com`;
      if (!isDup) usedEmails.push(respEmail);

      const answers: Record<string, any> = {};
      for (const f of fields) {
        const v = answerFor(f.type, f.label, name, respEmail, f.options);
        answers[f.label] = v;
        answers[f.fieldId] = v;
      }

      // Older responses have progressed further through the pipeline.
      const ageDays = (Date.now() - t) / DAY_MS;
      const S = ws ? stages : [{ category: "new" }, { category: "in_progress" }, { category: "completed" }];
      const stage = ageDays > 30 ? pick([S[2], S[2], S[1]])
        : ageDays > 7 ? pick(S)
        : pick([S[0], S[0], S[1]]);

      const assignee = ws && chance(0.6) ? pick(users) : null;
      const tagIds = tags.filter(() => chance(0.2)).map((x) => x._id);
      const dupOf = isDup
        ? await ResponseModel.findOne({ formId: form._id, respondentEmail: respEmail.toLowerCase(), deletedAt: null })
            .sort({ submittedAt: 1 }).select("_id").lean()
        : null;

      const resp = await ResponseModel.create({
        formId: form._id,
        answers,
        stageId: ws ? stage._id : undefined,
        status: stage.category,
        submittedAt,
        ipHash: SEED_MARK,
        reference: await allocateReference(form._id),
        tagIds,
        assigneeId: assignee?._id ?? null,
        respondentEmail: emailField ? respEmail.toLowerCase() : null,
        duplicateOfId: dupOf?._id ?? null,
        deletedAt: chance(0.04) ? new Date(t + DAY_MS) : null,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      });
      responses++;

      if (ws && assignee) {
        await Notification.create({
          userId: assignee._id, workspaceId: ws._id, type: "assignment", read: chance(0.5),
          title: "Response assigned to you",
          message: `${form.title} ${resp.reference} was assigned to you. ${SEED_MARK}`,
          createdAt: submittedAt,
        });
      }

      // Chat thread on ~50% of responses: 1-4 notes alternating authors, minutes–days apart.
      if (chance(0.5)) {
        let at = t;
        for (let n = 0; n < between(1, 4); n++) {
          at += between(5, 60 * 24 * 2) * 60000;
          if (at > Date.now()) break;
          const author = ws ? pick(users) : user;
          const other = users.find((u) => !u._id.equals(author._id)) ?? author;
          const mention = ws ? chance(0.3) : false;
          await Note.create({
            responseId: resp._id,
            authorId: author._id,
            authorName: author.fullName,
            body: mention ? `@${other.fullName} ${pick(NOTE_LINES)}` : pick(NOTE_LINES),
            mentionIds: mention ? [other._id] : [],
            editedAt: chance(0.15) ? new Date(at + 600000) : null,
            createdAt: new Date(at),
            updatedAt: new Date(at),
          });
          notes++;
          if (ws && mention) {
            await Notification.create({
              userId: other._id, workspaceId: ws._id, type: "mention", read: chance(0.5),
              title: `${author.fullName} mentioned you`,
              message: `On ${form.title} ${resp.reference}. ${SEED_MARK}`,
              createdAt: new Date(at),
            });
          }
        }
      }
    }
  }
  return { responses, notes };
};

const seedPersonal = async (email: string, users: any[]) => {
  const user = users.find((u) => u.email.toLowerCase() === email)!;
  const counts = await fill(null, user, [user], [], []);
  console.log(`  ${email}: Personal space → ${counts.responses} responses, ${counts.notes} notes`);
};

const run = async () => {
  await mongoose.connect(mongoUri);
  const users = [];
  for (const email of EMAILS) {
    let u = await User.findOne({ email: new RegExp(`^${email}$`, "i") });
    if (!u) {
      console.warn(`! ${email} not in DB — creating a placeholder (it can't log in until it signs up via Firebase)`);
      u = await User.create({ fullName: email.split("@")[0], email, firebaseUid: `seed-${email}`, role: "admin", status: "active" });
    }
    users.push(u);
  }
  console.log("Seeding…");
  for (const email of EMAILS) {
    await seedForUser(email, users);
    await seedPersonal(email, users);
  }
  await mongoose.disconnect();
};

run().then(() => process.exit(0)).catch((e) => { console.error("Seed failed:", e); process.exit(1); });
