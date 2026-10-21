import { z } from "zod";
import mongoose from "mongoose";
import { RESPONSE_LAYOUTS, RESPONSE_DENSITIES } from "../models/ResponseViewDefault";

// Allow-lists, and strict objects: an unknown key (or a layout that does not exist, such as "sections" or "form") is a 400,
// never silently stored. Phase 1 stores exactly these four display settings.
const settings = {
  layout: z.enum(RESPONSE_LAYOUTS),
  density: z.enum(RESPONSE_DENSITIES),
  showEmpty: z.boolean(),
  showNumbers: z.boolean(),
};

const scope = z.string().refine((v) => v === "all" || mongoose.Types.ObjectId.isValid(v), "scope must be 'all' or a form id");

export const personalViewSchema = z.strictObject({ scope, ...settings });
export const formDefaultSchema = z.strictObject({ expectedVersion: z.number().int().min(0), ...settings });
export const clearScopeSchema = z.object({ scope });
