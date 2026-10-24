import { z } from "zod";
import { MAX_TABLE_COLUMNS, OPENS_AS, RESPONSE_SORTS, ROW_HEIGHTS, TABLE_BUILTIN_COLUMNS } from "../models/ResponseSetup";

export const MAX_FORM_STAGES = 12;

const stageSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1, "A stage needs a name").max(60),
  colour: z.string().trim().min(1).max(40),
  category: z.enum(["new", "in_progress", "completed"]),
});

const columnKey = z
  .string()
  .trim()
  .refine((k) => (TABLE_BUILTIN_COLUMNS as readonly string[]).includes(k) || /^q:[A-Za-z0-9_-]{1,80}$/.test(k), "Unknown column");

/** PUT /api/forms/:formId/response-setup: the whole setup in one save, because the panel saves in one step. */
export const responseSetupSchema = z
  .object({
    /** The version the editor loaded (0 = the form has never been customised). A different current version means someone saved first. */
    version: z.number().int().min(0),
    stages: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("workspace") }),
      z.object({
        mode: z.literal("own"),
        stages: z.array(stageSchema).min(1, "A form needs at least one stage").max(MAX_FORM_STAGES),
        /** Position, in `stages`, of the stage new responses start in. */
        startIndex: z.number().int().min(0).optional(),
      }),
    ]),
    tableColumns: z.array(columnKey).min(1, "Show at least one column").max(MAX_TABLE_COLUMNS),
    cardTitle: z.string().trim().min(1).max(80),
    opensAs: z.enum(OPENS_AS),
    sort: z.enum(RESPONSE_SORTS),
    respondentFrom: z.string().trim().min(1).max(80),
    rowHeight: z.enum(ROW_HEIGHTS),
    wrap: z.boolean(),
  })
  .refine((v) => new Set(v.tableColumns).size === v.tableColumns.length, { message: "A column can only be shown once", path: ["tableColumns"] })
  .refine((v) => v.stages.mode !== "own" || v.stages.startIndex === undefined || v.stages.startIndex < v.stages.stages.length, {
    message: "startIndex is not one of the stages",
    path: ["stages", "startIndex"],
  });

export type ResponseSetupInput = z.infer<typeof responseSetupSchema>;
