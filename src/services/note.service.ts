import mongoose from "mongoose";
import Note, { INote } from "../models/Note";
import ResponseModel from "../models/Response";
import Form from "../models/Form";
import User from "../models/User";
import Notification from "../models/Notification";
import { userHasAccessToForm } from "../utils/formAccess";
import { logWorkspaceEvent } from "./event.service";

// Sprint 12, BE 0.3 (B5.1/B5.2/B5.3). SECURITY BOUNDARY: nothing in this file is ever imported by
// a public/respondent-facing route (form.controller.ts's getPublicFormBySlug/submitPublicForm/
// recordFormView) or by report.service.ts's export path — none of them import this module or the
// Note model, and this file never populates a Note onto anything those paths return. Keep it that
// way: a note is workspace/grant-visible collaboration data, never respondent- or export-visible.

const notFound = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 404;
  throw err;
};

const forbidden = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 403;
  throw err;
};

// Deliberately generic: whether a mentionId doesn't exist at all, or exists but lacks access to
// this form, must look identical from outside (design.md's 422 requirement).
const invalidMention = (): never => {
  const err: any = new Error("One or more mentions are invalid for this response's form");
  err.statusCode = 422;
  err.code = "INVALID_MENTION";
  throw err;
};

export interface NoteMentionDTO {
  id: string;
  name: string;
}

export interface NoteDTO {
  id: string;
  authorId: string;
  authorName: string;
  authorRemoved: boolean;
  body: string;
  mentions: NoteMentionDTO[];
  createdAt: Date;
  editedAt: Date | null;
}

interface ResolvedResponse {
  response: InstanceType<typeof ResponseModel>;
  form: any;
  workspaceId: string | null;
}

export class NoteService {
  // Resolves and access-checks the response's form in one place, mirroring the pattern every
  // other response-scoped service in this sprint uses (stage.service.ts / tag.service.ts style
  // notFound/forbidden helpers).
  async resolveResponse(responseId: string): Promise<ResolvedResponse> {
    if (!mongoose.Types.ObjectId.isValid(responseId)) notFound("Response not found");
    const response = await ResponseModel.findById(responseId);
    if (!response || response.deletedAt) notFound("Response not found");

    const form = await Form.findById(response!.formId);
    if (!form) notFound("Response not found");

    return { response: response!, form, workspaceId: form!.workspaceId ? form!.workspaceId.toString() : null };
  }

  private async toDTO(note: INote): Promise<NoteDTO> {
    const mentionUsers = note.mentionIds.length
      ? await User.find({ _id: { $in: note.mentionIds } }).select("fullName email").lean()
      : [];
    const mentionById = new Map(mentionUsers.map((u: any) => [u._id.toString(), u]));

    // authorRemoved is recomputed live rather than trusted from the stored (currently
    // never-updated) column — see Note.ts's header comment.
    const authorStillExists = await User.exists({ _id: note.authorId });

    return {
      id: note._id.toString(),
      authorId: note.authorId.toString(),
      authorName: note.authorName,
      authorRemoved: !authorStillExists,
      body: note.body,
      mentions: note.mentionIds.map((id) => {
        const u = mentionById.get(id.toString());
        return { id: id.toString(), name: u?.fullName || u?.email || "Removed member" };
      }),
      createdAt: note.createdAt,
      editedAt: note.editedAt || null,
    };
  }

  async list(responseId: string): Promise<NoteDTO[]> {
    await this.resolveResponse(responseId);
    const notes = await Note.find({ responseId }).sort({ createdAt: 1 });
    return Promise.all(notes.map((n) => this.toDTO(n)));
  }

  // Validates every mentionId is a *current* member with access to this specific form — never
  // trusts the client's picker. Uniform 422 (invalidMention) whether the id doesn't exist at all
  // or exists but lacks access, so the two cases are indistinguishable from outside.
  private async validateMentions(mentionIds: string[], formId: string, workspaceId: string | null): Promise<void> {
    for (const id of mentionIds) {
      const ok = await userHasAccessToForm(id, formId, workspaceId);
      if (!ok) invalidMention();
    }
  }

