import mongoose from "mongoose";
import TagModel, { ITag } from "../models/Tag";
import ResponseModel from "../models/Response";

const notFound = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 404;
  throw err;
};

const conflict = (message: string, code: string): never => {
  const err: any = new Error(message);
  err.statusCode = 409;
  err.code = code;
  throw err;
};

const badRequest = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 400;
  throw err;
};

export interface ITagWithUsage {
  // `id` is what the frontend's `Tag` type actually reads (TagPicker's key/selection, the
  // create/select payloads) — `_id` kept alongside for any caller still on the raw Mongoose
  // field name. Missing `id` here was silently sending `tagIds: [undefined]` on every tag
  // selection, which the backend's own validator correctly rejected with a 422.
  id: string;
  _id: string;
  workspaceId: string;
  name: string;
  colour: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const toDTO = (tag: ITag, usageCount: number): ITagWithUsage => ({
  id: tag._id.toString(),
  _id: tag._id.toString(),
  workspaceId: tag.workspaceId.toString(),
  name: tag.name,
  colour: tag.colour,
  usageCount,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

export class TagService {
  async listTags(workspaceId: string): Promise<ITagWithUsage[]> {
    const tags = await TagModel.find({ workspaceId }).sort({ name: 1 });
    if (tags.length === 0) return [];

    const counts = await ResponseModel.aggregate([
      { $match: { tagIds: { $in: tags.map((t) => t._id) }, deletedAt: null } },
      { $unwind: "$tagIds" },
      { $group: { _id: "$tagIds", count: { $sum: 1 } } },
    ]);
    const countByTag = new Map<string, number>(counts.map((c: any) => [c._id.toString(), c.count]));

    return tags.map((t) => toDTO(t, countByTag.get(t._id.toString()) || 0));
  }

  async getTagInWorkspace(workspaceId: string, tagId: string): Promise<ITag> {
    if (!mongoose.Types.ObjectId.isValid(tagId)) notFound("Tag not found");
    const tag = await TagModel.findOne({ _id: tagId, workspaceId });
    if (!tag) notFound("Tag not found");
    return tag!;
  }

  private async assertNameAvailable(workspaceId: string, name: string, excludeTagId?: string): Promise<void> {
    const nameLower = name.trim().toLowerCase();
    const existing = await TagModel.findOne({
      workspaceId,
      nameLower,
      ...(excludeTagId ? { _id: { $ne: excludeTagId } } : {}),
    }).lean();
    if (existing) {
      conflict(`A tag named '${name}' already exists in this workspace`, "TAG_NAME_TAKEN");
    }
  }

  async createTag(workspaceId: string, data: { name: string; colour: string }): Promise<ITagWithUsage> {
    await this.assertNameAvailable(workspaceId, data.name);
    try {
      const tag = await TagModel.create({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        name: data.name,
        colour: data.colour,
      });
      return toDTO(tag, 0);
    } catch (err: any) {
      // Race with the unique index backstop (two concurrent creates of the same name).
      if (err?.code === 11000) conflict(`A tag named '${data.name}' already exists in this workspace`, "TAG_NAME_TAKEN");
      throw err;
    }
  }

  async updateTag(
    workspaceId: string,
    tagId: string,
    data: { name?: string; colour?: string }
  ): Promise<ITagWithUsage> {
    const tag = await this.getTagInWorkspace(workspaceId, tagId);
    if (data.name !== undefined && data.name.trim().toLowerCase() !== tag.nameLower) {
      await this.assertNameAvailable(workspaceId, data.name, tagId);
    }
    if (data.name !== undefined) tag.name = data.name;
    if (data.colour !== undefined) tag.colour = data.colour;
    try {
      await tag.save();
    } catch (err: any) {
      if (err?.code === 11000) conflict(`A tag named '${data.name}' already exists in this workspace`, "TAG_NAME_TAKEN");
      throw err;
    }
    const usageCount = await ResponseModel.countDocuments({ tagIds: tag._id, deletedAt: null });
    return toDTO(tag, usageCount);
  }

  // Detaches the tag from every response before deleting it, and reports usageCount as it stood
  // before delete so the caller can see what was affected.
  async deleteTag(workspaceId: string, tagId: string): Promise<{ usageCount: number }> {
    const tag = await this.getTagInWorkspace(workspaceId, tagId);
    const usageCount = await ResponseModel.countDocuments({ tagIds: tag._id });
    await ResponseModel.updateMany({ tagIds: tag._id }, { $pull: { tagIds: tag._id } });
    await TagModel.deleteOne({ _id: tag._id });
    return { usageCount };
  }

  // Atomically reassigns every response tagged with `tagId` onto `intoTagId`, then removes the
  // now-empty source tag. Uses $addToSet+$pull so a response already carrying both tags does not
  // end up with a duplicate.
  async mergeTag(workspaceId: string, tagId: string, intoTagId: string): Promise<{ mergedCount: number; into: ITagWithUsage }> {
    const source = await this.getTagInWorkspace(workspaceId, tagId);
    const target = await this.getTagInWorkspace(workspaceId, intoTagId);
    if (source._id.toString() === target._id.toString()) {
      badRequest("into must be a different tag");
    }

    const session = await mongoose.startSession();
    let mergedCount = 0;
    try {
      await session.withTransaction(async () => {
        const affected = await ResponseModel.find({ tagIds: source._id }).select("_id").session(session);
        mergedCount = affected.length;

        if (mergedCount > 0) {
          await ResponseModel.updateMany(
            { tagIds: source._id },
            { $addToSet: { tagIds: target._id } },
            { session }
          );
          await ResponseModel.updateMany(
            { tagIds: source._id },
            { $pull: { tagIds: source._id } },
            { session }
          );
        }

        await TagModel.deleteOne({ _id: source._id }, { session });
      });
    } finally {
      await session.endSession();
    }

    const usageCount = await ResponseModel.countDocuments({ tagIds: target._id, deletedAt: null });
    return { mergedCount, into: toDTO(target, usageCount) };
  }
}
