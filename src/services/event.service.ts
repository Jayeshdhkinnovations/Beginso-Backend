import mongoose from "mongoose";
import { Event } from "../models/Event";
import { Logger } from "../utils/logger";

export interface LogEventParams {
  workspaceId: string | mongoose.Types.ObjectId;
  actor: {
    id: string | mongoose.Types.ObjectId;
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

export async function logWorkspaceEvent(params: LogEventParams): Promise<void> {
  try {
    if (!params.workspaceId) {
      return;
    }
    await Event.create({
      workspaceId: params.workspaceId,
      actorId: params.actor.id,
      actorEmail: params.actor.email,
      actorName: params.actor.name || params.actor.email,
      action: params.action,
      targetId: params.targetId,
      targetType: params.targetType,
      targetLabel: params.targetLabel,
      metadata: params.metadata,
      ip: params.ip,
      createdAt: new Date()
    });
  } catch (error: any) {
    Logger.error(`Failed to log workspace event [${params.action}]`, error);
  }
}