  private async notifyNewMentions(params: {
    mentionIds: string[];
    previouslyMentionedIds: Set<string>;
    authorId: string;
    authorName: string;
    workspaceId: string | null;
  }): Promise<void> {
    const { mentionIds, previouslyMentionedIds, authorId, authorName, workspaceId } = params;
    if (!workspaceId) return; // no workspace feed/notification target for personal-form responses
    const newlyMentioned = mentionIds.filter((id) => id !== authorId && !previouslyMentionedIds.has(id));
    for (const userId of newlyMentioned) {
      await Notification.create({
        userId,
        workspaceId,
        type: "mention",
        title: "You were mentioned in a note",
        message: `${authorName} mentioned you in a note`,
      }).catch(() => undefined);
    }
  }

  async create(
    responseId: string,
    actor: { id: string; name: string },
    data: { body: string; mentionIds?: string[] }
  ): Promise<NoteDTO> {
    const { form, workspaceId } = await this.resolveResponse(responseId);
    const mentionIds = [...new Set(data.mentionIds || [])];
    await this.validateMentions(mentionIds, form._id.toString(), workspaceId);

    const note = await Note.create({
      responseId,
      authorId: actor.id,
      authorName: actor.name,
      body: data.body,
      mentionIds,
    });

    await this.notifyNewMentions({
      mentionIds,
      previouslyMentionedIds: new Set(),
      authorId: actor.id,
      authorName: actor.name,
      workspaceId,
    });

    if (workspaceId) {
      await logWorkspaceEvent({
        workspaceId,
        actor: { id: actor.id, email: actor.name, name: actor.name },
        action: "response.note_add",
        targetId: responseId,
        targetType: "response",
        targetLabel: responseId,
        metadata: { noteId: note._id.toString() },
      }).catch(() => undefined);
    }

    return this.toDTO(note);
  }

  async update(
    responseId: string,
    noteId: string,
    actorId: string,
    data: { body?: string; mentionIds?: string[] }
  ): Promise<NoteDTO> {
    const { form, workspaceId } = await this.resolveResponse(responseId);
    if (!mongoose.Types.ObjectId.isValid(noteId)) notFound("Note not found");
    const note = await Note.findOne({ _id: noteId, responseId });
    if (!note) notFound("Note not found");

    if (note!.authorId.toString() !== actorId) {
      forbidden("Only the note's author may edit it");
    }

    const previouslyMentionedIds = new Set(note!.mentionIds.map((id) => id.toString()));

    if (data.body !== undefined) note!.body = data.body;

    let mentionIds = previouslyMentionedIds;
    if (data.mentionIds !== undefined) {
      const uniqueNew = [...new Set(data.mentionIds)];
      await this.validateMentions(uniqueNew, form._id.toString(), workspaceId);
      note!.mentionIds = uniqueNew.map((id) => new mongoose.Types.ObjectId(id));
      mentionIds = new Set(uniqueNew);
    }

    note!.editedAt = new Date();
    await note!.save();

    await this.notifyNewMentions({
      mentionIds: [...mentionIds],
      previouslyMentionedIds,
      authorId: actorId,
      authorName: note!.authorName,
      workspaceId,
    });

    return this.toDTO(note!);
  }

  async delete(responseId: string, noteId: string, actor: { id: string; role: string | null }): Promise<void> {
    await this.resolveResponse(responseId);
    if (!mongoose.Types.ObjectId.isValid(noteId)) notFound("Note not found");
    const note = await Note.findOne({ _id: noteId, responseId });
    if (!note) notFound("Note not found");

    const isAuthor = note!.authorId.toString() === actor.id;
    const isAdminOrOwner = actor.role === "owner" || actor.role === "admin";
    if (!isAuthor && !isAdminOrOwner) {
      forbidden("Only the note's author or a workspace Admin/Owner may delete it");
    }

    await Note.deleteOne({ _id: noteId });
  }

  // Batched for list endpoints (B5.x noteCount): one query for the whole page instead of one per row.
  async countsFor(responseIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (responseIds.length === 0) return map;
    const counts = await Note.aggregate([
      { $match: { responseId: { $in: responseIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: "$responseId", count: { $sum: 1 } } },
    ]);
    for (const c of counts) map.set(c._id.toString(), c.count);
    return map;
  }

  async countFor(responseId: string): Promise<number> {
    return Note.countDocuments({ responseId });
  }
}
