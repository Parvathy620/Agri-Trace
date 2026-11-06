const { ethers } = require("ethers");
const { env } = require("./env");

/**
 * Valid participant business roles matching the AgriTrace ecosystem.
 */
const ROLES = Object.freeze({
  FARMER: "FARMER",
  INSPECTOR: "INSPECTOR",
  TRANSPORTER: "TRANSPORTER",
  WAREHOUSE: "WAREHOUSE",
  RETAILER: "RETAILER",
  ADMIN: "ADMIN",
});

/**
 * On-chain bytes32 role identifiers matching AgriTrace.sol constants.
 * OpenZeppelin AccessControl defines DEFAULT_ADMIN_ROLE as 0x00...00 (ethers.ZeroHash).
 */
const CONTRACT_ROLES = Object.freeze({
  [ROLES.FARMER]: ethers.id("FARMER_ROLE"),
  [ROLES.INSPECTOR]: ethers.id("INSPECTOR_ROLE"),
  [ROLES.TRANSPORTER]: ethers.id("TRANSPORTER_ROLE"),
  [ROLES.WAREHOUSE]: ethers.id("WAREHOUSE_ROLE"),
  [ROLES.RETAILER]: ethers.id("RETAILER_ROLE"),
  [ROLES.ADMIN]: ethers.ZeroHash,
});

/**
 * Wallet linking challenge TTL: 5 minutes in milliseconds.
 */
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Domain identifier embedded into challenge messages to prevent cross-dApp replay attacks.
 */
const CHALLENGE_DOMAIN = "agritrace.io";

/**
 * Nonce reservation validity window: 15 minutes in milliseconds.
 */
const NONCE_RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * Required block confirmation depth before considering transactions confirmed on-chain.
 */
const CONFIRMATION_BLOCKS =
  env && typeof env.CONFIRMATION_BLOCKS === "number" ? env.CONFIRMATION_BLOCKS : 2;

/**
 * Fallback confirmation depth required to assume finality on networks where
 * the Ethereum 'finalized' block tag is unsupported (e.g. local Hardhat dev nodes).
 * NOTE: Fixed confirmation depth does NOT provide cryptographic Casper FFG finality.
 * It provides shallow reorganisation protection only on non-PoS development environments.
 */
const FALLBACK_FINALITY_BLOCKS =
  env && typeof env.FALLBACK_FINALITY_BLOCKS === "number" ? env.FALLBACK_FINALITY_BLOCKS : 5;

/**
 * Whether fallback confirmation depth is permitted when the RPC node does not support
 * the Casper FFG 'finalized' block tag. Can be explicitly disabled (e.g. in production).
 */
const ALLOW_FALLBACK_FINALITY =
  env && typeof env.ALLOW_FALLBACK_FINALITY === "boolean"
    ? env.ALLOW_FALLBACK_FINALITY
    : env && env.NODE_ENV === "production"
    ? false
    : true;

/**
 * Backend-observable transaction lifecycle states matching docs/transaction-submission-architecture.md.
 */
const TRANSACTION_STATUS = Object.freeze({
  RESERVED: "RESERVED",
  SUBMITTED: "SUBMITTED",
  PENDING_BLOCKCHAIN: "PENDING_BLOCKCHAIN",
  FAILED_AT_BROADCAST: "FAILED_AT_BROADCAST",
  CONFIRMED: "CONFIRMED",
  FAILED_ON_CHAIN: "FAILED_ON_CHAIN",
  REPLACED: "REPLACED",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
  CANCELLATION_PENDING: "CANCELLATION_PENDING",
  CANCELLED_ON_CHAIN: "CANCELLED_ON_CHAIN",
  EXPIRED: "EXPIRED",
});

/**
 * Types of transaction submissions handled by the non-custodial pipeline.
 */
const TRANSACTION_TYPE = Object.freeze({
  NEW_TRANSACTION: "NEW_TRANSACTION",
  REPLACEMENT_TRANSACTION: "REPLACEMENT_TRANSACTION",
  CANCELLATION_TRANSACTION: "CANCELLATION_TRANSACTION",
});

module.exports = {
  ROLES,
  CONTRACT_ROLES,
  WALLET_CHALLENGE_TTL_MS,
  CHALLENGE_DOMAIN,
  NONCE_RESERVATION_TTL_MS,
  CONFIRMATION_BLOCKS,
  FALLBACK_FINALITY_BLOCKS,
  ALLOW_FALLBACK_FINALITY,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
};

