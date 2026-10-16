// Why a public form is not accepting responses. Only states the form's OWNER chose, and that a respondent holding the
// link is entitled to know, get their own answer: HTTP 410 with a stable `error.code`. Everything else (draft,
// archived, unknown slug, an owner past their storage ceiling) stays an indistinguishable 404, so a link never
// confirms that a draft exists or reveals anything about the owner's account (Requirement 7.4).
export const FORM_CLOSED = "FORM_CLOSED";
export const FORM_CLOSE_DATE_PASSED = "FORM_CLOSE_DATE_PASSED";
export const FORM_RESPONSE_LIMIT_REACHED = "FORM_RESPONSE_LIMIT_REACHED";

export type FormClosedCode = typeof FORM_CLOSED | typeof FORM_CLOSE_DATE_PASSED | typeof FORM_RESPONSE_LIMIT_REACHED;

const MESSAGES: Record<FormClosedCode, string> = {
  FORM_CLOSED: "This form is closed and no longer accepts responses.",
  FORM_CLOSE_DATE_PASSED: "This form's closing date has passed.",
  FORM_RESPONSE_LIMIT_REACHED: "This form has reached its response limit.",
};

export const formClosedError = (code: FormClosedCode): Error => {
  const err: any = new Error(MESSAGES[code]);
  err.statusCode = 410;
  err.code = code;
  return err;
};

export const formNotFoundError = (): Error => {
  const err: any = new Error("Form not found");
  err.statusCode = 404;
  return err;
};
