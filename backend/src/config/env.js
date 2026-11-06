const Joi = require("joi");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables based on NODE_ENV if not already loaded
const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  PORT: Joi.number().port().default(5000),

  // Firebase Configuration
  FIREBASE_PROJECT_ID: Joi.string().required().messages({
    "any.required": "FIREBASE_PROJECT_ID is required for Firebase initialization",
  }),
  FIRESTORE_EMULATOR_HOST: Joi.string().allow("").optional(),
  FIREBASE_AUTH_EMULATOR_HOST: Joi.string().allow("").optional(),
  FIREBASE_STORAGE_EMULATOR_HOST: Joi.string().allow("").optional(),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().allow("").optional(),

  // Blockchain Configuration
  BLOCKCHAIN_RPC_URL: Joi.string()
    .uri({ scheme: [/http/, /https/, /ws/, /wss/] })
    .required()
    .messages({
      "any.required": "BLOCKCHAIN_RPC_URL is required to connect to the EVM network",
      "string.uri": "BLOCKCHAIN_RPC_URL must be a valid URI",
      "string.uriCustomScheme": "BLOCKCHAIN_RPC_URL must be a valid HTTP/HTTPS or WebSocket URL",
    }),
  CHAIN_ID: Joi.number().integer().positive().required().messages({
    "any.required": "CHAIN_ID is required to prevent cross-chain transaction replay",
    "number.base": "CHAIN_ID must be an integer (e.g., 31337 for Hardhat, 11155111 for Sepolia)",
  }),
  AGRITRACE_CONTRACT_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required()
    .messages({
      "any.required": "AGRITRACE_CONTRACT_ADDRESS is required to bind contract interface",
      "string.pattern.base": "AGRITRACE_CONTRACT_ADDRESS must be a valid 20-byte hex address (0x...)",
    }),
  CONFIRMATION_BLOCKS: Joi.number().integer().min(1).default(2),
  FALLBACK_FINALITY_BLOCKS: Joi.number().integer().min(1).default(5),
  ALLOW_FALLBACK_FINALITY: Joi.boolean()
    .when("NODE_ENV", {
      is: "production",
      then: Joi.boolean().default(false),
      otherwise: Joi.boolean().default(true),
    })
    .messages({
      "boolean.base": "ALLOW_FALLBACK_FINALITY must be a valid boolean (true or false)",
    }),

  // CORS Configuration
  CORS_ORIGIN: Joi.string()
    .allow("")
    .when("NODE_ENV", {
      is: "production",
      then: Joi.string().trim().required().messages({
        "any.required": "CORS_ORIGIN is required in production environment",
        "string.empty": "CORS_ORIGIN cannot be empty in production environment",
      }),
      otherwise: Joi.string()
        .allow("")
        .default("http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080"),
    })
    .custom((value, helpers) => {
      if (!value || value.trim() === "") {
        return value;
      }
      const origins = value.split(",").map((o) => o.trim()).filter(Boolean);
      for (const origin of origins) {
        if (origin === "*") {
          continue;
        }
        try {
          const parsed = new URL(origin);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return helpers.message(`CORS_ORIGIN item '${origin}' must use http or https protocol`);
          }
        } catch (e) {
          return helpers.message(`CORS_ORIGIN contains invalid origin URL: '${origin}'`);
        }
      }
      return value;
    })
    .messages({
      "string.base": "CORS_ORIGIN must be a comma-separated string of origin URLs",
    }),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().positive().default(900000), // 15 minutes
  RATE_LIMIT_MAX: Joi.number().integer().positive().default(100),
})
  .unknown(true); // Allow other standard process.env keys (PATH, etc.)

/**
 * Validates arbitrary environment variables against the Joi schema.
 * @param {Object} envObj - Key-value pair of environment variables.
 * @returns {Object} Validated and typed environment values.
 * @throws {Error} If validation fails.
 */
function validateEnv(envObj = process.env) {
  const { error, value } = envSchema.validate(envObj, {
    abortEarly: false,
    stripUnknown: false,
  });

  if (error) {
    const errorDetails = error.details.map((d) => d.message).join(", ");
    throw new Error(`Environment validation error: ${errorDetails}`);
  }

  // Enforce production security rules
  if (value.NODE_ENV === "production") {
    if (value.FIRESTORE_EMULATOR_HOST || value.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new Error("Production environment cannot use Firebase Emulators");
    }

    if (!value.CORS_ORIGIN || value.CORS_ORIGIN.trim() === "") {
      throw new Error("CORS_ORIGIN must be explicitly configured in production environment");
    }

    const origins = value.CORS_ORIGIN
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (origins.length === 0) {
      throw new Error("CORS_ORIGIN must contain at least one valid origin in production environment");
    }

    if (origins.includes("*")) {
      throw new Error("Production environment cannot use wildcard '*' for CORS_ORIGIN");
    }
  }

  return value;
}

// Automatically validate and export current environment config
let config;
try {
  config = validateEnv(process.env);
} catch (err) {
  // If in test environment and env is being tested dynamically, provide fallback or rethrow
  if (process.env.NODE_ENV === "test") {
    config = {
      NODE_ENV: "test",
      PORT: 5001,
      FIREBASE_PROJECT_ID: "agritrace-test",
      FIRESTORE_EMULATOR_HOST: "localhost:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
      BLOCKCHAIN_RPC_URL: "http://127.0.0.1:8545",
      CHAIN_ID: 31337,
      AGRITRACE_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      CONFIRMATION_BLOCKS: 2,
      FALLBACK_FINALITY_BLOCKS: 5,
      ALLOW_FALLBACK_FINALITY: true,
      CORS_ORIGIN: "http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080",
      RATE_LIMIT_WINDOW_MS: 900000,
      RATE_LIMIT_MAX: 100,
    };
  } else {
    throw err;
  }
}

module.exports = {
  env: config,
  validateEnv,
  envSchema,
};
