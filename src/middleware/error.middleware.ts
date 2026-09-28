import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { Logger } from "../utils/logger";

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

  // Multer Errors (e.g. LIMIT_FILE_SIZE)
  if (err.name === "MulterError") {
    res.status(400).json({
      success: false,
      message: err.message || "File upload error",
      error: { message: err.message || "File upload error", code: err.code }
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
