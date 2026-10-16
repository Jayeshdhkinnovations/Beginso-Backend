import mongoose from "mongoose";
import Form, { IForm } from "../models/Form";

const CONTENT_KEYS = ["title", "description", "fields", "pages", "branding", "settings"];

export class FormRepository {
  async create(workspaceId: string | null, data: Partial<IForm>): Promise<IForm> {
    return await Form.create({ ...data, workspaceId: workspaceId || null });
  }

  async findById(id: string, workspaceId?: string): Promise<IForm | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new mongoose.Error.CastError("ObjectId", id, "_id");
    }
    const query: any = { _id: id };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }
    return await Form.findOne(query);
  }

  async findOne(query: any, workspaceId?: string): Promise<IForm | null> {
    const finalQuery = { ...query };
    if (workspaceId) {
      finalQuery.workspaceId = workspaceId;
    }
    return await Form.findOne(finalQuery);
  }

  async findWithPagination(
    query: any,
    skip: number,
    limit: number,
    workspaceId?: string,
    sort: Record<string, 1 | -1> = { createdAt: -1 }
  ): Promise<IForm[]> {
    const finalQuery = { ...query };
    if (workspaceId) {
      finalQuery.workspaceId = workspaceId;
    }
    // _id last so equal values (same title, same second) keep one stable order across pages.
    const q = Form.find(finalQuery).sort({ ...sort, _id: sort._id ?? -1 }).skip(skip).limit(limit);
    // Titles sort case-insensitively, the way a person reads a list.
    return await ("title" in sort ? q.collation({ locale: "en", strength: 2 }) : q);
  }

  async count(query: any, workspaceId?: string): Promise<number> {
    const finalQuery = { ...query };
    if (workspaceId) {
      finalQuery.workspaceId = workspaceId;
    }
    return await Form.countDocuments(finalQuery);
  }

  // Builder-owned content: only an update that touches one of these counts as an edit (bumps contentVersion).
  // Status, slug, archive, trash, view counters and the like do not.
  //
  // `expected` makes the write conditional ON THE SAME ATOMIC OPERATION: if another save got in first, no document
  // matches and nothing is written (null). Never read-then-write: that has a race.
  async update(
    id: string,
    workspaceId: string,
    data: Partial<IForm>,
    expected?: { contentVersion: number; saveId?: string }
  ): Promise<IForm | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new mongoose.Error.CastError("ObjectId", id, "_id");
    }
    const query: any = { _id: id };
    if (workspaceId !== undefined && workspaceId !== "") {
      query.workspaceId = workspaceId;
    }
    // A form saved before the counter existed has no field: that is version 0, and $inc creates it.
    if (expected) query.contentVersion = expected.contentVersion === 0 ? { $in: [0, null] } : expected.contentVersion;
    const isEdit = CONTENT_KEYS.some((k) => k in data);
    const update = isEdit
      ? { ...data, ...(expected?.saveId ? { lastSaveId: expected.saveId } : {}), $inc: { contentVersion: 1 } }
      : data;
    return await Form.findOneAndUpdate(query, update, { returnDocument: "after" });
  }

  async delete(id: string, workspaceId: string): Promise<IForm | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new mongoose.Error.CastError("ObjectId", id, "_id");
    }
    const query: any = { _id: id };
    if (workspaceId !== undefined && workspaceId !== "") {
      query.workspaceId = workspaceId;
    }
    return await Form.findOneAndDelete(query);
  }
}
