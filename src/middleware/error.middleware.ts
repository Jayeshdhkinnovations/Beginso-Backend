import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { Logger } from "../utils/logger";
import { MAX_UPLOAD_MB, MAX_UPLOAD_FILES } from "../utils/uploadLimits";

// Bug fix: Multer's own default messages ("File too large", "Too many files", "Field value too
// long", "Unexpected field", ...) never state the actual configured limit, and the frontend was
// discarding this message entirely for every 400 anyway — showing one hardcoded guess
// ("25 MB / 10 files") regardless of which of Multer's several distinct limit codes actually
// fired. A submission genuinely under both those numbers (confirmed: two files, 4.2MB + 1.1MB)
// still hit this generic text, meaning the real cause was something else Multer rejected
// (e.g. LIMIT_FIELD_VALUE on a text field) and got mislabelled as a file-size problem.
const MULTER_MESSAGES: Record<string, () => string> = {
  LIMIT_FILE_SIZE: () => `A file is larger than the ${MAX_UPLOAD_MB()} MB per-file limit.`,
  LIMIT_FILE_COUNT: () => `Too many files — the limit is ${MAX_UPLOAD_FILES()} files per submission.`,
  LIMIT_FIELD_VALUE: () => "One of the form's field values is too long.",
  LIMIT_UNEXPECTED_FILE: () => "A file was sent for a field that doesn't accept one.",
  LIMIT_PART_COUNT: () => "The submission has too many parts.",
  LIMIT_FIELD_COUNT: () => "The submission has too many fields.",
  LIMIT_FIELD_KEY: () => "One of the form's field names is too long.",
};

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  let statusCode = err.statusCode || 500;
  if (err instanceof mongoose.Error.CastError) statusCode = 400;
  if (err instanceof ZodError) statusCode = 400;
  if (err.name === "FormValidationError") statusCode = 422;
  if (err instanceof mongoose.Error.ValidationError) statusCode = 400;
  if (err.name === "MulterError") statusCode = 400;

  // Never log headers, query or body: they hold cookies, OTP codes, emails and public-form answers.
  const context = { method: req.method, ip: req.ip || "unknown" };
  if (statusCode >= 500) {
    Logger.error("Global Error Interceptor", err, context, req.originalUrl, statusCode);
  } else {
    Logger.warn(`Client Request Warning: ${err.message || "Request failed"}`, context, req.originalUrl, statusCode);
  }

  // Cast Error (invalid ObjectId)
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      success: false,
      message: "Invalid identifier",
      error: { message: "Invalid identifier" }
    });
    return;
  }

  // Zod Validation Error
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: err.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
      error: { message: "Validation failed" }
    });
    return;
  }

  // Form Validation Error (422)
  if (err.name === "FormValidationError") {
    res.status(422).json({
      success: false,
      message: err.message,
      errors: err.errors,
      error: { message: err.message }
    });
    return;
  }

  // Mongoose Validation Error
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      success: false,
      message: err.message,
      error: { message: err.message }
    });
    return;
  }

  // Multer Errors (e.g. LIMIT_FILE_SIZE) — see MULTER_MESSAGES above for why this states the
  // actual configured limit instead of relying on Multer's own terse default text.
  if (err.name === "MulterError") {
    const message = MULTER_MESSAGES[err.code]?.() ?? err.message ?? "File upload error";
    res.status(400).json({
      success: false,
      message,
      error: { message, code: err.code }
    });
    return;
  }

  // Default Error. A 5xx message is internal detail (driver text, duplicate-key values), so it is
  // replaced with a generic one; the real error is in the server log above.
  const publicMessage = statusCode >= 500 ? "Internal Server Error" : err.message || "Request failed";
  res.status(statusCode).json({
    success: false,
    message: publicMessage,
    error: {
      message: publicMessage,
      ...(err.code ? { code: err.code } : {}),
    }
  });
};
