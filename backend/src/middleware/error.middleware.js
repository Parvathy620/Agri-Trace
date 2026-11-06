const { env } = require("../config/env");

/**
 * 404 Not Found Middleware for unmapped API routes.
 */
function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    error: {
      message: `Endpoint not found: ${req.method} ${req.originalUrl}`,
      code: "NOT_FOUND",
    },
  });
}

/**
 * Centralized Global Error-Handling Middleware.
 * Standardizes error envelopes and prevents leaking stack traces in production.
 */
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || err.status || 500;
  let errorCode = err.code || "INTERNAL_SERVER_ERROR";
  let message = err.message || "An unexpected error occurred";

  // Handle CORS origin rejection
  if (err.code === "CORS_ORIGIN_FORBIDDEN" || (err.message && err.message.includes("CORS"))) {
    statusCode = 403;
    errorCode = "CORS_ORIGIN_FORBIDDEN";
  }

  // Handle Joi validation errors
  if (err.isJoi || (err.details && Array.isArray(err.details))) {
    statusCode = 422;
    errorCode = "VALIDATION_ERROR";
    message = err.details.map((d) => d.message).join(", ");
  }

  // Handle standard JSON syntax errors from body-parser
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    statusCode = 400;
    errorCode = "INVALID_JSON";
    message = "Malformed JSON payload";
  }

  // Format standard response envelope
  const response = {
    success: false,
    error: {
      message,
      code: errorCode,
    },
  };

  if (err.details) {
    try {
      response.error.details = JSON.parse(
        JSON.stringify(err.details, (k, v) => (typeof v === "bigint" ? v.toString() : v))
      );
    } catch (_) {
      response.error.details = err.details;
    }
  }

  // Include stack trace only in development and test environments
  if (env.NODE_ENV !== "production" && err.stack) {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = {
  notFoundHandler,
  errorHandler,
};

