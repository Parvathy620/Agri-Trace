/**
 * @file metadata.service.js
 * @description Agricultural batch metadata validation, canonicalization, and integrity service.
 * Handles deterministic JSON serialization, Keccak-256 batchId and metadataHash computation,
 * and tamper detection verification.
 */

const {
  canonicalizeMetadata,
  serializeCanonicalJson,
} = require("../utils/canonicalizer");
const {
  computeBatchId,
  computeMetadataHash,
  isValidBytes32,
} = require("../utils/hash.util");

/**
 * Validates, canonicalizes, and computes cryptographic hashes for agricultural batch metadata.
 *
 * @param {Object} rawMetadata - Raw batch metadata containing the 7 anchored fields
 * @returns {Object} Canonicalization result containing:
 *   - humanBatchId: Normalized human-readable batch identifier
 *   - batchId: 32-byte Keccak-256 hash of humanBatchId
 *   - canonicalJson: Deterministic compact JSON string with sorted keys
 *   - metadataHash: 32-byte Keccak-256 hash of canonicalJson
 *   - canonicalMetadata: Immutable canonical metadata object
 * @throws {Error} If validation or canonicalization fails (statusCode 422)
 */
function processMetadata(rawMetadata) {
  // 1. Validate and canonicalize the 7 anchored fields
  const canonicalMetadata = canonicalizeMetadata(rawMetadata);

  // 2. Deterministically serialize with sorted keys
  const canonicalJson = serializeCanonicalJson(canonicalMetadata);

  // 3. Compute 32-byte cryptographic hashes via ethers.keccak256
  const batchId = computeBatchId(canonicalMetadata.humanBatchId);
  const metadataHash = computeMetadataHash(canonicalJson);

  return {
    humanBatchId: canonicalMetadata.humanBatchId,
    batchId,
    canonicalJson,
    metadataHash,
    canonicalMetadata,
  };
}

/**
 * Verifies the cryptographic integrity of agricultural metadata against an expected metadataHash.
 * Recalculates the canonical hash and performs case-insensitive comparison.
 * Never mutates the input rawMetadata object.
 *
 * @param {Object} rawMetadata - Metadata object to verify
 * @param {string} expectedMetadataHash - Expected 32-byte Keccak-256 hex string
 * @returns {Object} Integrity verification result:
 *   - isValid: boolean indicating whether hashes match exactly
 *   - calculatedHash: Recalculated 32-byte hex hash (or null if parsing failed)
 *   - expectedHash: The expected hash provided
 *   - reason: Diagnostic explanation if verification failed (or null if valid)
 */
function verifyMetadataIntegrity(rawMetadata, expectedMetadataHash) {
  // Validate expectedMetadataHash format
  if (!expectedMetadataHash || !isValidBytes32(expectedMetadataHash)) {
    return {
      isValid: false,
      calculatedHash: null,
      expectedHash: expectedMetadataHash || null,
      reason: "Expected metadata hash must be a valid 32-byte hex string (0x followed by 64 hex characters)",
    };
  }

  // Recalculate hash without mutating rawMetadata
  try {
    const { metadataHash } = processMetadata(rawMetadata);
    const isValid = metadataHash.toLowerCase() === expectedMetadataHash.toLowerCase();

    return {
      isValid,
      calculatedHash: metadataHash,
      expectedHash: expectedMetadataHash,
      reason: isValid
        ? null
        : "Metadata hash mismatch: metadata content does not match the expected cryptographic hash",
    };
  } catch (error) {
    return {
      isValid: false,
      calculatedHash: null,
      expectedHash: expectedMetadataHash,
      reason: `Metadata canonicalization failed: ${error.message}`,
    };
  }
}

module.exports = {
  processMetadata,
  verifyMetadataIntegrity,
};

