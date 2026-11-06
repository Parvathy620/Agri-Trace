/**
 * @file metadata.test.js
 * @description Comprehensive automated test suite for AgriTrace metadata canonicalization,
 * Keccak-256 hashing, Golden Vector parity, and integrity verification.
 */

const { expect } = require("chai");
const { ethers } = require("ethers");
const {
  canonicalizeString,
  canonicalizeHumanBatchId,
  canonicalizeHarvestDate,
  canonicalizeQuantity,
  canonicalizeUnit,
  canonicalizeMetadata,
  serializeCanonicalJson,
} = require("../src/utils/canonicalizer");
const {
  keccak256Utf8,
  computeBatchId,
  computeMetadataHash,
  isValidBytes32,
} = require("../src/utils/hash.util");
const {
  processMetadata,
  verifyMetadataIntegrity,
} = require("../src/services/metadata.service");

describe("Metadata Canonicalization, Hashing & Golden Vector Verification", () => {
  // Verified Golden Vector from Section 6.3 of backend architecture
  const GOLDEN_INPUT = Object.freeze({
    category: "Fresh Produce",
    cropVariety: "Roma Tomato",
    harvestDate: "2026-11-01T10:00:00Z",
    humanBatchId: "BATCH-2026-TOMATO-001",
    origin: "Green Valley Farm",
    quantity: 1500,
    unit: "kg",
  });

  const GOLDEN_CANONICAL_JSON =
    '{"category":"Fresh Produce","cropVariety":"Roma Tomato","harvestDate":"2026-11-01T10:00:00Z","humanBatchId":"BATCH-2026-TOMATO-001","origin":"Green Valley Farm","quantity":1500,"unit":"kg"}';
  const GOLDEN_BATCH_ID =
    "0x7078459f06a313998aff5f7192ae0fa5e58cf9823f4422a8073561b04462125e";
  const GOLDEN_METADATA_HASH =
    "0xbec1c34ae775c4e85a9d48774328d093061dadc4422fffb483384410e74e658e";

  describe("1. Verified Golden Vector Parity", () => {
    it("should process the Golden Vector and produce exact canonical JSON", () => {
      const result = processMetadata(GOLDEN_INPUT);

      expect(result.canonicalJson).to.equal(GOLDEN_CANONICAL_JSON);
      expect(Buffer.from(result.canonicalJson, "utf8").length).to.equal(189);
    });

    it("should compute exact batchId matching Golden Vector", () => {
      const result = processMetadata(GOLDEN_INPUT);

      expect(result.batchId).to.equal(GOLDEN_BATCH_ID);
      expect(Buffer.from(result.humanBatchId, "utf8").length).to.equal(21);
    });

    it("should compute exact metadataHash matching Golden Vector", () => {
      const result = processMetadata(GOLDEN_INPUT);

      expect(result.metadataHash).to.equal(GOLDEN_METADATA_HASH);
    });

    it("should match exact bitwise values from blockchain/test/AgriTrace.js fixture", () => {
      // Replicate the exact logic from blockchain/test/AgriTrace.js
      const expectedHardhatBatchId = ethers.keccak256(
        ethers.toUtf8Bytes("BATCH-2026-TOMATO-001")
      );
      const expectedHardhatHash = ethers.keccak256(
        ethers.toUtf8Bytes(
          JSON.stringify({
            category: "Fresh Produce",
            cropVariety: "Roma Tomato",
            harvestDate: "2026-11-01T10:00:00Z",
            humanBatchId: "BATCH-2026-TOMATO-001",
            origin: "Green Valley Farm",
            quantity: 1500,
            unit: "kg",
          })
        )
      );

      const result = processMetadata(GOLDEN_INPUT);

      expect(result.batchId).to.equal(expectedHardhatBatchId);
      expect(result.metadataHash).to.equal(expectedHardhatHash);
      expect(result.batchId).to.equal(GOLDEN_BATCH_ID);
      expect(result.metadataHash).to.equal(GOLDEN_METADATA_HASH);
    });
  });

  describe("2. Determinism, Ordering, and Normalization", () => {
    it("should produce identical hashes regardless of input key order", () => {
      // Reverse key order
      const reversedInput = {
        unit: "kg",
        quantity: 1500,
        origin: "Green Valley Farm",
        humanBatchId: "BATCH-2026-TOMATO-001",
        harvestDate: "2026-11-01T10:00:00Z",
        cropVariety: "Roma Tomato",
        category: "Fresh Produce",
      };

      // Scrambled key order
      const scrambledInput = {
        harvestDate: "2026-11-01T10:00:00Z",
        category: "Fresh Produce",
        unit: "kg",
        cropVariety: "Roma Tomato",
        quantity: 1500,
        origin: "Green Valley Farm",
        humanBatchId: "BATCH-2026-TOMATO-001",
      };

      const resStandard = processMetadata(GOLDEN_INPUT);
      const resReversed = processMetadata(reversedInput);
      const resScrambled = processMetadata(scrambledInput);

      expect(resReversed.canonicalJson).to.equal(resStandard.canonicalJson);
      expect(resReversed.metadataHash).to.equal(resStandard.metadataHash);
      expect(resScrambled.canonicalJson).to.equal(resStandard.canonicalJson);
      expect(resScrambled.metadataHash).to.equal(resStandard.metadataHash);
    });

    it("should normalize leading and trailing whitespace in string fields", () => {
      const whitespaceInput = {
        category: "   Fresh Produce   ",
        cropVariety: " Roma Tomato  ",
        harvestDate: "  2026-11-01T10:00:00Z  ",
        humanBatchId: "  BATCH-2026-TOMATO-001   ",
        origin: "  Green Valley Farm ",
        quantity: "  1500  ",
        unit: "  KG  ",
      };

      const result = processMetadata(whitespaceInput);

      expect(result.canonicalJson).to.equal(GOLDEN_CANONICAL_JSON);
      expect(result.batchId).to.equal(GOLDEN_BATCH_ID);
      expect(result.metadataHash).to.equal(GOLDEN_METADATA_HASH);
    });

    it("should normalize Unicode strings to NFC precomposed form", () => {
      // Decomposed "e" + combining acute accent (\u0065\u0301) vs composed (\u00e9)
      const decomposed = "Cafe\u0301 Farm";
      const composed = "Caf\u00e9 Farm";

      expect(canonicalizeString(decomposed)).to.equal(composed);

      const inputWithNFD = {
        ...GOLDEN_INPUT,
        origin: decomposed,
      };

      const inputWithNFC = {
        ...GOLDEN_INPUT,
        origin: composed,
      };

      const resNFD = processMetadata(inputWithNFD);
      const resNFC = processMetadata(inputWithNFC);

      expect(resNFD.canonicalJson).to.equal(resNFC.canonicalJson);
      expect(resNFD.metadataHash).to.equal(resNFC.metadataHash);
    });

    it("should normalize lowercase humanBatchId to uppercase", () => {
      const lowerBatchId = "batch-2026-tomato-001";
      const canonicalId = canonicalizeHumanBatchId(lowerBatchId);

      expect(canonicalId).to.equal("BATCH-2026-TOMATO-001");
      expect(computeBatchId(lowerBatchId)).to.equal(GOLDEN_BATCH_ID);
    });
  });

  describe("3. Quantity Validation & Canonicalization Rules", () => {
    it("should normalize integer quantities without altering value", () => {
      expect(canonicalizeQuantity(1500)).to.equal(1500);
      expect(canonicalizeQuantity("1500")).to.equal(1500);
    });

    it("should strip trailing zeros from decimal quantities", () => {
      expect(canonicalizeQuantity("1500.0")).to.equal(1500);
      expect(canonicalizeQuantity("1500.00")).to.equal(1500);
      expect(canonicalizeQuantity("1500.000")).to.equal(1500);
      expect(canonicalizeQuantity("12.50")).to.equal(12.5);
      expect(canonicalizeQuantity("12.500")).to.equal(12.5);
      expect(canonicalizeQuantity(12.5)).to.equal(12.5);
    });

    it("should support up to exactly 3 decimal places without rounding", () => {
      expect(canonicalizeQuantity(0.001)).to.equal(0.001);
      expect(canonicalizeQuantity("0.001")).to.equal(0.001);
      expect(canonicalizeQuantity("1500.123")).to.equal(1500.123);
      expect(canonicalizeQuantity("999999999.999")).to.equal(999999999.999);
    });

    it("should reject quantities with more than 3 decimal places without silent rounding", () => {
      expect(() => canonicalizeQuantity("1500.0001")).to.throw(
        /Quantity exceeds maximum precision of 3 decimal places/
      );
      expect(() => canonicalizeQuantity("12.3456")).to.throw(
        /Quantity exceeds maximum precision of 3 decimal places/
      );
      expect(() => canonicalizeQuantity("0.0001")).to.throw(
        /Quantity exceeds maximum precision of 3 decimal places/
      );
    });

    it("should strictly reject scientific notation in any form", () => {
      expect(() => canonicalizeQuantity("1e3")).to.throw(
        /Scientific notation is strictly prohibited/
      );
      expect(() => canonicalizeQuantity("1.5e3")).to.throw(
        /Scientific notation is strictly prohibited/
      );
      expect(() => canonicalizeQuantity("1E6")).to.throw(
        /Scientific notation is strictly prohibited/
      );
      expect(() => canonicalizeQuantity("1.0e-3")).to.throw(
        /Scientific notation is strictly prohibited/
      );
    });

    it("should reject negative quantities and zero", () => {
      expect(() => canonicalizeQuantity(0)).to.throw(
        /Quantity out of bounds/
      );
      expect(() => canonicalizeQuantity("0")).to.throw(
        /Quantity out of bounds/
      );
      expect(() => canonicalizeQuantity("0.000")).to.throw(
        /Quantity out of bounds/
      );
      expect(() => canonicalizeQuantity(-10)).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity("-1500.5")).to.throw(
        /Invalid quantity format/
      );
    });

    it("should enforce maximum quantity boundary of 1,000,000,000", () => {
      expect(canonicalizeQuantity(1000000000)).to.equal(1000000000);
      expect(canonicalizeQuantity("1000000000")).to.equal(1000000000);
      expect(canonicalizeQuantity("1000000000.000")).to.equal(1000000000);

      expect(() => canonicalizeQuantity(1000000001)).to.throw(
        /Quantity out of bounds/
      );
      expect(() => canonicalizeQuantity("1000000000.001")).to.throw(
        /Quantity out of bounds/
      );
    });

    it("should reject leading zeros on non-zero integers", () => {
      expect(() => canonicalizeQuantity("001500")).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity("012")).to.throw(
        /Invalid quantity format/
      );
    });

    it("should reject invalid, infinite and non-numeric inputs", () => {
      expect(() => canonicalizeQuantity(NaN)).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity(Infinity)).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity("-Infinity")).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity("abc")).to.throw(
        /Invalid quantity format/
      );
      expect(() => canonicalizeQuantity("")).to.throw(
        /Field 'quantity' is required/
      );
      expect(() => canonicalizeQuantity(null)).to.throw(
        /Field 'quantity' is required/
      );
      expect(() => canonicalizeQuantity(undefined)).to.throw(
        /Field 'quantity' is required/
      );
    });

    it("should produce identical canonical JSON and metadataHash for equivalent accepted quantity values", () => {
      // 1000 as string vs 1000 as number
      const inputNum1000 = { ...GOLDEN_INPUT, quantity: 1000 };
      const inputStr1000 = { ...GOLDEN_INPUT, quantity: "1000" };
      const inputTrailing1000 = { ...GOLDEN_INPUT, quantity: "1000.000" };

      const resNum = processMetadata(inputNum1000);
      const resStr = processMetadata(inputStr1000);
      const resTrailing = processMetadata(inputTrailing1000);

      expect(resStr.canonicalJson).to.equal(resNum.canonicalJson);
      expect(resStr.metadataHash).to.equal(resNum.metadataHash);
      expect(resTrailing.canonicalJson).to.equal(resNum.canonicalJson);
      expect(resTrailing.metadataHash).to.equal(resNum.metadataHash);

      // Golden Vector 1500 variations: number 1500, "1500", "1500.0", "1500.00", "1500.000"
      const variants = [1500, "1500", "1500.0", "1500.00", "1500.000"];
      for (const val of variants) {
        const res = processMetadata({ ...GOLDEN_INPUT, quantity: val });
        expect(res.canonicalJson).to.equal(GOLDEN_CANONICAL_JSON);
        expect(res.metadataHash).to.equal(GOLDEN_METADATA_HASH);
      }
    });

    it("should handle JSON-parsed numeric exponent notation and string scientific notation distinctly", () => {
      // String notation '1e3' is caught by lexical pre-validation
      expect(() => processMetadata({ ...GOLDEN_INPUT, quantity: "1e3" })).to.throw(
        /Scientific notation is strictly prohibited/
      );

      // Numeric literal 1e3 is evaluated by JS / JSON.parse into number 1000 before validator executes
      const numericExponent = 1e3; // Number 1000 in memory
      const resExponent = processMetadata({ ...GOLDEN_INPUT, quantity: numericExponent });
      const resCanonical1000 = processMetadata({ ...GOLDEN_INPUT, quantity: 1000 });

      expect(resExponent.canonicalJson).to.equal(resCanonical1000.canonicalJson);
      expect(resExponent.metadataHash).to.equal(resCanonical1000.metadataHash);
    });
  });

  describe("4. Field Perturbation Sensitivity (Cryptographic Avalanche)", () => {
    it("should change metadataHash when 'category' is altered", () => {
      const altered = { ...GOLDEN_INPUT, category: "Grains" };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });

    it("should change metadataHash when 'cropVariety' is altered", () => {
      const altered = { ...GOLDEN_INPUT, cropVariety: "Beefsteak Tomato" };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });

    it("should change metadataHash when 'harvestDate' is altered", () => {
      const altered = { ...GOLDEN_INPUT, harvestDate: "2026-11-02T10:00:00Z" };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });

    it("should change both batchId and metadataHash when 'humanBatchId' is altered", () => {
      const altered = { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-002" };
      const res = processMetadata(altered);

      expect(res.batchId).to.not.equal(GOLDEN_BATCH_ID);
      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
    });

    it("should change metadataHash when 'origin' is altered", () => {
      const altered = { ...GOLDEN_INPUT, origin: "Blue Ridge Farm" };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });

    it("should change metadataHash when 'quantity' is altered", () => {
      const altered = { ...GOLDEN_INPUT, quantity: 1501 };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });

    it("should change metadataHash when 'unit' is altered", () => {
      const altered = { ...GOLDEN_INPUT, unit: "ton" };
      const res = processMetadata(altered);

      expect(res.metadataHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(res.batchId).to.equal(GOLDEN_BATCH_ID);
    });
  });

  describe("5. Input Validation Rules & Error Codes", () => {
    it("should reject non-object payloads with 422 INVALID_METADATA_PAYLOAD", () => {
      expect(() => processMetadata(null)).to.throw(
        /Metadata must be a non-null object/
      );
      expect(() => processMetadata("invalid")).to.throw(
        /Metadata must be a non-null object/
      );
      expect(() => processMetadata([1, 2, 3])).to.throw(
        /Metadata must be a non-null object/
      );
    });

    it("should reject missing required anchored fields with 422 MISSING_METADATA_FIELD", () => {
      const requiredFields = [
        "category",
        "cropVariety",
        "harvestDate",
        "humanBatchId",
        "origin",
        "quantity",
        "unit",
      ];

      for (const field of requiredFields) {
        const copy = { ...GOLDEN_INPUT };
        delete copy[field];

        try {
          processMetadata(copy);
          expect.fail(`Expected failure for missing field: ${field}`);
        } catch (error) {
          expect(error.statusCode).to.equal(422);
          expect(error.code).to.equal("MISSING_METADATA_FIELD");
          expect(error.message).to.include(field);
        }
      }
    });

    it("should reject non-ASCII humanBatchId", () => {
      const nonAscii = {
        ...GOLDEN_INPUT,
        humanBatchId: "BATCH-2026-TOMATO-\u00C901",
      };

      try {
        processMetadata(nonAscii);
        expect.fail("Expected failure for non-ASCII batch ID");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("INVALID_BATCH_ID");
      }
    });

    it("should reject humanBatchId not starting with BATCH- prefix", () => {
      const invalidPrefix = {
        ...GOLDEN_INPUT,
        humanBatchId: "LOT-2026-TOMATO-001",
      };

      try {
        processMetadata(invalidPrefix);
        expect.fail("Expected failure for invalid batch ID prefix");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("INVALID_BATCH_ID");
      }
    });

    it("should reject unparseable harvestDate", () => {
      const invalidDate = {
        ...GOLDEN_INPUT,
        harvestDate: "invalid-date-string",
      };

      try {
        processMetadata(invalidDate);
        expect.fail("Expected failure for invalid date");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("INVALID_HARVEST_DATE");
      }
    });

    it("should reject harvestDate without UTC Z indicator", () => {
      const nonUtcDate = {
        ...GOLDEN_INPUT,
        harvestDate: "2026-11-01T10:00:00",
      };

      try {
        processMetadata(nonUtcDate);
        expect.fail("Expected failure for date without UTC Z");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("INVALID_HARVEST_DATE");
      }
    });

    it("should reject harvestDate out of valid range (1970-2100)", () => {
      const tooOld = {
        ...GOLDEN_INPUT,
        harvestDate: "1960-01-01T00:00:00Z",
      };
      const tooFar = {
        ...GOLDEN_INPUT,
        harvestDate: "2150-01-01T00:00:00Z",
      };

      expect(() => processMetadata(tooOld)).to.throw(/harvestDate year out of valid range/);
      expect(() => processMetadata(tooFar)).to.throw(/harvestDate year out of valid range/);
    });

    it("should reject impossible calendar dates and prevent silent month rollover", () => {
      const impossibleDates = [
        { date: "2026-02-30T10:00:00Z", desc: "Feb 30" },
        { date: "2026-02-29T10:00:00Z", desc: "Feb 29 on non-leap year" },
        { date: "2026-13-01T10:00:00Z", desc: "Month 13" },
        { date: "2026-11-31T10:00:00Z", desc: "Nov 31 (Nov has 30 days)" },
        { date: "2026-04-31T10:00:00Z", desc: "Apr 31 (Apr has 30 days)" },
        { date: "2026-06-31T10:00:00Z", desc: "Jun 31 (Jun has 30 days)" },
        { date: "2026-09-31T10:00:00Z", desc: "Sep 31 (Sep has 30 days)" },
        { date: "2100-02-29T10:00:00Z", desc: "Feb 29 on century non-leap year 2100" },
      ];

      for (const { date, desc } of impossibleDates) {
        try {
          processMetadata({ ...GOLDEN_INPUT, harvestDate: date });
          expect.fail(`Expected rejection for impossible date: ${date} (${desc})`);
        } catch (error) {
          expect(error.statusCode).to.equal(422);
          expect(error.code).to.equal("INVALID_HARVEST_DATE");
        }
      }
    });

    it("should accept valid leap-year dates and valid calendar boundary dates", () => {
      const validDates = [
        "2028-02-29T10:00:00Z", // 2028 leap year
        "2024-02-29T10:00:00Z", // 2024 leap year
        "2000-02-29T10:00:00Z", // 2000 century leap year
        "2026-11-30T23:59:59Z", // End of November
        "1970-01-01T00:00:00Z", // Unix epoch boundary
        "2100-12-31T23:59:59Z", // Maximum year boundary
      ];

      for (const date of validDates) {
        const res = processMetadata({ ...GOLDEN_INPUT, harvestDate: date });
        expect(res.canonicalMetadata.harvestDate).to.equal(date);
      }
    });

    it("should reject unexpected / unapproved fields outside the 7 anchored fields with 422 UNEXPECTED_METADATA_FIELD", () => {
      const singleExtra = {
        ...GOLDEN_INPUT,
        extraNotes: "organic fertilizer used",
      };

      try {
        processMetadata(singleExtra);
        expect.fail("Expected failure for unexpected field 'extraNotes'");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("UNEXPECTED_METADATA_FIELD");
        expect(error.message).to.include("extraNotes");
        expect(error.message).to.include("Only the 7 approved anchored fields are permitted");
      }

      const multipleExtras = {
        ...GOLDEN_INPUT,
        gpsLatitude: 18.5204,
        gpsLongitude: 73.8567,
      };

      try {
        processMetadata(multipleExtras);
        expect.fail("Expected failure for multiple unexpected fields");
      } catch (error) {
        expect(error.statusCode).to.equal(422);
        expect(error.code).to.equal("UNEXPECTED_METADATA_FIELD");
        expect(error.message).to.include("gpsLatitude");
        expect(error.message).to.include("gpsLongitude");
      }
    });
  });

  describe("6. Cryptographic Hash Utilities (hash.util.js)", () => {
    it("should validate 32-byte hex strings correctly", () => {
      expect(isValidBytes32(GOLDEN_BATCH_ID)).to.be.true;
      expect(isValidBytes32(GOLDEN_METADATA_HASH)).to.be.true;
      expect(isValidBytes32("0x" + "ab".repeat(32))).to.be.true;

      // Invalid cases
      expect(isValidBytes32("not-hex")).to.be.false;
      expect(isValidBytes32(GOLDEN_BATCH_ID.slice(0, -2))).to.be.false; // Too short
      expect(isValidBytes32(GOLDEN_BATCH_ID + "00")).to.be.false; // Too long
      expect(isValidBytes32(GOLDEN_BATCH_ID.replace("0x", ""))).to.be.false; // Missing 0x
      expect(isValidBytes32(null)).to.be.false;
      expect(isValidBytes32(undefined)).to.be.false;
      expect(isValidBytes32(12345)).to.be.false;
    });

    it("should throw error if input to keccak256Utf8 is not a string", () => {
      expect(() => keccak256Utf8(null)).to.throw(/must be a string/);
      expect(() => keccak256Utf8(123)).to.throw(/must be a string/);
      expect(() => keccak256Utf8({})).to.throw(/must be a string/);
    });

    it("should throw error if input to computeBatchId is empty or non-string", () => {
      expect(() => computeBatchId("")).to.throw(/must be a non-empty string/);
      expect(() => computeBatchId("   ")).to.throw(/must be a non-empty string/);
      expect(() => computeBatchId(null)).to.throw(/must be a non-empty string/);
    });

    it("should throw error if input to computeMetadataHash is empty or non-string", () => {
      expect(() => computeMetadataHash("")).to.throw(/must be a non-empty string/);
      expect(() => computeMetadataHash("   ")).to.throw(/must be a non-empty string/);
      expect(() => computeMetadataHash(null)).to.throw(/must be a non-empty string/);
    });
  });

  describe("7. Metadata Integrity Verification (verifyMetadataIntegrity)", () => {
    it("should return isValid=true for unaltered metadata and matching hash", () => {
      const verification = verifyMetadataIntegrity(
        GOLDEN_INPUT,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.true;
      expect(verification.calculatedHash).to.equal(GOLDEN_METADATA_HASH);
      expect(verification.expectedHash).to.equal(GOLDEN_METADATA_HASH);
      expect(verification.reason).to.be.null;
    });

    it("should perform case-insensitive hash comparison", () => {
      const upperCaseHash = GOLDEN_METADATA_HASH.toUpperCase().replace("0X", "0x");
      const verification = verifyMetadataIntegrity(GOLDEN_INPUT, upperCaseHash);

      expect(verification.isValid).to.be.true;
      expect(verification.reason).to.be.null;
    });

    it("should detect tampering when quantity was altered", () => {
      const tampered = { ...GOLDEN_INPUT, quantity: 1500.5 };
      const verification = verifyMetadataIntegrity(
        tampered,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.false;
      expect(verification.calculatedHash).to.not.equal(GOLDEN_METADATA_HASH);
      expect(verification.reason).to.include("Metadata hash mismatch");
    });

    it("should detect tampering when crop variety was altered", () => {
      const tampered = { ...GOLDEN_INPUT, cropVariety: "San Marzano" };
      const verification = verifyMetadataIntegrity(
        tampered,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.false;
      expect(verification.reason).to.include("Metadata hash mismatch");
    });

    it("should fail gracefully when expected hash is invalid or malformed", () => {
      const verification = verifyMetadataIntegrity(GOLDEN_INPUT, "0x1234invalid");

      expect(verification.isValid).to.be.false;
      expect(verification.calculatedHash).to.be.null;
      expect(verification.reason).to.include("Expected metadata hash must be a valid 32-byte hex string");
    });

    it("should fail gracefully when metadata itself is invalid", () => {
      const invalidMetadata = { ...GOLDEN_INPUT, quantity: -50 };
      const verification = verifyMetadataIntegrity(
        invalidMetadata,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.false;
      expect(verification.calculatedHash).to.be.null;
      expect(verification.reason).to.include("Metadata canonicalization failed");
    });

    it("should reject metadata containing unexpected fields during integrity verification", () => {
      const payloadWithExtra = {
        ...GOLDEN_INPUT,
        tamperedField: "injection",
      };
      const verification = verifyMetadataIntegrity(
        payloadWithExtra,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.false;
      expect(verification.calculatedHash).to.be.null;
      expect(verification.reason).to.include("Unexpected field(s)");
    });

    it("should never mutate the input rawMetadata object during verification", () => {
      const frozenInput = Object.freeze({
        category: "Fresh Produce",
        cropVariety: "Roma Tomato",
        harvestDate: "2026-11-01T10:00:00Z",
        humanBatchId: "BATCH-2026-TOMATO-001",
        origin: "Green Valley Farm",
        quantity: 1500,
        unit: "kg",
      });

      // Verification on frozen object should not throw any mutation error
      const verification = verifyMetadataIntegrity(
        frozenInput,
        GOLDEN_METADATA_HASH
      );

      expect(verification.isValid).to.be.true;
    });
  });
});

