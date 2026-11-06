/**
 * @file canonicalizer.js
 * @description Deterministic canonicalization and serialization for AgriTrace metadata.
 * Enforces strict Unicode NFC normalization, UTC date format without milliseconds,
 * lexical quantity rules (max 3 decimal places without rounding, trailing zero stripping),
 * and alphabetical key ordering for cross-platform hash parity (Node.js, Dart, Solidity).
 */

const {
  validateMetadataInput,
  validateStrictCalendarDate,
} = require("../validators/metadata.validator");

/**
 * Normalizes a string using Unicode NFC normalization and trims whitespace.
 *
 * @param {string} str - Raw string
 * @returns {string} Normalized string
 * @throws {Error} If input is not a string
 */
function canonicalizeString(str) {
  if (typeof str !== "string") {
    const error = new Error("Value must be a string");
    error.statusCode = 422;
    error.code = "INVALID_STRING";
    throw error;
  }
  return str.normalize("NFC").trim();
}

/**
 * Canonicalizes human-readable batch ID.
 * Enforces ASCII uppercase characters matching pattern 'BATCH-[A-Z0-9-]+'.
 *
 * @param {string} rawId - Raw batch ID
 * @returns {string} Canonical uppercase batch ID
 * @throws {Error} If invalid format or non-ASCII
 */
function canonicalizeHumanBatchId(rawId) {
  if (typeof rawId !== "string") {
    const error = new Error("Field 'humanBatchId' must be a string");
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  const normalized = rawId.trim().toUpperCase();

  if (!/^[\x00-\x7F]+$/.test(normalized)) {
    const error = new Error("Field 'humanBatchId' must contain only ASCII characters");
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  if (!/^BATCH-[A-Z0-9-]+$/.test(normalized)) {
    const error = new Error(
      `Invalid humanBatchId format: '${normalized}'. Must match 'BATCH-[A-Z0-9-]+'`
    );
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  return normalized;
}

/**
 * Canonicalizes harvest date into strict ISO 8601 UTC format: YYYY-MM-DDTHH:mm:ssZ.
 * Strips milliseconds and validates year is within 1970-2100.
 *
 * @param {string|Date} rawDate - Raw date input
 * @returns {string} Canonical UTC date string (YYYY-MM-DDTHH:mm:ssZ)
 * @throws {Error} If unparseable, out of range, or invalid format
 */
function canonicalizeHarvestDate(rawDate) {
  if (!rawDate) {
    const error = new Error("Field 'harvestDate' is required");
    error.statusCode = 422;
    error.code = "INVALID_HARVEST_DATE";
    throw error;
  }

  let dateStr;
  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) {
      const error = new Error("Invalid harvestDate: Date object is invalid");
      error.statusCode = 422;
      error.code = "INVALID_HARVEST_DATE";
      throw error;
    }
    dateStr = rawDate.toISOString();
  } else if (typeof rawDate === "string") {
    dateStr = rawDate.trim();
  } else {
    const error = new Error("Field 'harvestDate' must be an ISO 8601 string or Date object");
    error.statusCode = 422;
    error.code = "INVALID_HARVEST_DATE";
    throw error;
  }

  const calendarCheck = validateStrictCalendarDate(dateStr);
  if (!calendarCheck.valid) {
    const error = new Error(calendarCheck.reason);
    error.statusCode = 422;
    error.code = "INVALID_HARVEST_DATE";
    throw error;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const year = calendarCheck.year;
  const month = pad(calendarCheck.month);
  const day = pad(calendarCheck.day);
  const hours = pad(calendarCheck.hour);
  const minutes = pad(calendarCheck.minute);
  const seconds = pad(calendarCheck.second);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
}

/**
 * Canonicalizes quantity according to Section 6.2 of the architecture specification.
 * Enforces lexical pre-validation, prohibits scientific notation, prohibits silent rounding,
 * enforces bounds (0.001 to 1,000,000,000), and normalizes trailing zeros.
 *
 * @param {number|string} raw - Raw quantity value
 * @returns {number} Canonical numeric value
 * @throws {Error} If validation fails
 */
function canonicalizeQuantity(raw) {
  if (raw === undefined || raw === null || raw === "") {
    const error = new Error("Field 'quantity' is required");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  const str = (typeof raw === "string" ? raw : String(raw)).trim();

  // 1. Prohibit scientific notation
  if (/[eE]/.test(str)) {
    const error = new Error("Scientific notation is strictly prohibited for quantity");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // 2. Pattern check: positive digits without leading zeros or symbols
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(str)) {
    const error = new Error(
      `Invalid quantity format: '${str}'. Must be positive digits without leading zeros or symbols`
    );
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // 3. Precision check: max 3 decimal places without rounding
  const [intPart, fracPart] = str.split(".");
  if (fracPart && fracPart.length > 3) {
    const error = new Error(
      `Quantity exceeds maximum precision of 3 decimal places: '${str}' (found ${fracPart.length})`
    );
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // 4. Numeric range check
  const num = Number(str);
  if (num <= 0 || num > 1000000000) {
    const error = new Error("Quantity out of bounds (must be between 0.001 and 1,000,000,000)");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // 5. Trailing zeros normalization
  const cleanFrac = fracPart ? fracPart.replace(/0+$/, "") : "";
  const normStr = cleanFrac.length > 0 ? `${intPart}.${cleanFrac}` : intPart;
  return Number(normStr);
}

/**
 * Canonicalizes unit: trimmed and converted to lowercase.
 *
 * @param {string} unit - Raw unit string
 * @returns {string} Canonical lowercase unit
 * @throws {Error} If not a non-empty string
 */
function canonicalizeUnit(unit) {
  if (typeof unit !== "string" || unit.trim().length === 0) {
    const error = new Error("Field 'unit' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_UNIT";
    throw error;
  }
  return unit.trim().toLowerCase();
}

/**
 * Validates and canonicalizes the 7 approved anchored agricultural metadata fields.
 *
 * @param {Object} rawMetadata - Raw metadata object
 * @returns {Readonly<Object>} Immutable object with canonicalized fields
 */
function canonicalizeMetadata(rawMetadata) {
  // Validate presence and raw rules first
  validateMetadataInput(rawMetadata);

  // Return object with the 7 anchored fields in alphabetical order
  return Object.freeze({
    category: canonicalizeString(rawMetadata.category),
    cropVariety: canonicalizeString(rawMetadata.cropVariety),
    harvestDate: canonicalizeHarvestDate(rawMetadata.harvestDate),
    humanBatchId: canonicalizeHumanBatchId(rawMetadata.humanBatchId),
    origin: canonicalizeString(rawMetadata.origin),
    quantity: canonicalizeQuantity(rawMetadata.quantity),
    unit: canonicalizeUnit(rawMetadata.unit),
  });
}

/**
 * Deterministically serializes an object into compact JSON with keys sorted alphabetically.
 *
 * @param {Object} obj - Object to serialize
 * @returns {string} Compact canonical JSON string
 * @throws {Error} If input is not a non-null object
 */
function serializeCanonicalJson(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    const error = new Error("Input must be a non-null object for canonical serialization");
    error.statusCode = 422;
    error.code = "INVALID_CANONICAL_PAYLOAD";
    throw error;
  }

  const sortedKeys = Object.keys(obj).sort();
  const sortedObj = {};
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }

  return JSON.stringify(sortedObj);
}

module.exports = {
  canonicalizeString,
  canonicalizeHumanBatchId,
  canonicalizeHarvestDate,
  canonicalizeQuantity,
  canonicalizeUnit,
  canonicalizeMetadata,
  serializeCanonicalJson,
};

