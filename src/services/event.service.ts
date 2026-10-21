import mongoose from "mongoose";
import { Event } from "../models/Event";
import { Request } from "express";
import { Logger } from "../utils/logger";
import { hashIp } from "../utils/ip";
import ResponseModel from "../models/Response";

export interface LogEventParams {
  workspaceId: string | mongoose.Types.ObjectId;
  actor: {
    id: string | mongoose.Types.ObjectId | null;
    email: string;
    name: string;
  };
  action: string;
  targetId: string;
  targetType: string;
  targetLabel: string;
  metadata?: Record<string, any>;
  ip?: string;
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// Response events were written with the response's raw id as their label, which the audit log could only show as its last six hex
// characters ("response bulk tag #92E525") instead of the reference people actually see (#49) (QA D8-010). Every caller goes through
// logWorkspaceEvent, so the label is fixed once, here: an id used as a response label becomes the response's reference, or
// "#<last six>" for a response that has none.
export async function eventTargetLabel(targetType: string, targetId: string, label: string): Promise<string> {
  if (targetType !== "response" || !OBJECT_ID.test(label)) return label;
  const short = `#${label.slice(-6).toUpperCase()}`;
  try {
    const found = await ResponseModel.findById(targetId || label).select("reference").lean();
    return (found as { reference?: string } | null)?.reference || short;
  } catch {
    return short;
  }
}

export async function logWorkspaceEvent(params: LogEventParams): Promise<void> {
  try {
    if (!params.workspaceId) {
      return;
    }
    const targetLabel = await eventTargetLabel(params.targetType, params.targetId, params.targetLabel);
    await Event.create({
      workspaceId: params.workspaceId,
      actorId: params.actor.id,
      actorEmail: params.actor.email,
      actorName: params.actor.name || params.actor.email,
      action: params.action,
      targetId: params.targetId,
      targetType: params.targetType,
      targetLabel,
      metadata: params.metadata,
      ip: params.ip,
      createdAt: new Date()
    });
  } catch (error: any) {
    Logger.error(`Failed to log workspace event [${params.action}]`, error);
  }
}

// One-line audit trail for a workspace mutation. Awaited by the caller so the row exists when the
// response is sent; a failure to write it is logged but never fails the user's action.
// Personal (workspace-less) resources have no workspace feed, so they are skipped.
// Deliberately NOT called for form autosave (PATCH fields/title): it fires every few seconds.
export async function recordEvent(
  req: Request,
  workspaceId: any,
  action: string,
  target: { id: any; type: string; label: string },
  metadata?: Record<string, any>,
  actor?: { id?: any; email: string; name?: string }
): Promise<void> {
  const user = (req as any).user;
  const who = actor ?? (user ? { id: user._id, email: user.email, name: user.fullName } : null);
  if (!workspaceId || !who) return;
  await logWorkspaceEvent({
    workspaceId,
    actor: { id: who.id ?? null, email: who.email, name: who.name || who.email },
    action,
    targetId: String(target.id),
    targetType: target.type,
    targetLabel: target.label,
    metadata,
    ip: req.ip ? hashIp(req.ip) : undefined,
  });
}
