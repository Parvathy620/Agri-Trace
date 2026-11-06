const { env } = require("./env");

/**
 * Parses and extracts normalized origins from a comma-separated origin string.
 * @param {string} [corsOriginEnv] - Comma-separated list of origins.
 * @returns {string[]} Array of trimmed origin strings.
 */
function getAllowedOrigins(corsOriginEnv) {
  const raw = arguments.length === 0 ? env.CORS_ORIGIN : corsOriginEnv;
  if (!raw || typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Creates cors middleware options supporting explicit origin allowlists,
 * mobile app non-origin requests, and safe fallback handling.
 * @param {Object} [options]
 * @param {string} [options.corsOrigin] - Comma-separated origin list override.
 * @param {string} [options.nodeEnv] - NODE_ENV override.
 * @returns {import("cors").CorsOptions}
 */
function createCorsOptions(options = {}) {
  const nodeEnv = options.nodeEnv || env.NODE_ENV || "development";
  const rawOrigins = options.corsOrigin !== undefined ? options.corsOrigin : env.CORS_ORIGIN;
  const allowedOrigins = getAllowedOrigins(rawOrigins);

  return {
    origin: (origin, callback) => {
      // 1. Allow non-browser requests with no origin header (mobile apps, curl, Postman, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      // 2. In non-production, if wildcard '*' is explicitly specified, allow all
      if (nodeEnv !== "production" && allowedOrigins.includes("*")) {
        return callback(null, true);
      }

      // 3. Match against configured origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // 4. Reject unauthorized origins with HTTP 403 Forbidden
      const err = new Error(`Origin '${origin}' is not authorized by CORS policy`);
      err.status = 403;
      err.code = "CORS_ORIGIN_FORBIDDEN";
      return callback(err);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Idempotency-Key"],
    credentials: true,
  };
}

module.exports = {
  getAllowedOrigins,
  createCorsOptions,
};
