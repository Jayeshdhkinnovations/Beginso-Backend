import mongoose from "mongoose";
import ResponseModel from "../models/Response";
import FormModel from "../models/Form";
import { BOARD_SORT } from "../repositories/response.repository";

// Ranks are spaced this far apart so a card can be dropped between two neighbours many times before the gap runs out.
const SPACING = 1000;
const MIN_GAP = 1e-6;

const fail = (statusCode: number, message: string): never => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

/**
 * The rank for a card that sits between `above` and `below` (either may be missing: top or bottom of the column).
 * Pure so the rule can be tested on its own.
 */
export function rankBetween(above: number | null | undefined, below: number | null | undefined): number {
  if (above == null && below == null) return 0;
  if (above == null) return (below as number) - SPACING;
  if (below == null) return above + SPACING;
  return (above + below) / 2;
}

/**
 * Puts one response at a chosen place in its Board column. The caller names the card that ends up directly above (`afterId`) or
 * directly below (`beforeId`); neither means the top. The response must already be in the column's stage (the stage change is a
 * separate PATCH), and the column is the form's cards in that stage, in the Board's order.
 *
 * Cards never placed by hand have no rank. If either neighbour has none, the whole column is numbered once in its current order
 * (so nothing visibly moves) and the new rank is worked out from those numbers.
 */
export async function placeOnBoard(
  workspaceId: string | null,
  callerUserId: string,
  responseId: string,
  where: { beforeId?: string | null; afterId?: string | null }
): Promise<{ id: string; boardRank: number | null }> {
  if (!mongoose.Types.ObjectId.isValid(responseId)) return fail(404, "Response not found");
  const response = await ResponseModel.findById(responseId);
  if (!response || response.deletedAt) return fail(404, "Response not found");

  const form: any = await FormModel.findById(response.formId);
  const owned = !!form && (workspaceId ? form.workspaceId?.toString() === workspaceId : !form.workspaceId && String(form.createdBy) === callerUserId);
  if (!owned) return fail(403, "Forbidden: You do not own this response's workspace");

  const above = where.afterId || null;
  const below = where.beforeId || null;
  for (const id of [above, below]) if (id && !mongoose.Types.ObjectId.isValid(id)) return fail(422, "Unknown neighbouring response");

  const column = {
    formId: response.formId,
    deletedAt: null,
    _id: { $ne: response._id },
    ...(response.stageId ? { stageId: response.stageId } : { status: response.status, stageId: null }),
  };
  const siblings = await ResponseModel.find(column).sort(BOARD_SORT).select("_id boardRank").lean();

  let index: number; // where the card goes in `siblings` (as the list of cards it is placed among)
  if (above) {
    const at = siblings.findIndex((s) => String(s._id) === above);
    if (at === -1) return fail(422, "The response above is not in this column");
    index = at + 1;
  } else if (below) {
    const at = siblings.findIndex((s) => String(s._id) === below);
    if (at === -1) return fail(422, "The response below is not in this column");
    index = at;
  } else {
    // The top: no rank, which the Board's order already puts above every placed card.
    await ResponseModel.updateOne({ _id: response._id }, { $unset: { boardRank: "" } });
    return { id: responseId, boardRank: null };
  }

  const ranks: Array<number | null | undefined> = siblings.map((s) => s.boardRank);
  const prev = () => ranks[index - 1];
  const next = () => ranks[index];
  const gapTooSmall = () => prev() != null && next() != null && (next() as number) - (prev() as number) < MIN_GAP;
  if ((index > 0 && prev() == null) || (index < ranks.length && next() == null) || gapTooSmall()) {
    ranks.forEach((_, i) => (ranks[i] = (i + 1) * SPACING));
    await ResponseModel.bulkWrite(siblings.map((s, i) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { boardRank: ranks[i] } } } })));
  }

  const boardRank = rankBetween(index > 0 ? prev() : null, index < ranks.length ? next() : null);
  await ResponseModel.updateOne({ _id: response._id }, { $set: { boardRank } });
  return { id: responseId, boardRank };
}
