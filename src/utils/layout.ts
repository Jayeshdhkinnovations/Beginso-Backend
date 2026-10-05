import { FormLayout } from "../models/Form";

// Sprint 13 (CF2.7, OQ-2 default). The three V1 layout values stay accepted on read and write; the
// public GET and the builder always see the normalised preset. No data migration is needed - a stored
// legacy value is simply mapped when it is read.
export type LayoutPreset = "classic" | "card_stack" | "guided" | "steps" | "split_feature" | "compact";

export const normaliseLayout = (value?: string | null): LayoutPreset => {
  switch (value as FormLayout | undefined) {
    case "card_stack":
    case "guided":
    case "steps":
    case "split_feature":
    case "compact":
    case "classic":
      return value as LayoutPreset;
    case "two_column":
      return "compact";
    default:
      return "classic"; // "single_column", missing, or anything unrecognised
  }
};
