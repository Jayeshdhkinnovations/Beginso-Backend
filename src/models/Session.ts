import { keyedHash } from "../utils/pepper";
import mongoose, { Schema, Document } from "mongoose";
import crypto from "crypto";

export interface ILocation {
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId;
  deviceLabel: string;
  userAgent: string;
  approxLocation?: ILocation;
  ipHash: string;
  lastActiveAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Utility to compute a keyed hash (first 16 chars) of an IP address.
 * Raw IP address is NEVER stored on Session or User models.
 */
export const hashIpAddress = (ip: string): string => {
  if (!ip) return "";
  return keyedHash(ip.trim()).slice(0, 16);
};

const SessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    deviceLabel: {
      type: String,
      required: true,
      default: "Unknown Device",
    },
    userAgent: {
      type: String,
      default: "Unknown User-Agent",
    },
    approxLocation: {
      city: String,
      region: String,
      country: String,
      latitude: Number,
      longitude: Number,
    },
    ipHash: {
      type: String,
      required: true,
      index: true,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    revokedAt: {
      type: Date,
      index: true,
    },
  },
  { timestamps: true }
);

SessionSchema.index({ userId: 1, revokedAt: 1, lastActiveAt: -1 });

const SessionModel = mongoose.model<ISession>("Session", SessionSchema);
export default SessionModel;
