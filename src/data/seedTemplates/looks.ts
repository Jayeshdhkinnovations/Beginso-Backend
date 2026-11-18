// The Looks the templates use. They are NOT defined here: the one source is src/data/formLooks.json (also served by GET /api/form-looks), so a
// template and its Look cannot drift apart. This file only gives them the shape the template builders expect (legacy keys + branding.theme).
import { lookById } from "../../utils/formLooks";

export type LookId =
  | "clean_corporate"
  | "warm_friendly"
  | "elegant_serif"
  | "bold_event"
  | "playful_bright"
  | "calm_care"
  | "minimal_paper"
  | "dark_tech"
  | "editorial"
  | "appetite";

export interface Look {
  id: LookId;
  name: string;
  goodFor: string;
  /** Default layout for templates that use this Look (a template may override it). */
  layout: string;
  /** The branding keys that are not the theme (colours, font, card, background). */
  legacy: Record<string, any>;
  /** branding.theme, version 1. */
  theme: Record<string, any>;
}

/** The id each Look has in formLooks.json. */
export const LOOK_FILE_ID: Record<LookId, string> = {
  clean_corporate: "clean-corporate",
  warm_friendly: "warm-friendly",
  elegant_serif: "elegant-serif",
  bold_event: "bold-event",
  playful_bright: "playful-bright",
  calm_care: "calm-care",
  minimal_paper: "minimal-paper",
  dark_tech: "dark-tech",
  editorial: "editorial-split",
  appetite: "appetite",
};

function fromFile(id: LookId): Look {
  const l = lookById(LOOK_FILE_ID[id]);
  const { theme, ...legacy } = JSON.parse(JSON.stringify(l.branding));
  return { id, name: l.name, goodFor: l.goodFor, layout: l.layout, legacy, theme };
}

export const LOOKS = Object.fromEntries((Object.keys(LOOK_FILE_ID) as LookId[]).map((id) => [id, fromFile(id)])) as Record<LookId, Look>;
