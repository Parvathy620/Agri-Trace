const { expect } = require("chai");
const { validateEnv } = require("../src/config/env");

describe("Environment Validation (Joi Schema)", () => {
  const baseValidEnv = {
    NODE_ENV: "development",
    PORT: 5000,
    FIREBASE_PROJECT_ID: "agritrace-valid",
    FIRESTORE_EMULATOR_HOST: "localhost:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
    BLOCKCHAIN_RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: 31337,
    AGRITRACE_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    CONFIRMATION_BLOCKS: 1,
  };

  it("Should successfully validate a valid environment configuration", () => {
    const validated = validateEnv(baseValidEnv);
    expect(validated.NODE_ENV).to.equal("development");
    expect(validated.PORT).to.equal(5000);
    expect(validated.CHAIN_ID).to.equal(31337);
    expect(validated.AGRITRACE_CONTRACT_ADDRESS).to.equal("0x5FbDB2315678afecb367f032d93F642f64180aa3");
  });

  it("Should throw a clear error when FIREBASE_PROJECT_ID is missing", () => {
    const invalid = { ...baseValidEnv };
    delete invalid.FIREBASE_PROJECT_ID;

    expect(() => validateEnv(invalid)).to.throw(
      /Environment validation error.*FIREBASE_PROJECT_ID is required/
    );
  });

  it("Should throw a clear error when BLOCKCHAIN_RPC_URL is missing", () => {
    const invalid = { ...baseValidEnv };
    delete invalid.BLOCKCHAIN_RPC_URL;

    expect(() => validateEnv(invalid)).to.throw(
      /Environment validation error.*BLOCKCHAIN_RPC_URL is required/
    );
  });

  it("Should throw an error when BLOCKCHAIN_RPC_URL is not a valid URI", () => {
    const invalid = { ...baseValidEnv, BLOCKCHAIN_RPC_URL: "not-a-valid-url" };

    expect(() => validateEnv(invalid)).to.throw(
      /Environment validation error.*BLOCKCHAIN_RPC_URL/i
    );
  });

  it("Should throw an error when CHAIN_ID is invalid (negative or zero)", () => {
    const invalidZero = { ...baseValidEnv, CHAIN_ID: 0 };
    expect(() => validateEnv(invalidZero)).to.throw(/Environment validation error.*CHAIN_ID/);

    const invalidNegative = { ...baseValidEnv, CHAIN_ID: -1 };
    expect(() => validateEnv(invalidNegative)).to.throw(/Environment validation error.*CHAIN_ID/);
  });

  it("Should throw an error when CHAIN_ID is non-numeric", () => {
    const invalidString = { ...baseValidEnv, CHAIN_ID: "not_a_number" };
    expect(() => validateEnv(invalidString)).to.throw(/Environment validation error.*CHAIN_ID/);
  });

  it("Should throw an error when AGRITRACE_CONTRACT_ADDRESS is not a valid 20-byte hex address", () => {
    const invalidAddress = { ...baseValidEnv, AGRITRACE_CONTRACT_ADDRESS: "0x123Invalid" };
    expect(() => validateEnv(invalidAddress)).to.throw(
      /Environment validation error.*AGRITRACE_CONTRACT_ADDRESS must be a valid 20-byte hex address/
    );
  });

  it("Should reject emulator configuration when NODE_ENV is production", () => {
    const invalidProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.agritrace.io",
      FIRESTORE_EMULATOR_HOST: "localhost:8080",
    };
    expect(() => validateEnv(invalidProd)).to.throw(
      /Production environment cannot use Firebase Emulators/
    );
  });

  it("Should validate valid comma-separated CORS_ORIGIN values", () => {
    const valid = {
      ...baseValidEnv,
      CORS_ORIGIN: "http://localhost:3000,https://app.agritrace.io,http://127.0.0.1:8080",
    };
    const validated = validateEnv(valid);
    expect(validated.CORS_ORIGIN).to.equal(
      "http://localhost:3000,https://app.agritrace.io,http://127.0.0.1:8080"
    );
  });

  it("Should reject invalid URL format in CORS_ORIGIN", () => {
    const invalid = {
      ...baseValidEnv,
      CORS_ORIGIN: "not-a-valid-origin-url",
    };
    expect(() => validateEnv(invalid)).to.throw(
      /Environment validation error.*CORS_ORIGIN contains invalid origin URL/
    );
  });

  it("Should reject wildcard '*' in CORS_ORIGIN when NODE_ENV is production", () => {
    const invalidProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
      CORS_ORIGIN: "*",
    };
    expect(() => validateEnv(invalidProd)).to.throw(
      /Production environment cannot use wildcard '\*' for CORS_ORIGIN/
    );
  });

  it("Should permit wildcard '*' in CORS_ORIGIN when NODE_ENV is development", () => {
    const validDev = {
      ...baseValidEnv,
      NODE_ENV: "development",
      CORS_ORIGIN: "*",
    };
    const validated = validateEnv(validDev);
    expect(validated.CORS_ORIGIN).to.equal("*");
  });

  it("Should require explicitly configured CORS_ORIGIN when NODE_ENV is production", () => {
    const invalidProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
    };
    delete invalidProd.CORS_ORIGIN;

    expect(() => validateEnv(invalidProd)).to.throw(
      /CORS_ORIGIN.*production/i
    );
  });

  it("Should reject empty or whitespace CORS_ORIGIN when NODE_ENV is production", () => {
    const invalidProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
      CORS_ORIGIN: "   ",
    };

    expect(() => validateEnv(invalidProd)).to.throw(
      /CORS_ORIGIN.*production/i
    );
  });

  it("Should not automatically inherit localhost development origins in production", () => {
    const invalidProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
    };
    delete invalidProd.CORS_ORIGIN;

    try {
      validateEnv(invalidProd);
      expect.fail("Validation should have failed for missing production CORS_ORIGIN");
    } catch (err) {
      expect(err.message).to.not.include("localhost:3000");
      expect(err.message).to.match(/CORS_ORIGIN.*production/i);
    }
  });

  it("Should successfully validate production environment when CORS_ORIGIN is explicitly configured", () => {
    const validProd = {
      ...baseValidEnv,
      NODE_ENV: "production",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
      CORS_ORIGIN: "https://app.agritrace.io,https://admin.agritrace.io",
    };

    const validated = validateEnv(validProd);
    expect(validated.CORS_ORIGIN).to.equal("https://app.agritrace.io,https://admin.agritrace.io");
    expect(validated.NODE_ENV).to.equal("production");
  });

  describe("Finality & Confirmation Configuration Verification", () => {
    it("Should provide expected default values for confirmation and finality parameters", () => {
      const minimalEnv = { ...baseValidEnv };
      delete minimalEnv.CONFIRMATION_BLOCKS;
      const validated = validateEnv(minimalEnv);
      expect(validated.CONFIRMATION_BLOCKS).to.equal(2);
      expect(validated.FALLBACK_FINALITY_BLOCKS).to.equal(5);
      expect(validated.ALLOW_FALLBACK_FINALITY).to.equal(true);
    });

    it("Should reject non-positive or non-integer FALLBACK_FINALITY_BLOCKS", () => {
      expect(() => validateEnv({ ...baseValidEnv, FALLBACK_FINALITY_BLOCKS: 0 })).to.throw(
        /FALLBACK_FINALITY_BLOCKS/
      );
      expect(() => validateEnv({ ...baseValidEnv, FALLBACK_FINALITY_BLOCKS: -2 })).to.throw(
        /FALLBACK_FINALITY_BLOCKS/
      );
      expect(() => validateEnv({ ...baseValidEnv, FALLBACK_FINALITY_BLOCKS: "not_a_number" })).to.throw(
        /FALLBACK_FINALITY_BLOCKS/
      );
    });

    it("Should default ALLOW_FALLBACK_FINALITY to false in production when unset", () => {
      const prodEnv = {
        ...baseValidEnv,
        NODE_ENV: "production",
        FIRESTORE_EMULATOR_HOST: "",
        FIREBASE_AUTH_EMULATOR_HOST: "",
        CORS_ORIGIN: "https://app.agritrace.io",
      };
      delete prodEnv.ALLOW_FALLBACK_FINALITY;
      const validated = validateEnv(prodEnv);
      expect(validated.ALLOW_FALLBACK_FINALITY).to.equal(false);
    });

    it("Should permit explicit decision to enable fallback finality in production", () => {
      const prodEnv = {
        ...baseValidEnv,
        NODE_ENV: "production",
        FIRESTORE_EMULATOR_HOST: "",
        FIREBASE_AUTH_EMULATOR_HOST: "",
        CORS_ORIGIN: "https://app.agritrace.io",
        ALLOW_FALLBACK_FINALITY: true,
      };
      const validated = validateEnv(prodEnv);
      expect(validated.ALLOW_FALLBACK_FINALITY).to.equal(true);
    });

    it("Should reject invalid ALLOW_FALLBACK_FINALITY and fail startup rather than silently enable fallback", () => {
      const invalidEnv = {
        ...baseValidEnv,
        ALLOW_FALLBACK_FINALITY: "not_a_boolean",
      };
      expect(() => validateEnv(invalidEnv)).to.throw(
        /ALLOW_FALLBACK_FINALITY must be a valid boolean/
      );
    });

    it("Should retain ALLOW_FALLBACK_FINALITY: true by default in development and test environments", () => {
      const devEnv = { ...baseValidEnv, NODE_ENV: "development" };
      delete devEnv.ALLOW_FALLBACK_FINALITY;
      const validatedDev = validateEnv(devEnv);
      expect(validatedDev.ALLOW_FALLBACK_FINALITY).to.equal(true);

      const testEnv = { ...baseValidEnv, NODE_ENV: "test" };
      delete testEnv.ALLOW_FALLBACK_FINALITY;
      const validatedTest = validateEnv(testEnv);
      expect(validatedTest.ALLOW_FALLBACK_FINALITY).to.equal(true);
    });
  });
});
