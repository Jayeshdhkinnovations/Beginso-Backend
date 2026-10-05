import { ACCESS_MODE_VALUES, AccessMode } from "../models/Form";

// Sprint 13 (D1.1). A form with no stored accessMode is Mode 1 ("open") - what every form created before
// Sprint 13 is. Read it through this helper everywhere; never `form.settings.accessMode` directly.
export const getAccessMode = (form: { settings?: { accessMode?: string | null } | null }): AccessMode => {
  const value = form.settings?.accessMode;
  return ACCESS_MODE_VALUES.includes(value as AccessMode) ? (value as AccessMode) : "open";
};

// Mode for forms created from now on. OQ-9: the feature list says Mode 2 ("tracked") is the default, but
// a tracked form refuses a submission without an email address, and the public form only learns to ask
// for one when the frontend's Mode 2 step ships. Until then new forms default to "open" so nobody is
// locked out of a brand-new form. Flip it with NEW_FORM_ACCESS_MODE=tracked once the frontend is live.
export const defaultAccessModeForNewForms = (): AccessMode => {
  const configured = process.env.NEW_FORM_ACCESS_MODE;
  return ACCESS_MODE_VALUES.includes(configured as AccessMode) ? (configured as AccessMode) : "open";
};
