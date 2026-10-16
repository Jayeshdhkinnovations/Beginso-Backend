// Optimistic concurrency for form saves. A client sends the updatedAt it last saw (`expectedUpdatedAt`); if the
// stored form has moved on, the save is refused with 409 FORM_STALE instead of silently overwriting the newer data.
export const FORM_STALE = "FORM_STALE";

export const staleFormError = (currentUpdatedAt: Date | string | undefined): Error => {
  const err: any = new Error("This form was changed somewhere else. Reload it before saving again.");
  err.statusCode = 409;
  err.code = FORM_STALE;
  err.currentUpdatedAt = currentUpdatedAt ? new Date(currentUpdatedAt).toISOString() : null;
  return err;
};

/** True when the stored timestamp differs from the one the client based its edit on (millisecond precision). */
export const isStaleWrite = (stored: Date | string | undefined, expected: Date): boolean =>
  !stored || new Date(stored).getTime() !== expected.getTime();

/** The 409 body: same envelope as every other error, plus the current updatedAt so the client can show/refresh. */
export const staleFormBody = (err: any) => ({
  success: false,
  message: err.message,
  error: { code: FORM_STALE, message: err.message },
  updatedAt: err.currentUpdatedAt ?? null,
});
