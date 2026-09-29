import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { NoteService } from "../services/note.service";
import { noteBodySchema } from "../validations/note.validator";

const noteService = new NoteService();

const sendError = (res: Response, error: any): void => {
  if (error instanceof ZodError) {
    res.status(422).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
      error: { message: "Validation failed" },
    });
    return;
  }
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
    error: { code: error.code, message: error.message || "Internal server error" },
  });
};

export const listNotes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const notes = await noteService.list(String(id));
    res.status(200).json({ success: true, notes, data: notes, total: notes.length });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};

export const createNote = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id } = req.params;
    const parsed = noteBodySchema.parse(req.body);
    const note = await noteService.create(
      String(id),
      { id: authReq.user._id.toString(), name: authReq.user.fullName || authReq.user.email },
      parsed
    );
    res.status(201).json({ success: true, message: "Note created", note, data: note });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const updateNote = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id, noteId } = req.params;
    const parsed = noteBodySchema.partial().parse(req.body);
    if (parsed.body === undefined && parsed.mentionIds === undefined) {
      res.status(422).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "body", message: "Either body or mentionIds is required" }],
        error: { message: "Validation failed" },
      });
      return;
    }
    const note = await noteService.update(String(id), String(noteId), authReq.user._id.toString(), parsed);
    res.status(200).json({ success: true, message: "Note updated", note, data: note });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const deleteNote = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id, noteId } = req.params;
    await noteService.delete(String(id), String(noteId), {
      id: authReq.user._id.toString(),
      role: authReq.workspaceRole || null,
    });
    res.status(204).send();
  } catch (error: any) {
    sendError(res, error);
  }
};
