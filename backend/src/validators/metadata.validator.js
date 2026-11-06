/**
 * @file metadata.validator.js
 * @description Validates the 7 approved agricultural batch metadata fields prior to canonicalization.
 * Enforces strict presence of the 7 anchored fields, rejects unapproved extra fields,
 * enforces strict non-rollover calendar date validation, and validates quantity representation.
 */

const APPROVED_FIELDS = Object.freeze([
  "category",
  "cropVariety",
  "harvestDate",
  "humanBatchId",
  "origin",
  "quantity",
  "unit",
]);

/**
 * Determines whether a year is a leap year in the Gregorian calendar.
 *
 * @param {number} year - Four-digit year
 * @returns {boolean} True if leap year
 */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Validates that an ISO 8601 date string represents a real, non-rollover calendar date.
 * Rejects impossible dates like Feb 29 on non-leap years, Feb 30, Nov 31, month 13, etc.
 *
 * @param {string} dateStr - Date string in YYYY-MM-DDTHH:mm:ssZ format
 * @returns {{ valid: boolean, reason?: string, year?: number, month?: number, day?: number, hour?: number, minute?: number, second?: number }}
 */
function validateStrictCalendarDate(dateStr) {
  if (typeof dateStr !== "string") {
    return {
      valid: false,
      reason: "Date must be a string",
    };
  }

  const match = dateStr.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/
  );
  if (!match) {
    return {
      valid: false,
      reason: `Date '${dateStr}' must be in strict UTC ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)`,
    };
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  if (year < 1970 || year > 2100) {
    return {
      valid: false,
      reason: `harvestDate year out of valid range (1970-2100): ${year}`,
    };
  }

  if (month < 1 || month > 12) {
    return {
      valid: false,
      reason: `Invalid calendar month: ${month} (must be 01-12)`,
    };
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return {
      valid: false,
      reason: `Time components out of valid 24-hour range: ${hour}:${minute}:${second}`,
    };
  }

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maxDay = daysInMonth[month - 1];

  if (day < 1 || day > maxDay) {
    const leapNote =
      month === 2 && !isLeapYear(year) ? ` (${year} is not a leap year)` : "";
    return {
      valid: false,
      reason: `Invalid calendar day ${day} for month ${month}${leapNote}. Maximum permitted is ${maxDay}`,
    };
  }

  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) {
    return {
      valid: false,
      reason: `Invalid harvestDate: '${dateStr}' is not a parseable date`,
    };
  }

  // Guard against any silent rollover in the Date parser
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return {
      valid: false,
      reason: `Impossible calendar date: '${dateStr}' does not exist on the calendar`,
    };
  }

  return { valid: true, year, month, day, hour, minute, second };
}

/**
 * Validates raw agricultural batch metadata against domain constraints.
 *
 * @param {Object} rawMetadata - Input metadata object
 * @returns {Object} Validated raw metadata
 * @throws {Error} If validation fails with statusCode 422 and distinct error code
 */
