/**
 * @file hash.util.js
 * @description Cryptographic hashing utilities using Ethereum Keccak-256 (ethers.js v6).
 * Strictly computes EVM-compatible Keccak-256 hashes for batch identifiers and metadata integrity.
 */

const { ethers } = require("ethers");

/**
 * Computes Ethereum Keccak-256 hash of a UTF-8 string.
 *
 * @param {string} str - Input string
 * @returns {string} 32-byte hex string with 0x prefix
 * @throws {Error} If input is not a string
 */
function keccak256Utf8(str) {
  if (typeof str !== "string") {
    const error = new Error("Input to keccak256Utf8 must be a string");
    error.statusCode = 422;
    error.code = "INVALID_HASH_INPUT";
    throw error;
  }
  const bytes = ethers.toUtf8Bytes(str);
  return ethers.keccak256(bytes);
}

/**
 * Computes deterministic 32-byte batchId from a human-readable batch ID.
 * Formula: batchId = keccak256(toUtf8Bytes(humanBatchId.trim().toUpperCase()))
 *
 * @param {string} humanBatchId - Human-readable batch ID (e.g. BATCH-2026-TOMATO-001)
 * @returns {string} 32-byte hex batchId with 0x prefix
 * @throws {Error} If input is invalid
 */
function computeBatchId(humanBatchId) {
  if (typeof humanBatchId !== "string" || humanBatchId.trim().length === 0) {
    const error = new Error("Field 'humanBatchId' must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_BATCH_ID";
    throw error;
  }
  const normalized = humanBatchId.trim().toUpperCase();
  return keccak256Utf8(normalized);
}

/**
 * Computes deterministic 32-byte metadataHash from a canonical JSON string.
 * Formula: metadataHash = keccak256(toUtf8Bytes(canonicalJson))
 *
 * @param {string} canonicalJson - Serialized canonical JSON string
 * @returns {string} 32-byte hex metadataHash with 0x prefix
 * @throws {Error} If input is invalid
 */
function computeMetadataHash(canonicalJson) {
  if (typeof canonicalJson !== "string" || canonicalJson.trim().length === 0) {
    const error = new Error("Canonical JSON must be a non-empty string");
    error.statusCode = 422;
    error.code = "INVALID_CANONICAL_JSON";
    throw error;
  }
  return keccak256Utf8(canonicalJson);
}

/**
 * Validates whether a value is a valid 32-byte hexadecimal string with 0x prefix.
 *
 * @param {any} hex - Value to check
 * @returns {boolean} True if valid 32-byte hex string
 */
function isValidBytes32(hex) {
  return typeof hex === "string" && /^0x[0-9a-fA-F]{64}$/.test(hex);
}

module.exports = {
  keccak256Utf8,
  computeBatchId,
  computeMetadataHash,
  isValidBytes32,
};

