import crypto from "crypto";
import Invitation from "../models/Invitation";

// Invitation links carry a random 256-bit token. Only its SHA-256 is stored, so a database leak
// or a read-only admin cannot turn pending invitations into working links. (A fast hash is right
// here: the token is random, not a password, so there is nothing to brute-force.)
export const hashInvitationToken = (raw: string): string => crypto.createHash("sha256").update(raw).digest("hex");

export const newInvitationToken = (): { raw: string; hash: string } => {
  const raw = crypto.randomBytes(32).toString("hex");
  return { raw, hash: hashInvitationToken(raw) };
};

// Also matches invitations stored before hashing existed (they still hold the plain `token`).
export const findInvitationByToken = (raw: string) =>
  Invitation.findOne({ $or: [{ tokenHash: hashInvitationToken(raw) }, { token: raw }] });

// What an API response may show of an invitation: never the token or its hash.
export const publicInvitation = (inv: any) => {
  const obj = typeof inv?.toObject === "function" ? inv.toObject() : { ...inv };
  delete obj.token;
  delete obj.tokenHash;
  return obj;
};