function validateMetadataInput(rawMetadata) {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    const error = new Error("Metadata must be a non-null object");
    error.statusCode = 422;
    error.code = "INVALID_METADATA_PAYLOAD";
    throw error;
  }

  // 1. Check for unexpected / unapproved fields outside the 7 anchored fields
  const payloadKeys = Object.keys(rawMetadata);
  const unexpectedKeys = payloadKeys.filter(
    (key) => !APPROVED_FIELDS.includes(key)
  );
  if (unexpectedKeys.length > 0) {
    const error = new Error(
      `Unexpected field(s) in canonical metadata: ${unexpectedKeys
        .map((k) => `'${k}'`)
        .join(", ")}. Only the 7 approved anchored fields are permitted.`
    );
    error.statusCode = 422;
    error.code = "UNEXPECTED_METADATA_FIELD";
    throw error;
  }

  // 2. Check for missing approved fields
  for (const field of APPROVED_FIELDS) {
    if (rawMetadata[field] === undefined || rawMetadata[field] === null || rawMetadata[field] === "") {
      const error = new Error(`Missing required metadata field: '${field}'`);
      error.statusCode = 422;
      error.code = "MISSING_METADATA_FIELD";
      throw error;
    }
  }

  // 3. Validate category
  if (typeof rawMetadata.category !== "string" || rawMetadata.category.trim().length === 0) {
    const error = new Error("Field 'category' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_CATEGORY";
    throw error;
  }

  // 4. Validate cropVariety
  if (typeof rawMetadata.cropVariety !== "string" || rawMetadata.cropVariety.trim().length === 0) {
    const error = new Error("Field 'cropVariety' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_CROP_VARIETY";
    throw error;
  }

  // 5. Validate origin
  if (typeof rawMetadata.origin !== "string" || rawMetadata.origin.trim().length === 0) {
    const error = new Error("Field 'origin' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_ORIGIN";
    throw error;
  }

  // 6. Validate unit
  if (typeof rawMetadata.unit !== "string" || rawMetadata.unit.trim().length === 0) {
    const error = new Error("Field 'unit' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_UNIT";
    throw error;
  }

  // 7. Validate humanBatchId format (Trimmed, uppercase ASCII matching BATCH-[A-Z0-9-]+)
  if (typeof rawMetadata.humanBatchId !== "string") {
    const error = new Error("Field 'humanBatchId' must be a string");
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  const trimmedBatchId = rawMetadata.humanBatchId.trim().toUpperCase();
  // Ensure ASCII only
  if (!/^[\x00-\x7F]+$/.test(trimmedBatchId)) {
    const error = new Error("Field 'humanBatchId' must contain only ASCII characters");
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  if (!/^BATCH-[A-Z0-9-]+$/.test(trimmedBatchId)) {
    const error = new Error(
      `Invalid humanBatchId format: '${trimmedBatchId}'. Must match 'BATCH-[A-Z0-9-]+'`
    );
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }

  // 8. Validate harvestDate (strict calendar date, no rollover)
  if (typeof rawMetadata.harvestDate !== "string" && !(rawMetadata.harvestDate instanceof Date)) {
    const error = new Error("Field 'harvestDate' must be an ISO 8601 string or Date object");
    error.statusCode = 422;
    error.code = "INVALID_HARVEST_DATE";
    throw error;
  }

  const dateStr =
    typeof rawMetadata.harvestDate === "string"
      ? rawMetadata.harvestDate.trim()
      : rawMetadata.harvestDate.toISOString();

  const calendarCheck = validateStrictCalendarDate(dateStr);
  if (!calendarCheck.valid) {
    const error = new Error(calendarCheck.reason);
    error.statusCode = 422;
    error.code = "INVALID_HARVEST_DATE";
    throw error;
  }

  // 9. Validate quantity (lexical pre-validation on raw representation)
  if (typeof rawMetadata.quantity !== "number" && typeof rawMetadata.quantity !== "string") {
    const error = new Error("Field 'quantity' must be a positive number or numeric string");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  const rawQtyStr = String(rawMetadata.quantity).trim();

  // Reject scientific notation
  if (/[eE]/.test(rawQtyStr)) {
    const error = new Error("Scientific notation is strictly prohibited for quantity");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // Pattern check: positive decimal digits without leading zeros or signs
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(rawQtyStr)) {
    const error = new Error(
      `Invalid quantity format: '${rawQtyStr}'. Must be positive digits without leading zeros or symbols`
    );
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  // Check precision: max 3 decimal places (NO silent rounding)
  const [intPart, fracPart] = rawQtyStr.split(".");
  if (fracPart && fracPart.length > 3) {
    const error = new Error(
      `Quantity exceeds maximum precision of 3 decimal places: '${rawQtyStr}' (found ${fracPart.length})`
    );
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  const numVal = Number(rawQtyStr);
  if (numVal <= 0) {
    const error = new Error("Quantity must be strictly greater than zero");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  if (numVal > 1000000000) {
    const error = new Error("Quantity exceeds maximum permitted value of 1,000,000,000");
    error.statusCode = 422;
    error.code = "INVALID_QUANTITY";
    throw error;
  }

  return rawMetadata;
}

module.exports = {
  APPROVED_FIELDS,
  isLeapYear,
  validateStrictCalendarDate,
  validateMetadataInput,
};
