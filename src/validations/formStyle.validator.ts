import { z } from "zod";
import { FORM_LAYOUT_VALUES, FormLayout } from "../models/Form";
import { brandingSchema } from "./form.validator";

// A saved style keeps the look of a form and nothing that belongs to one form: no logo, no icon, no header text or links, no uploaded picture.
// A cover or page background may only be one of the app's own library pictures (a fixed path), never an upload or an outside address.
const builtInPicture = z
  .string()
  .trim()
  .regex(/^\/form-pictures\/[a-z0-9-]{1,40}\.jpg$/, "must be one of the built-in pictures")
  .optional();

export const styleBrandingSchema = brandingSchema
  .omit({ logoUrl: true, bannerText: true, bannerLinks: true, iconName: true, iconColor: true, coverImageUrl: true, backgroundImageUrl: true })
  .extend({ coverImageUrl: builtInPicture, backgroundImageUrl: builtInPicture });

const styleName = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(60, "name cannot exceed 60 characters");

export const createFormStyleSchema = z.object({
  name: styleName,
  layout: z.enum(FORM_LAYOUT_VALUES as [FormLayout, ...FormLayout[]]),
  branding: styleBrandingSchema,
});

export const renameFormStyleSchema = z.object({ name: styleName });
