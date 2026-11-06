const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { env: defaultEnv } = require("./config/env");
const { admin } = require("./config/firebase");
const { createCorsOptions } = require("./config/cors");
const authRouter = require("./routes/auth.routes");
const batchRouter = require("./routes/batch.routes");
const { notFoundHandler, errorHandler } = require("./middleware/error.middleware");

/**
 * Creates and configures the Express application instance.
 * Accepts an optional configuration object to support isolated testing across environments.
 * @param {Object} [customEnv] - Environment configuration override
 * @returns {express.Application}
 */
function createApp(customEnv = defaultEnv) {
  const app = express();
  const currentEnv = customEnv.NODE_ENV || "development";

  // Security Headers
  app.use(helmet());

  // Cross-Origin Resource Sharing with explicit origin allowlist
  app.use(
    cors(
      createCorsOptions({
        corsOrigin: customEnv.CORS_ORIGIN,
        nodeEnv: currentEnv,
      })
    )
  );

  // Standard JSON Body Parsing with safe limit
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  // Basic Rate Limiting
  const limiter = rateLimit({
    windowMs: customEnv.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
    max: customEnv.RATE_LIMIT_MAX || 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        message: "Too many requests from this client, please try again later",
        code: "RATE_LIMIT_EXCEEDED",
      },
    },
    // Skip rate limiting in test environment
    skip: () => currentEnv === "test",
  });

  app.use("/api/", limiter);

  // ==============================================================================
  // Health Check Endpoint
  // ==============================================================================
  app.get("/api/v1/health", (req, res) => {
    // Distinguish 'configured' vs 'unavailable'.
    // Do NOT report 'connected' merely because the SDK or provider is initialized locally.
    const isFirebaseConfigured = Boolean(customEnv.FIREBASE_PROJECT_ID && admin.apps.length > 0);
    const isBlockchainConfigured = Boolean(
      customEnv.BLOCKCHAIN_RPC_URL && customEnv.CHAIN_ID && customEnv.AGRITRACE_CONTRACT_ADDRESS
    );

    const firebaseStatus = isFirebaseConfigured ? "configured" : "unavailable";
    const blockchainStatus = isBlockchainConfigured ? "configured" : "unavailable";
    const isHealthy = isFirebaseConfigured && isBlockchainConfigured;
    const overallStatus = isHealthy ? "healthy" : "degraded";
    const statusCode = isHealthy ? 200 : 503;

    // Production response: only general service health, no internal details
    if (currentEnv === "production") {
      return res.status(statusCode).json({
        success: isHealthy,
        data: {
          status: overallStatus,
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor(process.uptime()),
          version: "1.0.0",
          services: {
            firebase: {
              status: firebaseStatus,
            },
            blockchain: {
              status: blockchainStatus,
            },
          },
        },
      });
    }

    // Development & Test response: includes diagnostic information
    return res.status(statusCode).json({
      success: isHealthy,
      data: {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        environment: currentEnv,
        version: "1.0.0",
        services: {
          firebase: {
            status: firebaseStatus,
            projectId: customEnv.FIREBASE_PROJECT_ID,
            emulatorMode: Boolean(customEnv.FIRESTORE_EMULATOR_HOST),
            emulators: customEnv.FIRESTORE_EMULATOR_HOST
              ? {
                  firestore: customEnv.FIRESTORE_EMULATOR_HOST,
                  auth: customEnv.FIREBASE_AUTH_EMULATOR_HOST || null,
                  storage: customEnv.FIREBASE_STORAGE_EMULATOR_HOST || null,
                }
              : null,
          },
          blockchain: {
            status: blockchainStatus,
            chainId: customEnv.CHAIN_ID,
            contractConfigured: Boolean(customEnv.AGRITRACE_CONTRACT_ADDRESS),
            rpcConfigured: Boolean(customEnv.BLOCKCHAIN_RPC_URL),
          },
        },
      },
    });
  });

  // Root welcome / index route
  app.get("/", (req, res) => {
    res.status(200).json({
      success: true,
      message: "AgriTrace REST API is running. Query /api/v1/health for service diagnostics.",
    });
  });

  // Domain API Routes
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/batches", batchRouter);

  // 404 Handler for Unmatched Routes
  app.use(notFoundHandler);

  // Centralized Error-Handling Middleware
  app.use(errorHandler);

  return app;
}

const defaultApp = createApp();
defaultApp.createApp = createApp;

module.exports = defaultApp;
