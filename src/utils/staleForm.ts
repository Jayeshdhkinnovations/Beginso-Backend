// Optimistic concurrency for form saves. A client sends the `contentVersion` it based its edit on
// (`expectedContentVersion`); if the stored form has moved on, the save is refused with 409 FORM_STALE instead of
// silently overwriting the newer data.
//
// Why a dedicated counter and not `updatedAt`: updatedAt moves for reasons that have nothing to do with the builder
// (a respondent opening the public form bumps viewsCount, a response limit auto-closes the form, an archive or a new
// link). Each of those would have shown the owner a false "changed elsewhere". `contentVersion` is incremented ONLY by
// a save that changes builder content (see CONTENT_KEYS in form.repository.ts).
export const FORM_STALE = "FORM_STALE";

export const staleFormError = (currentContentVersion: number | undefined | null): Error => {
  const err: any = new Error("This form was changed somewhere else. Reload it before saving again.");
  err.statusCode = 409;
  err.code = FORM_STALE;
  err.currentContentVersion = currentContentVersion ?? 0;
  return err;
};

/** A form saved before this existed has no counter: that is version 0. */
export const versionOf = (form: { contentVersion?: number | null } | null | undefined): number => form?.contentVersion ?? 0;

/** The 409 body: same envelope as every other error, plus the current version so the client can show/refresh. */
export const staleFormBody = (err: any) => ({
  success: false,
  message: err.message,
  error: { code: FORM_STALE, message: err.message },
  contentVersion: err.currentContentVersion ?? 0,
});
