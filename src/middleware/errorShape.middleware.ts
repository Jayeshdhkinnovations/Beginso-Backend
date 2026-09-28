import { Request, Response, NextFunction } from "express";

// Every failed response has the same envelope: { success: false, message, error: { message, code? } }.
// Many handlers were written one at a time and return only `message`, or a bare string in `error`.
// Clients read `error.message`, so it is filled in here, once, instead of in every handler.
export const normalizeErrorShape = (_req: Request, res: Response, next: NextFunction): void => {
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body) && body.success === false) {
      const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "Request failed";
      if (typeof body.error === "string") {
        body = { ...body, error: { message: body.error } };
      } else if (!body.error) {
        body = { ...body, error: { message } };
      } else if (typeof body.error === "object" && typeof body.error.message !== "string" && !Array.isArray(body.error)) {
        // e.g. a Zod `format()` tree: keep it as `details`, add the message clients expect
        body = { ...body, error: { message, details: body.error } };
      }
      if (typeof body.message !== "string") body = { ...body, message };
    }
    return json(body);
  }) as Response["json"];
  next();
};
