/** One-time, repeatable import of the Kala Chashma spreadsheet into its existing form. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form, { IForm } from "../models/Form";
import ResponseModel from "../models/Response";
import Stage from "../models/Stage";
import Template from "../models/Template";
import { FormService } from "../services/form.service";
import { bumpReferenceCounter } from "../services/reference.service";
import { aggregateField } from "../utils/fieldSegments";
import { kalaChasmaCsvLabelOverrides, kalaChasmaCsvUrlFields } from "../data/kalaChasmaTemplate";

dotenv.config({ quiet: true });
const EMAIL = "kalachashmaent@gmail.com";
const WORKSPACE = "Kala Chashma Entertainment";
const FORM = "Kala Chasma Content Acquisition";
const CSV = path.resolve(__dirname, "../../kala_chashma.csv");
const longText = new Set([
  "PROVIDE ACTORS NAME", "Accolades/Awards won (if any)", "Address",
  "One line synopsis (under 160 characters) for your film.", "SYNOPSIS - in detail",
  "Specified keyword for your film. (separate comma)", "If any queries", "KC COMMENTS",
]);
const urlFields = new Set<string>(kalaChasmaCsvUrlFields);
const chartChoices: Record<string, string[]> = {
  Categories: ["Shortfilm", "Webfilm", "Webseries", "Documentary", "Music Video"],
  "Status of the Film": ["Unreleased", "Released"],
  STATUS: ["IN REVIEW", "ON PROGRESS", "ON HOLD", "RELEASED", "REJECTED"],
};
const csvStages = [
  { csv: "IN REVIEW", name: "In Review", category: "in_progress", colour: "blue" },
  { csv: "ON PROGRESS", name: "On Progress", category: "in_progress", colour: "amber" },
  { csv: "ON HOLD", name: "On Hold", category: "in_progress", colour: "orange" },
  { csv: "RELEASED", name: "Released", category: "completed", colour: "emerald" },
  { csv: "REJECTED", name: "Rejected", category: "completed", colour: "rose" },
] as const;

function parsedDate(raw: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) throw new Error(`Invalid CSV timestamp: ${raw}`);
  const [, day, month, year, hour, minute, second] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 330 * 60_000);
  const local = new Date(value.getTime() + 330 * 60_000);
  if (Number.isNaN(value.getTime()) || local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
    local.getUTCHours() !== hour || local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second) throw new Error(`Invalid CSV timestamp: ${raw}`);
  return value;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const source = fs.readFileSync(CSV);
  const csvHash = crypto.createHash("sha256").update(source).digest("hex");
  const rows = parse(source, { columns: true, bom: true, relax_column_count: false }) as Record<string, string>[];
  const headers = Object.keys(rows[0] || {});
  if (headers.length !== 40 || rows.length !== 1222) throw new Error("CSV shape changed; review the import mapping.");
  const records = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    Object.values(row).some(value => value.trim() !== "")
  );
  if (records.length !== 1170) throw new Error("Substantive CSV row count changed; review the import.");
  for (const { row } of records) parsedDate(row.Timestamp);

  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10000 });
  try {
    const user = await User.findOne({ email: EMAIL });
    if (!user) throw new Error(`Account ${EMAIL} was not found`);
    const workspace = await Workspace.findOne({ name: WORKSPACE, owner: user._id, status: "active" });
    if (!workspace || String(user.workspaceId) !== String(workspace._id)) throw new Error("Target workspace ownership mismatch");
    if (process.argv.includes("--inspect")) {
      const forms = await Form.find({ workspaceId: workspace._id }).sort({ createdAt: -1 });
      console.log(JSON.stringify(await Promise.all(forms.map(async candidate => {
        const expected = headers.filter(header => header.trim() !== "Timestamp").map(header => {
          const original = header.trim();
          return { label: kalaChasmaCsvLabelOverrides[original] ?? original,
            type: chartChoices[original] ? "dropdown" : original === "Email address" ? "email" : urlFields.has(original) ? "url"
              : longText.has(original) ? "long_text" : "short_text" };
        });
        return {
          id: String(candidate._id), title: candidate.title, status: candidate.status,
          createdAt: candidate.createdAt, fields: candidate.fields.length,
          pages: candidate.pages.length, templateId: candidate.templateId && String(candidate.templateId),
          responses: await ResponseModel.countDocuments({ formId: candidate._id }).setOptions({ includeTest: true }),
          missingFields: expected.filter(field => !candidate.fields.some(actual => actual.label === field.label)).map(field => field.label),
          typeDifferences: expected.filter(field => candidate.fields.some(actual => actual.label === field.label && actual.type !== field.type)).map(field => field.label),
          additionalFields: candidate.fields.filter(actual => !expected.some(field => field.label === actual.label)).map(field => field.label),
        };
      })), null, 2));
      return;
    }
    let form: IForm | null = await Form.findOne({ title: FORM, workspaceId: workspace._id, status: "published" });
    if (!form && execute && process.argv.includes("--create-missing")) {
      const otherForm = await Form.collection.findOne({ title: FORM, workspaceId: workspace._id });
      if (otherForm) throw new Error("A form with this title exists in another state; refusing to create a duplicate");
      const template = await Template.findOne({ name: FORM, workspaceId: null, isActive: true });
      if (!template) throw new Error("Kala Chasma template was not found");
      if (template.fields.some(field => field.label.length > 100)) throw new Error("Template still contains an overlong label");
      form = await new FormService().createForm(String(workspace._id), {
        title: FORM,
        description: `Created from template: ${FORM}`,
        createdBy: user._id,
        fields: template.fields,
        pages: template.pages,
        templateId: template._id,
        templateCategory: template.category,
        status: "published",
      } as any);
      console.log(`Created replacement form ${form!._id} from template ${template._id}`);
    }
    if (!form) throw new Error("Target published form was not found in the specified workspace");

    const existing = await ResponseModel.countDocuments({ formId: form._id }).setOptions({ includeTest: true });
    const pageOne = form.pages?.[0]?.id ?? "page-kc-1";
    const pageTwo = form.pages?.[1]?.id ?? "page-kc-2";
    const fields = headers.flatMap((header, index) => {
      const originalLabel = header.trim();
      if (originalLabel === "Timestamp") return [];
      const label = kalaChasmaCsvLabelOverrides[originalLabel] ?? originalLabel;
      if (label.length > 100) throw new Error(`Field label still exceeds 100 characters: ${label}`);
      return {
        fieldId: crypto.createHash("sha256").update(`kala-chashma-csv:${originalLabel}`).digest("hex").slice(0, 24),
        pageId: index < 28 ? pageOne : pageTwo,
        label,
        type: chartChoices[originalLabel] ? "dropdown" : originalLabel === "Email address" ? "email" : urlFields.has(originalLabel) ? "url"
          : longText.has(originalLabel) ? "long_text" : "short_text",
        ...(chartChoices[originalLabel] ? { options: chartChoices[originalLabel] } : {}),
        helpText: label === originalLabel ? "" : originalLabel,
        required: false,
        deleted: false,
      };
    });
    const seen = new Map<string, mongoose.Types.ObjectId>();
    const stages = await Stage.find({ workspaceId: workspace._id });
    const stage = (category: string) => stages.find(s => s.category === category)?._id;
    const responses = records.map(({ row, index }, position) => {
      const answers: Record<string, string> = {};
      for (const header of headers) {
        const originalLabel = header.trim();
        if (originalLabel !== "Timestamp") {
          answers[kalaChasmaCsvLabelOverrides[originalLabel] ?? originalLabel] = row[header];
        }
      }
      const email = row["Email address"].trim().toLowerCase();
      const duplicateOfId = email ? seen.get(email) ?? null : null;
      const _id = new mongoose.Types.ObjectId(crypto.createHash("sha256")
        .update(`${csvHash}:${String(form._id)}:${index}`).digest("hex").slice(0, 24));
      if (email && !seen.has(email)) seen.set(email, _id);
      const originalStatus = row.STATUS.trim().toUpperCase();
      if (originalStatus && !csvStages.some(item => item.csv === originalStatus)) {
        throw new Error(`Unknown CSV status at row ${index + 2}: ${originalStatus}`);
      }
      const status = ["RELEASED", "REJECTED"].includes(originalStatus) ? "completed"
        : ["ON HOLD", "ON PROGRESS", "IN REVIEW"].includes(originalStatus) ? "in_progress" : "new";
      const submittedAt = parsedDate(row.Timestamp);
      const namedStage = csvStages.find(item => item.csv === originalStatus);
      const stageId = namedStage
        ? stages.find(item => item.name === namedStage.name)?._id ?? stage(status)
        : stage(status);
      return {
        _id, formId: form._id, answers, status, stageId, submittedAt,
        createdAt: submittedAt, updatedAt: submittedAt, reference: `#${position + 1}`,
        respondentEmail: email || null, duplicateOfId, tagIds: [], deletedAt: null, isTest: false,
        searchText: Object.values(answers).join(" ").toLowerCase(),
      };
    });
    if (process.argv.includes("--repair-chart-fields")) {
      if (existing !== responses.length) throw new Error("Response count changed; refusing chart-field repair");
      for (const [label, options] of Object.entries(chartChoices)) {
        const field = form.fields.find(item => item.label === label);
        if (!field || field.deleted) throw new Error(`Cannot find active question: ${label}`);
        const unexpected = responses.find(response => response.answers[label].trim() && !options.includes(response.answers[label].trim()));
        if (unexpected) throw new Error(`CSV value is not a ${label} option: ${unexpected.answers[label]}`);
      }
      console.log(JSON.stringify({ mode: execute ? "repair-chart-fields" : "repair-chart-fields-dry-run",
        form: String(form._id), responses: existing, questions: Object.keys(chartChoices) }, null, 2));
      if (execute) {
        let changed = false;
        for (const [label, options] of Object.entries(chartChoices)) {
          const field = form.fields.find(item => item.label === label)!;
          if (field.type === "dropdown" && JSON.stringify(field.options) === JSON.stringify(options)) continue;
          field.type = "dropdown";
          field.options = options;
          changed = true;
        }
        if (changed) {
          form.contentVersion = (form.contentVersion ?? 0) + 1;
          await form.save();
        }
        console.log(changed ? "Made the three CSV choice questions chartable without changing responses." : "Choice questions already chartable; no changes made.");
      }
      return;
    }
    if (process.argv.includes("--verify-chart-fields")) {
      if (existing !== responses.length) throw new Error("Response count changed; refusing chart verification");
      for (const [label, options] of Object.entries(chartChoices)) {
        const field = form.fields.find(item => item.label === label && item.type === "dropdown");
        if (!field || JSON.stringify(field.options) !== JSON.stringify(options)) throw new Error(`Chart field differs: ${label}`);
        const distribution = await aggregateField(form, field, {});
        const expectedCounts = new Map(options.map(option => [option, responses.filter(response => response.answers[label].trim() === option).length]));
        if (distribution.totalResponses !== responses.length || options.some(option =>
          distribution.buckets.find(bucket => bucket.value === option)?.count !== expectedCounts.get(option))) {
          throw new Error(`Chart data differs from CSV: ${label}`);
        }
        console.log(JSON.stringify({ question: label, totalResponses: distribution.totalResponses,
          blank: distribution.blank, counts: Object.fromEntries(expectedCounts) }));
      }
      return;
    }
    if (process.argv.includes("--repair-status")) {
      if (existing !== responses.length) throw new Error("Response count changed; refusing status repair");
      const expectedIds = new Set(responses.map(response => String(response._id)));
      const saved = await ResponseModel.find({ formId: form._id }).setOptions({ includeTest: true });
      if (saved.length !== responses.length || saved.some(response => !expectedIds.has(String(response._id)))) {
        throw new Error("Unexpected responses found; refusing status repair");
      }
      const expectedById = new Map(responses.map(response => [String(response._id), response]));
      for (const response of saved) {
        const expected = expectedById.get(String(response._id))!;
        if (response.answers.STATUS !== expected.answers.STATUS || response.submittedAt?.getTime() !== expected.submittedAt.getTime()) {
          throw new Error(`CSV status or timestamp mismatch on response ${response._id}`);
        }
      }
      console.log(JSON.stringify({ mode: execute ? "repair-status" : "repair-status-dry-run",
        form: String(form._id), responses: saved.length,
        statuses: Object.fromEntries(csvStages.map(item => [item.csv, saved.filter(response => response.answers.STATUS.trim() === item.csv).length])),
        unspecified: saved.filter(response => !response.answers.STATUS.trim()).length }, null, 2));
      if (execute) {
        let nextOrder = Math.max(...stages.map(item => item.order), -1) + 1;
        for (const item of csvStages) {
          let target = stages.find(stage => stage.name === item.name);
          if (!target) {
            target = await Stage.create({ workspaceId: workspace._id, name: item.name,
              category: item.category, colour: item.colour, order: nextOrder++, isDefault: false });
            stages.push(target);
          } else if (target.category !== item.category) {
            throw new Error(`Stage ${item.name} has an unexpected category`);
          }
          await ResponseModel.updateMany({ formId: form._id, "answers.STATUS": item.csv },
            { $set: { stageId: target._id, status: item.category } });
        }
        const newStage = stages.find(item => item.isDefault && item.category === "new") ?? stages.find(item => item.category === "new");
        if (!newStage) throw new Error("Workspace has no New stage");
        await ResponseModel.updateMany({ formId: form._id, "answers.STATUS": { $in: ["", " "] } },
          { $set: { stageId: newStage._id, status: "new" } });
        console.log("Mapped CSV statuses to workspace response stages.");
      }
      return;
    }
    if (process.argv.includes("--repair-fields") || process.argv.includes("--repair-types")) {
      if (existing !== responses.length) throw new Error("Response count changed; refusing field repair");
      const expectedIds = new Set(responses.map(response => String(response._id)));
      const saved = await ResponseModel.find({ formId: form._id }).setOptions({ includeTest: true });
      if (saved.length !== existing || saved.some(response => !expectedIds.has(String(response._id)))) {
        throw new Error("Unexpected response found; refusing field repair");
      }
      const timestampId = crypto.createHash("sha256").update("kala-chashma-csv:Timestamp").digest("hex").slice(0, 24);
      const fieldIds = new Set(fields.map(field => field.fieldId).concat(timestampId));
      if (form.fields.length !== 40 || form.fields.some(field => !fieldIds.has(field.fieldId!))) {
        throw new Error("Form fields changed; refusing field repair");
      }
      for (const expected of fields) {
        if (!form.fields.some(field => field.fieldId === expected.fieldId)) {
          throw new Error(`Imported field missing: ${expected.label}`);
        }
      }
      const [oldLabel, newLabel] = Object.entries(kalaChasmaCsvLabelOverrides)[0];
      for (const response of saved) {
        const answer = response.answers as Record<string, string>;
        if (answer[oldLabel] !== undefined && answer[newLabel] !== undefined && answer[oldLabel] !== answer[newLabel]) {
          throw new Error(`Conflicting answers on response ${response._id}`);
        }
        if (answer.Timestamp && parsedDate(answer.Timestamp).getTime() !== response.submittedAt?.getTime()) {
          throw new Error(`Timestamp mismatch on response ${response._id}`);
        }
      }
      console.log(JSON.stringify({ mode: execute ? "repair-fields" : "repair-fields-dry-run",
        form: String(form._id), responses: saved.length, formFieldsBefore: form.fields.length,
        formFieldsAfter: fields.length, removedQuestion: "Timestamp",
        shortenedLabel: newLabel, urlFields: fields.filter(field => field.type === "url").length }, null, 2));
      if (execute) {
        for (let i = 0; i < saved.length; i += 20) {
          await Promise.all(saved.slice(i, i + 20).map(async response => {
            const answer = { ...(response.answers as Record<string, string>) };
            if (answer[oldLabel] !== undefined) {
              answer[newLabel] = answer[oldLabel];
              delete answer[oldLabel];
            }
            delete answer.Timestamp;
            response.answers = answer;
            response.searchText = Object.values(answer).join(" ").toLowerCase();
            response.markModified("answers");
            await response.save({ timestamps: false });
          }));
          console.log(`Repaired ${Math.min(i + 20, saved.length)}/${saved.length} responses`);
        }
        for (const expected of fields) {
          const actual = form.fields.find(field => field.fieldId === expected.fieldId)!;
          actual.label = expected.label;
          actual.type = expected.type as typeof actual.type;
          if (expected.helpText) actual.helpText = expected.helpText;
        }
        form.fields = form.fields.filter(field => field.fieldId !== timestampId);
        form.contentVersion = (form.contentVersion ?? 0) + 1;
        await form.save();
        console.log("Updated form labels and fields while preserving response dates.");
      }
      return;
    }
    console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", user: EMAIL,
      workspace: String(workspace._id), form: String(form._id), csvSha256: csvHash,
      csvRows: rows.length, blankRowsSkipped: rows.length - records.length,
      importRows: responses.length, fields: fields.length, existingResponses: existing,
      statusCounts: responses.reduce((acc: Record<string, number>, response) => {
        acc[response.status] = (acc[response.status] || 0) + 1; return acc;
      }, {}),
    }, null, 2));
    if (!execute) return;

    const existingIds = await ResponseModel.collection.find({ formId: form._id }, { projection: { _id: 1 } }).toArray();
    const expectedIds = new Set(responses.map(response => String(response._id)));
    if (existingIds.some(response => !expectedIds.has(String(response._id)))) {
      throw new Error("Form contains unrelated responses; refusing to replace its fields");
    }
    if (existing && existing !== existingIds.length) throw new Error("Unexpected response count mismatch");
    if (existingIds.length === responses.length) {
      const saved = await ResponseModel.find({ formId: form._id }).setOptions({ includeTest: true });
      const expectedById = new Map(responses.map(response => [String(response._id), response]));
      for (const response of saved) {
        const expected = expectedById.get(String(response._id));
        if (!expected || response.submittedAt?.getTime() !== expected.submittedAt.getTime() ||
          response.createdAt?.getTime() !== expected.createdAt.getTime() ||
          response.status !== expected.status || String(response.stageId) !== String(expected.stageId) ||
          Object.keys(expected.answers).some(key => response.answers[key] !== expected.answers[key])) {
          throw new Error(`Imported response differs from CSV: ${response._id}`);
        }
      }
      const mismatchedFields = fields.filter(expected =>
        !form!.fields.some(actual => actual.fieldId === expected.fieldId &&
          actual.label === expected.label && actual.type === expected.type));
      const unexpectedFields = form.fields.filter(actual =>
        !fields.some(expected => expected.fieldId === actual.fieldId));
      if (mismatchedFields.length) {
        throw new Error(`Imported form fields differ from CSV mapping: ${mismatchedFields.map(field => field.label).join(", ")}`);
      }
      console.log(`Verified existing import: ${saved.length} responses, ${fields.length} CSV fields, ${unexpectedFields.length} additional form fields preserved; no changes made.`);
      return;
    }
    if (existingIds.length && form.fields.some(actual =>
      !fields.some(expected => expected.fieldId === actual.fieldId))) {
      throw new Error("Form has additional fields; refusing to replace them during a partial import");
    }
    form.fields = fields as any;
    form.pages = [
      { id: pageOne, order: 0, title: "Film & Contact Details" },
      { id: pageTwo, order: 1, title: "Synopsis, Distribution & Review" },
    ];
    form.contentVersion = (form.contentVersion ?? 0) + 1;
    await form.save();
    const already = new Set(existingIds.map(response => String(response._id)));
    for (let i = 0; i < responses.length; i += 100) {
      const batch = responses.slice(i, i + 100).filter(response => !already.has(String(response._id)));
      if (batch.length) await ResponseModel.insertMany(batch as any[], { ordered: true });
      console.log(`Imported ${Math.min(i + 100, responses.length)}/${responses.length}`);
    }
    await bumpReferenceCounter(form._id as mongoose.Types.ObjectId, responses.length);
    const finalCount = await ResponseModel.countDocuments({ formId: form._id });
    if (finalCount !== responses.length) throw new Error(`Verification failed: ${finalCount} responses found`);
    console.log(`Verified ${finalCount} responses and ${form.fields.length} form fields.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
