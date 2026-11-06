/**
 * @file batch.service.js
 * @description Non-custodial batch transaction preparation service for AgriTrace.
 * Prepares unsigned Ethereum transactions for agricultural batch creation (`createBatch`).
 *
 * Enforces:
 *   - Zero private keys: Never stores, manages, or signs with participant private keys.
 *   - Metadata integrity: Validates 7 anchored fields, strict calendar dates, and computes Golden-Vector-matching hashes.
 *   - On-chain authorization: Preflights FARMER_ROLE on AgriTrace.sol.
 *   - Static-call simulation: Simulates createBatch on EVM before reserving nonces.
 *   - Gas estimation: Derives recommended gasLimit with safety margin.
 *   - Atomic nonce reservation: Monotonically reserves sequential nonce via OCC mutex.
 */

const { ethers } = require("ethers");
const { env: defaultEnv } = require("../config/env");
const { firestore: defaultFirestore } = require("../config/firebase");
const { contract: defaultContract, provider: defaultProvider } = require("../config/blockchain");
const {
  ROLES,
  CONTRACT_ROLES,
  TRANSACTION_STATUS,
  CONFIRMATION_BLOCKS,
  FALLBACK_FINALITY_BLOCKS,
  ALLOW_FALLBACK_FINALITY,
} = require("../config/constants");
const { processMetadata } = require("./metadata.service");
const { reserveNonce, validateEthereumAddress } = require("./nonce.service");
const { classifyFinalizedBlockError } = require("../utils/finality.util");
const logger = require("../utils/logger");

/**
 * Prepares an unsigned blockchain transaction for creating an agricultural batch.
 *
 * @param {Object} params
 * @param {string} params.uid - Authenticated Firebase user UID
 * @param {string} [params.userRole] - Authenticated user role from Firestore profile
 * @param {string} params.userWalletAddress - Linked Ethereum wallet of the authenticated user
 * @param {Object} params.rawMetadata - The 7 anchored agricultural metadata fields
 * @param {string} [params.requestedWalletAddress] - Optional wallet address from client payload
 * @param {string} [params.idempotencyKey] - Optional client idempotency key
 * @param {import("ethers").Contract} [params.contract=defaultContract] - Read-only AgriTrace contract instance
 * @param {import("ethers").Provider} [params.provider=defaultProvider] - ethers.js provider instance
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore=defaultFirestore] - Firestore instance
 * @param {number} [params.chainId=defaultEnv.CHAIN_ID] - Configured EVM chain ID
 * @param {string} [params.contractAddress=defaultEnv.AGRITRACE_CONTRACT_ADDRESS] - Target smart contract address
 * @returns {Promise<Object>} Structured unsigned transaction payload
 */
async function prepareBatchCreation({
  uid,
  userRole = null,
  userWalletAddress,
  rawMetadata,
  requestedWalletAddress = null,
  idempotencyKey = null,
  contract = defaultContract,
  provider = defaultProvider,
  firestore = defaultFirestore,
  chainId = defaultEnv.CHAIN_ID,
  contractAddress = defaultEnv.AGRITRACE_CONTRACT_ADDRESS,
}) {
  // 1. Identity & Linked Wallet Assertion
  if (!uid || typeof uid !== "string" || !uid.trim()) {
    const error = new Error("Authenticated user UID is required");
    error.statusCode = 401;
    error.code = "AUTH_TOKEN_INVALID";
    throw error;
  }

  if (!userWalletAddress) {
    const error = new Error("Wallet linking required: Authenticated user has no linked Ethereum wallet");
    error.statusCode = 403;
    error.code = "WALLET_NOT_LINKED";
    throw error;
  }

  const canonicalUserWallet = validateEthereumAddress(userWalletAddress);

  // 2. Wallet Mismatch Protection
  if (requestedWalletAddress) {
    const canonicalRequested = validateEthereumAddress(requestedWalletAddress);
    if (canonicalRequested.toLowerCase() !== canonicalUserWallet.toLowerCase()) {
      const error = new Error("Supplied walletAddress does not match authenticated user's linked wallet");
      error.statusCode = 403;
      error.code = "WALLET_MISMATCH";
      throw error;
    }
  }

  // 3. Firestore Business Role Assertion
  if (userRole && userRole !== ROLES.FARMER) {
    const error = new Error(`Role unauthorized: Endpoint requires role 'FARMER', but account has role '${userRole}'`);
    error.statusCode = 403;
    error.code = "ROLE_FORBIDDEN";
    throw error;
  }

  // 4. Metadata Validation & Cryptographic Canonicalization
  if (!rawMetadata || typeof rawMetadata !== "object" || Object.keys(rawMetadata).length === 0) {
    const error = new Error("Request body must contain valid agricultural batch metadata");
    error.statusCode = 400;
    error.code = "INVALID_METADATA";
    throw error;
  }

  const {
    humanBatchId,
    batchId,
    canonicalJson,
    metadataHash,
  } = processMetadata(rawMetadata);

  // 5. Off-Chain Duplicate Prevention (Firestore batches check)
  const existingBatchDoc = await firestore.collection("batches").doc(humanBatchId).get();
  if (existingBatchDoc.exists) {
    const error = new Error(`Batch with ID '${humanBatchId}' already exists`);
    error.statusCode = 409;
    error.code = "BATCH_ALREADY_EXISTS";
    error.details = { humanBatchId, batchId };
    throw error;
  }

  // 6. Generate Smart Contract Calldata via Contract Interface
  const calldata = contract.interface.encodeFunctionData("createBatch", [batchId, metadataHash]);
  const callDataHash = ethers.keccak256(calldata);

  // 7. On-Chain Role Preflight Verification
  try {
    const hasFarmerRole = await contract.hasRole(CONTRACT_ROLES[ROLES.FARMER], canonicalUserWallet);
    if (!hasFarmerRole) {
      const error = new Error(`Wallet ${canonicalUserWallet} does not possess required on-chain role 'FARMER'`);
      error.statusCode = 403;
      error.code = "ON_CHAIN_ROLE_UNAUTHORIZED";
      throw error;
    }
  } catch (roleErr) {
    if (roleErr.statusCode) throw roleErr;
    logger.error("RPC error during on-chain role verification", { error: roleErr.message });
    const error = new Error("Blockchain RPC node unavailable for on-chain role verification");
    error.statusCode = 503;
    error.code = "BLOCKCHAIN_RPC_UNAVAILABLE";
    error.details = { originalError: roleErr.message };
    throw error;
  }

  // 8. Static-Call Preflight Simulation (eth_call)
  try {
    await contract.createBatch.staticCall(batchId, metadataHash, { from: canonicalUserWallet });
  } catch (simErr) {
    const errMsg = (simErr.reason || simErr.shortMessage || simErr.message || "").toLowerCase();

    if (errMsg.includes("batch already exists")) {
      const error = new Error(`Batch with ID '${humanBatchId}' already exists on-chain`);
      error.statusCode = 409;
      error.code = "BATCH_ALREADY_EXISTS";
      error.details = { humanBatchId, batchId };
      throw error;
    }

    if (errMsg.includes("missing role") || errMsg.includes("accesscontrol")) {
      const error = new Error(`Wallet ${canonicalUserWallet} does not possess required on-chain role 'FARMER'`);
      error.statusCode = 403;
      error.code = "ON_CHAIN_ROLE_UNAUTHORIZED";
      throw error;
    }

    const isNetworkFailure =
      errMsg.includes("timeout") ||
      errMsg.includes("econnrefused") ||
      errMsg.includes("network") ||
      errMsg.includes("socket") ||
      errMsg.includes("fetch failed");

    if (isNetworkFailure) {
      logger.error("RPC error during staticCall preflight", { error: simErr.message });
      const error = new Error("Blockchain RPC unavailable during transaction preflight");
      error.statusCode = 503;
      error.code = "BLOCKCHAIN_RPC_UNAVAILABLE";
      error.details = { originalError: simErr.message };
      throw error;
    }

    logger.warn("Static call simulation failed", { error: simErr.message, humanBatchId, batchId });
    const error = new Error(`Transaction preflight simulation failed: ${simErr.reason || simErr.shortMessage || simErr.message}`);
    error.statusCode = 422;
    error.code = "PREFLIGHT_SIMULATION_FAILED";
    error.details = { reason: simErr.reason || simErr.message };
    throw error;
  }

  // 9. Gas Estimation with Safety Margin
  let gasLimit = null;
  try {
    if (typeof contract.createBatch.estimateGas === "function") {
      const estimatedGas = await contract.createBatch.estimateGas(batchId, metadataHash, { from: canonicalUserWallet });
      // Add 20% buffer for gas safety
      gasLimit = ((BigInt(estimatedGas) * 120n) / 100n).toString();
    }
  } catch (gasErr) {
    logger.warn("Gas estimation failed during batch preparation, proceeding without gasLimit", {
      error: gasErr.message,
      humanBatchId,
    });
    gasLimit = null;
  }

  // 10. Atomic Nonce Reservation via Firestore Mutex
  const reservation = await reserveNonce({
    uid,
    walletAddress: canonicalUserWallet,
    targetFunction: "createBatch",
    expectedArgs: {
      humanBatchId,
      batchId,
      metadataHash,
      canonicalJson,
    },
    idempotencyKey,
    callDataHash,
    firestore,
    provider,
  });

  // Idempotency Conflict Check: If an existing reservation was returned for this key,
  // ensure it was for the exact same batchId and calldata.
  if (reservation.callDataHash && reservation.callDataHash !== callDataHash) {
    const error = new Error("Idempotency conflict: provided Idempotency-Key was already used for a different transaction payload");
    error.statusCode = 409;
    error.code = "IDEMPOTENCY_CONFLICT";
    throw error;
  }

  // 11. Format Non-Custodial Structured Unsigned Transaction Payload
  const unsignedTx = {
    reservationId: reservation.reservationId,
    humanBatchId,
    batchId,
    metadataHash,
    chainId,
    contractAddress,
    from: canonicalUserWallet,
    to: contractAddress,
    data: calldata,
    value: "0x0",
    nonce: reservation.nonce,
    gasLimit,
    expiresAt: reservation.expiresAt,
  };

  logger.info("Batch transaction prepared successfully", {
    reservationId: reservation.reservationId,
    humanBatchId,
    batchId,
    nonce: reservation.nonce,
    from: canonicalUserWallet,
    chainId,
  });

  return unsignedTx;
}

/**
 * Independently verifies receipt canonical status, confirmation depth, and blockchain finality.
 * Reuses the approved finality and reorganisation verification policy:
 *   1. Canonical block continuity (canonicalBlock.hash === receipt.blockHash)
 *   2. Base confirmation depth (confirmationCount >= requiredConfirmations)
 *   3. Casper FFG finality checkpoint (receipt.blockNumber <= finalizedBlock.number)
 *      or fallback confirmation depth (confirmationCount >= fallbackFinalityConfirmations)
 *
 * @param {Object} params
 * @param {Object} params.receipt - Transaction receipt
 * @param {import("ethers").Provider} params.provider - Blockchain provider
 * @param {number} [params.requiredConfirmations=CONFIRMATION_BLOCKS]
 * @param {number} [params.fallbackFinalityConfirmations=FALLBACK_FINALITY_BLOCKS]
 * @returns {Promise<{
 *   isCanonical: boolean,
 *   isFinalized: boolean,
 *   confirmationCount: number,
 *   reason?: string,
 *   canonicalBlock?: Object
 * }>}
 */
async function verifyReceiptFinality({
  receipt,
  provider,
  requiredConfirmations = CONFIRMATION_BLOCKS,
  fallbackFinalityConfirmations = FALLBACK_FINALITY_BLOCKS,
  allowFallbackFinality = ALLOW_FALLBACK_FINALITY,
}) {
  if (!receipt || receipt.blockNumber === undefined || receipt.blockNumber === null) {
    return {
      isCanonical: false,
      isFinalized: false,
      confirmationCount: 0,
      reason: "RECEIPT_NOT_MINED",
    };
  }

  let canonicalBlock = null;
  let currentBlockNumber = 0;
  try {
    [canonicalBlock, currentBlockNumber] = await Promise.all([
      provider.getBlock(receipt.blockNumber),
      provider.getBlockNumber(),
    ]);
  } catch (err) {
    return {
      isCanonical: false,
      isFinalized: false,
      confirmationCount: 0,
      reason: "CANONICAL_BLOCK_UNAVAILABLE",
      details: { error: err.message },
    };
  }

  if (!canonicalBlock || !canonicalBlock.hash) {
    return {
      isCanonical: false,
      isFinalized: false,
      confirmationCount: 0,
      reason: "CANONICAL_BLOCK_UNAVAILABLE",
    };
  }

  if (!receipt.blockHash || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return {
      isCanonical: false,
      isFinalized: false,
      confirmationCount: 0,
      reason: "REORGANISATION_DETECTED",
      canonicalBlock,
    };
  }

  const confirmationCount = Math.max(0, currentBlockNumber - receipt.blockNumber + 1);
  if (confirmationCount < requiredConfirmations) {
    return {
      isCanonical: true,
      isFinalized: false,
      confirmationCount,
      reason: "INSUFFICIENT_CONFIRMATIONS",
      canonicalBlock,
    };
  }

  // Query Casper FFG finalized block where supported
  let finalizedBlock = null;
  let explicitUnsupportedEstablished = false;
  let finalizedQueryFailed = false;
  let finalizedFailureReason = null;
  let finalizedFailureDetails = null;

  try {
    finalizedBlock = await provider.getBlock("finalized");
  } catch (finalizedErr) {
    const classification = classifyFinalizedBlockError(finalizedErr);
    if (classification.isUnsupported) {
      // Positively established that the finalized tag is unsupported on this RPC
      explicitUnsupportedEstablished = true;
    } else {
      // Network failure, auth error, rate limiting, or unknown error
      finalizedQueryFailed = true;
      finalizedFailureReason = classification.reason || "RPC_UNKNOWN_ERROR";
      finalizedFailureDetails = { error: finalizedErr.message };
    }
  }

  if (finalizedQueryFailed) {
    return {
      isCanonical: true,
      isFinalized: false,
      confirmationCount,
      reason: finalizedFailureReason,
      details: finalizedFailureDetails,
      canonicalBlock,
    };
  }

  if (finalizedBlock !== null && finalizedBlock !== undefined) {
    // Validate finalizedBlock structure for invalid or inconsistent responses
    if (
      typeof finalizedBlock !== "object" ||
      typeof finalizedBlock.number !== "number" ||
      !Number.isInteger(finalizedBlock.number) ||
      isNaN(finalizedBlock.number) ||
      finalizedBlock.number < 0
    ) {
      return {
        isCanonical: true,
        isFinalized: false,
        confirmationCount,
        reason: "INVALID_FINALIZED_BLOCK_RESPONSE",
        details: { finalizedBlock },
        canonicalBlock,
      };
    }

    if (finalizedBlock.number > currentBlockNumber) {
      return {
        isCanonical: true,
        isFinalized: false,
        confirmationCount,
        reason: "INCONSISTENT_FINALITY_RESPONSE",
        details: {
          finalizedBlockNumber: finalizedBlock.number,
          currentBlockNumber,
        },
        canonicalBlock,
      };
    }

    // Valid Casper FFG finalized block received
    if (receipt.blockNumber <= finalizedBlock.number) {
      return {
        isCanonical: true,
        isFinalized: true,
        confirmationCount,
        finalityMethod: "ETH_FINALIZED_TAG",
        finalizedBlockNumber: finalizedBlock.number,
        canonicalBlock,
      };
    }
    return {
      isCanonical: true,
      isFinalized: false,
      confirmationCount,
      reason: "AWAITING_FINALITY",
      finalityMethod: "ETH_FINALIZED_TAG",
      finalizedBlockNumber: finalizedBlock.number,
      canonicalBlock,
    };
  }

  // finalizedBlock is null or undefined
  if (!explicitUnsupportedEstablished) {
    // Section B: Null response is ambiguous! A null result from getBlock("finalized")
    // must NOT automatically establish that the provider does not support finalized tags.
    // Fails closed and retains the reservation lock.
    return {
      isCanonical: true,
      isFinalized: false,
      confirmationCount,
      reason: "FINALIZED_BLOCK_UNAVAILABLE",
      details: {
        message: "RPC provider returned null for 'finalized' block tag without positively indicating unsupported capability.",
      },
      canonicalBlock,
    };
  }

  // Section A: Positively established unsupported finalized tag -> check fallback policy
  if (!allowFallbackFinality) {
    return {
      isCanonical: true,
      isFinalized: false,
      confirmationCount,
      reason: "FINALITY_TAG_REQUIRED",
      details: {
        message: "RPC node does not support Casper FFG 'finalized' block tag and fallback finality is disabled.",
      },
      canonicalBlock,
    };
  }

  if (confirmationCount >= fallbackFinalityConfirmations) {
    return {
      isCanonical: true,
      isFinalized: true,
      confirmationCount,
      finalityMethod: "FALLBACK_DEPTH",
      fallbackFinalityConfirmations,
      canonicalBlock,
    };
  }

  return {
    isCanonical: true,
    isFinalized: false,
    confirmationCount,
    reason: "INSUFFICIENT_FALLBACK_CONFIRMATIONS",
    finalityMethod: "FALLBACK_DEPTH",
    fallbackFinalityConfirmations,
    canonicalBlock,
  };
}

/**
 * Helper to scan recent blocks for an external transaction from the specified wallet
 * that consumed the given nonce, and retrieve its mined receipt status.
 */
async function findConsumingTransaction({ provider, walletAddress, nonce, logger }) {
  let consumingTxHash = null;
  let consumingReceipt = null;

  try {
    const currentBlock = await provider.getBlockNumber();
    for (let b = currentBlock; b >= Math.max(0, currentBlock - 10); b--) {
      const block = await provider.getBlock(b, true);
      if (block && block.prefetchedTransactions && block.prefetchedTransactions.length > 0) {
        const found = block.prefetchedTransactions.find(
          (t) => t.from && t.from.toLowerCase() === walletAddress.toLowerCase() && Number(t.nonce) === nonce
        );
        if (found) {
          consumingTxHash = found.hash.toLowerCase();
          try {
            consumingReceipt = await provider.getTransactionReceipt(found.hash);
          } catch (_) {}
          break;
        }
      } else if (block && block.transactions && block.transactions.length > 0) {
        for (const txItem of block.transactions) {
          const txObj = typeof txItem === "string" ? await provider.getTransaction(txItem) : txItem;
          if (txObj && txObj.from && txObj.from.toLowerCase() === walletAddress.toLowerCase() && Number(txObj.nonce) === nonce) {
            consumingTxHash = txObj.hash.toLowerCase();
            try {
              consumingReceipt = await provider.getTransactionReceipt(txObj.hash);
            } catch (_) {}
            break;
          }
        }
        if (consumingTxHash) break;
      }
    }
  } catch (scanErr) {
    if (logger) {
      logger.warn("Unable to scan recent blocks for consuming transaction", { error: scanErr.message });
    }
  }

  return {
    consumingTxHash,
    consumingReceipt,
    consumingReceiptStatus: consumingReceipt ? Number(consumingReceipt.status) : null,
  };
}

/**
 * Atomically marks reservation and batch in RECONCILIATION_REQUIRED when
 * external nonce consumption is insufficiently confirmed or reorganised.
 * Preserves the wallet nonce lock (nonceConsumed: false).
 */
async function recordUnconfirmedExternalNonceConsumption({
  firestore,
  resRef,
  reservation,
  intendedTxHash,
  latestMinedNonce,
  consumingTxHash,
  consumingReceiptStatus,
  confirmationCount,
  reason,
}) {
  const now = new Date().toISOString();
  const humanBatchId = reservation.expectedArgs?.humanBatchId;

  await firestore.runTransaction(async (transaction) => {
    transaction.update(resRef, {
      status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
      reconciliationReason: reason,
      nonceConsumed: false,
      consumedOnChain: false,
      externallyConsumed: false,
      consumingTxHash: consumingTxHash || null,
      consumingReceiptStatus: consumingReceiptStatus !== undefined ? consumingReceiptStatus : null,
      confirmationCount: confirmationCount !== undefined ? confirmationCount : 0,
      verifiedLatestMinedNonce: latestMinedNonce,
      updatedAt: now,
    });

    if (humanBatchId) {
      const batchRef = firestore.collection("batches").doc(humanBatchId);
      transaction.set(
        batchRef,
        {
          humanBatchId,
          batchId: reservation.expectedArgs?.batchId,
          status: "RECONCILIATION_REQUIRED",
          failureReason: reason,
          intendedTxHash,
          consumingTxHash: consumingTxHash || null,
          updatedAt: now,
        },
        { merge: true }
      );
    }
  });
}

/**
 * Atomically records external nonce consumption across both the reservation
 * and agricultural batch documents within a single atomic Firestore transaction.
 * Strictly guarantees that no processedTransactions record is created for the unincluded intended transaction.
 */
async function recordExternalNonceConsumption({
  firestore,
  resRef,
  reservation,
  intendedTxHash,
  latestMinedNonce,
  consumingTxHash,
  consumingReceiptStatus,
  broadcastErrorMsg,
  finalityMethod = null,
}) {
  const now = new Date().toISOString();
  const humanBatchId = reservation.expectedArgs?.humanBatchId;

  await firestore.runTransaction(async (transaction) => {
    transaction.update(resRef, {
      status: TRANSACTION_STATUS.FAILED_AT_BROADCAST,
      broadcastError: broadcastErrorMsg || "Nonce externally consumed by another transaction",
      nonceConsumed: true,
      consumedOnChain: true,
      externallyConsumed: true,
      consumingTxHash: consumingTxHash || null,
      consumingReceiptStatus: consumingReceiptStatus !== undefined ? consumingReceiptStatus : null,
      finalityMethod: finalityMethod || null,
      resolutionReason: "NONCE_EXTERNALLY_CONSUMED",
      verifiedLatestMinedNonce: latestMinedNonce,
      updatedAt: now,
    });

    if (humanBatchId) {
      const batchRef = firestore.collection("batches").doc(humanBatchId);
      transaction.set(
        batchRef,
        {
          humanBatchId,
          batchId: reservation.expectedArgs?.batchId,
          status: "CREATION_FAILED",
          failureReason: "NONCE_EXTERNALLY_CONSUMED",
          intendedTxHash,
          consumingTxHash: consumingTxHash || null,
          updatedAt: now,
        },
        { merge: true }
      );
    }
  });
}

/**
 * Submits a participant-signed raw transaction for broadcasting to the EVM blockchain.
 * Validates 12 security gates, guards reservation lifecycle states, prevents duplicate
 * submissions, broadcasts via provider.broadcastTransaction, and handles timeouts safely.
 *
 * Operates purely non-custodially: NEVER signs or generates transactions server-side.
 *
 * @param {Object} params
 * @param {string} params.uid - Authenticated Firebase user UID
 * @param {string} params.userWalletAddress - Authenticated user's linked Ethereum wallet
 * @param {string} params.signedTxHex - Raw signed Ethereum transaction hex string
 * @param {string} params.reservationId - Target nonce reservation ID
 * @param {string} [params.idempotencyKey] - Optional client idempotency key
 * @param {import("ethers").Contract} [params.contract=defaultContract] - Read-only contract interface
 * @param {import("ethers").Provider} [params.provider=defaultProvider] - ethers.js provider instance
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore=defaultFirestore] - Firestore instance
 * @param {number} [params.chainId=defaultEnv.CHAIN_ID] - Configured EVM chain ID
 * @param {string} [params.contractAddress=defaultEnv.AGRITRACE_CONTRACT_ADDRESS] - Target smart contract address
 * @returns {Promise<Object>} Submission outcome object
 */
async function submitBatchCreation({
  uid,
  userWalletAddress,
  signedTxHex,
  reservationId,
  idempotencyKey = null,
  contract = defaultContract,
  provider = defaultProvider,
  firestore = defaultFirestore,
  chainId = defaultEnv.CHAIN_ID,
  contractAddress = defaultEnv.AGRITRACE_CONTRACT_ADDRESS,
}) {
  // ---------------------------------------------------------------------------
  // GATE 1: Parameter Validation
  // ---------------------------------------------------------------------------
  if (!uid || typeof uid !== "string" || !uid.trim()) {
    const error = new Error("Authenticated user UID is required");
    error.statusCode = 401;
    error.code = "AUTH_TOKEN_INVALID";
    throw error;
  }

  if (!userWalletAddress) {
    const error = new Error("Wallet linking required: Authenticated user has no linked Ethereum wallet");
    error.statusCode = 403;
    error.code = "WALLET_NOT_LINKED";
    throw error;
  }
  const canonicalUserWallet = validateEthereumAddress(userWalletAddress).toLowerCase();

  if (!signedTxHex || typeof signedTxHex !== "string" || !signedTxHex.startsWith("0x")) {
    const error = new Error("Valid signed raw transaction hex string (signedTxHex) is required");
    error.statusCode = 400;
    error.code = "INVALID_RAW_TRANSACTION";
    throw error;
  }

  if (!reservationId || typeof reservationId !== "string" || !reservationId.trim()) {
    const error = new Error("Valid reservationId is required for transaction submission");
    error.statusCode = 400;
    error.code = "MISSING_RESERVATION_ID";
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 2: ethers.js Transaction Parsing & Signature Recovery
  // ---------------------------------------------------------------------------
  let parsedTx;
  try {
    parsedTx = ethers.Transaction.from(signedTxHex);
  } catch (parseErr) {
    const error = new Error(`Malformed raw signed transaction: ${parseErr.message}`);
    error.statusCode = 400;
    error.code = "INVALID_RAW_TRANSACTION";
    throw error;
  }

  if (!parsedTx.isSigned() || !parsedTx.signature) {
    const error = new Error("Transaction is unsigned or has an incomplete signature");
    error.statusCode = 400;
    error.code = "INVALID_TRANSACTION_SIGNATURE";
    throw error;
  }

  const recoveredSender = parsedTx.from ? parsedTx.from.toLowerCase() : null;
  if (!recoveredSender) {
    const error = new Error("Unable to recover sender address from transaction signature");
    error.statusCode = 400;
    error.code = "INVALID_TRANSACTION_SIGNATURE";
    throw error;
  }

  const txHash = parsedTx.hash.toLowerCase();

  // ---------------------------------------------------------------------------
  // GATE 3: Fetch Reservation from Firestore & Ownership Check
  // ---------------------------------------------------------------------------
  const resRef = firestore.collection("nonceReservations").doc(reservationId);
  const resDoc = await resRef.get();
  if (!resDoc.exists) {
    const error = new Error("Nonce reservation not found");
    error.statusCode = 404;
    error.code = "RESERVATION_NOT_FOUND";
    throw error;
  }
  const reservation = resDoc.data();

  if (reservation.uid !== uid) {
    const error = new Error("Reservation belongs to another user account");
    error.statusCode = 403;
    error.code = "RESERVATION_OWNERSHIP_MISMATCH";
    throw error;
  }

  const reservationWallet = reservation.walletAddress.toLowerCase();
  if (reservationWallet !== canonicalUserWallet) {
    const error = new Error("Reservation wallet address does not match user's linked wallet");
    error.statusCode = 403;
    error.code = "WALLET_MISMATCH";
    throw error;
  }

  if (recoveredSender !== canonicalUserWallet) {
    const error = new Error(`Transaction signer ${recoveredSender} does not match authenticated user's linked wallet ${canonicalUserWallet}`);
    error.statusCode = 403;
    error.code = "INCORRECT_RECOVERED_SENDER";
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 4: Chain ID Validation
  // ---------------------------------------------------------------------------
  if (Number(parsedTx.chainId) !== Number(chainId)) {
    const error = new Error(`Chain ID mismatch: expected ${chainId}, received ${parsedTx.chainId}`);
    error.statusCode = 400;
    error.code = "CHAIN_ID_MISMATCH";
    error.details = { expected: chainId, received: parsedTx.chainId.toString() };
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 5: Contract Destination (Anti-Contract-Confusion)
  // ---------------------------------------------------------------------------
  const destination = parsedTx.to ? ethers.getAddress(parsedTx.to).toLowerCase() : null;
  const expectedContract = ethers.getAddress(contractAddress).toLowerCase();
  if (!destination || destination !== expectedContract) {
    const error = new Error(`Contract destination mismatch: expected ${expectedContract}, received ${destination}`);
    error.statusCode = 400;
    error.code = "INVALID_CONTRACT_DESTINATION";
    error.details = { expected: expectedContract, received: destination };
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 6: Value Must Be Exactly Zero
  // ---------------------------------------------------------------------------
  if (BigInt(parsedTx.value || 0n) !== 0n) {
    const error = new Error(`Transaction value must be exactly 0 native Ether, received: ${parsedTx.value.toString()}`);
    error.statusCode = 400;
    error.code = "NON_ZERO_TRANSACTION_VALUE";
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 7: Reserved Nonce Matching
  // ---------------------------------------------------------------------------
  if (Number(parsedTx.nonce) !== reservation.nonce) {
    const error = new Error(`Transaction nonce mismatch: expected reserved nonce ${reservation.nonce}, received ${parsedTx.nonce}`);
    error.statusCode = 400;
    error.code = "NONCE_MISMATCH";
    error.details = { expected: reservation.nonce, received: parsedTx.nonce };
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 8: Calldata Hash and Target Function Decoding
  // ---------------------------------------------------------------------------
  const callDataHash = ethers.keccak256(parsedTx.data);
  if (reservation.callDataHash && callDataHash.toLowerCase() !== reservation.callDataHash.toLowerCase()) {
    const error = new Error("Transaction calldata hash does not match the prepared reservation");
    error.statusCode = 400;
    error.code = "ALTERED_CALLDATA";
    throw error;
  }

  let decodedData;
  try {
    decodedData = contract.interface.parseTransaction({ data: parsedTx.data, value: parsedTx.value });
  } catch (decodeErr) {
    const error = new Error(`Failed to decode transaction calldata: ${decodeErr.message}`);
    error.statusCode = 400;
    error.code = "CALLDATA_DECODING_FAILED";
    throw error;
  }

  if (!decodedData || decodedData.name !== reservation.targetFunction) {
    const error = new Error(`Transaction target function mismatch: expected '${reservation.targetFunction}', received '${decodedData ? decodedData.name : "unknown"}'`);
    error.statusCode = 400;
    error.code = "TARGET_FUNCTION_MISMATCH";
    throw error;
  }

  // ---------------------------------------------------------------------------
  // GATE 9: Argument Integrity Check
  // ---------------------------------------------------------------------------
  if (reservation.targetFunction === "createBatch" && reservation.expectedArgs) {
    const [bId, mHash] = decodedData.args;
    if (bId.toLowerCase() !== reservation.expectedArgs.batchId.toLowerCase()) {
      const error = new Error(`Batch ID mismatch: expected ${reservation.expectedArgs.batchId}, received ${bId}`);
      error.statusCode = 400;
      error.code = "ARGUMENT_MISMATCH";
      throw error;
    }
    if (mHash.toLowerCase() !== reservation.expectedArgs.metadataHash.toLowerCase()) {
      const error = new Error(`Metadata hash mismatch: expected ${reservation.expectedArgs.metadataHash}, received ${mHash}`);
      error.statusCode = 400;
      error.code = "ARGUMENT_MISMATCH";
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // GATE 10: Lifecycle Evaluation & Crash Recovery
  // ---------------------------------------------------------------------------

  // Incompatible Uncancellable States
  if (reservation.status === TRANSACTION_STATUS.EXPIRED) {
    const error = new Error("Reservation has expired and cannot be submitted");
    error.statusCode = 409;
    error.code = "RESERVATION_EXPIRED";
    throw error;
  }

  if (
    reservation.status === TRANSACTION_STATUS.CANCELLATION_PENDING ||
    reservation.status === TRANSACTION_STATUS.CANCELLED_ON_CHAIN ||
    reservation.status === TRANSACTION_STATUS.RECONCILIATION_REQUIRED
  ) {
    const error = new Error(`Reservation cannot be submitted in status: ${reservation.status}`);
    error.statusCode = 409;
    error.code = "INVALID_RESERVATION_STATUS";
    throw error;
  }

  // Already Broadcast / Pending Blockchain
  if (
    reservation.status === TRANSACTION_STATUS.PENDING_BLOCKCHAIN ||
    reservation.status === TRANSACTION_STATUS.CONFIRMED
  ) {
    if (reservation.txHash && reservation.txHash.toLowerCase() !== txHash) {
      const error = new Error(`Reservation has already been submitted with a different transaction hash: ${reservation.txHash}`);
      error.statusCode = 409;
      error.code = "RESERVATION_ALREADY_SUBMITTED";
      throw error;
    }

    logger.info("Idempotent signed transaction resubmission received for PENDING_BLOCKCHAIN", {
      reservationId,
      txHash,
      status: reservation.status,
    });

    // Ensure documents are synced in case previous Firestore writes crashed post-broadcast
    const now = new Date().toISOString();
    const humanBatchId = reservation.expectedArgs?.humanBatchId;
    if (humanBatchId) {
      const batchRef = firestore.collection("batches").doc(humanBatchId);
      await batchRef.set(
        {
          humanBatchId,
          batchId: reservation.expectedArgs?.batchId,
          metadataHash: reservation.expectedArgs?.metadataHash,
          status: "PENDING_BLOCKCHAIN",
          currentCustodian: canonicalUserWallet,
          farmer: canonicalUserWallet,
          latestTxHash: txHash,
          createdAt: reservation.broadcastAt || now,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    const procTxRef = firestore.collection("processedTransactions").doc(`${chainId}_${txHash}`);
    await procTxRef.set(
      {
        docId: `${chainId}_${txHash}`,
        chainId,
        txHash,
        humanBatchId: reservation.expectedArgs?.humanBatchId || null,
        batchId: reservation.expectedArgs?.batchId || null,
        sender: canonicalUserWallet,
        nonce: reservation.nonce,
        targetFunction: reservation.targetFunction,
        targetStatus: "CREATED",
        targetStatusCode: 0,
        applied: false,
        superseded: false,
        canonicalBlockVerified: false,
        createdAt: reservation.broadcastAt || now,
        updatedAt: now,
      },
      { merge: true }
    );

    return {
      humanBatchId: reservation.expectedArgs?.humanBatchId || null,
      batchId: reservation.expectedArgs?.batchId || null,
      txHash,
      reservationId,
      status: reservation.status,
      alreadySubmitted: true,
    };
  }

  // Handling Crash Recovery for SUBMITTED state
  let isCrashRecovery = false;
  let rawTxToBroadcast = signedTxHex;

  if (reservation.status === TRANSACTION_STATUS.SUBMITTED) {
    if (reservation.txHash && reservation.txHash.toLowerCase() !== txHash) {
      const error = new Error(`Reservation has already been claimed for a different transaction hash: ${reservation.txHash}`);
      error.statusCode = 409;
      error.code = "RESERVATION_ALREADY_SUBMITTED";
      throw error;
    }

    isCrashRecovery = true;
    rawTxToBroadcast = reservation.signedTxHex || signedTxHex;

    logger.info("Crash recovery triggered for SUBMITTED reservation: investigating on-chain/mempool state...", {
      reservationId,
      txHash,
    });

    // Query RPC provider to check if transaction already reached the node
    let existingRpcTx = null;
    let existingReceipt = null;
    try {
      [existingRpcTx, existingReceipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
      ]);
    } catch (rpcQueryErr) {
      logger.warn("RPC investigation query failed during crash recovery", {
        txHash,
        error: rpcQueryErr.message,
      });
    }

    // 1. If an intended transaction receipt is found, independently verify canonical block continuity and finality
    if (existingReceipt) {
      const receiptVerification = await verifyReceiptFinality({
        receipt: existingReceipt,
        provider,
      });

      if (!receiptVerification.isCanonical) {
        logger.error("Intended transaction receipt is NOT canonical or block unavailable during recovery", {
          txHash,
          reason: receiptVerification.reason,
          minedBlockHash: existingReceipt.blockHash,
        });

        const recoveryTime = new Date().toISOString();
        const humanBatchId = reservation.expectedArgs?.humanBatchId;
        await firestore.runTransaction(async (transaction) => {
          transaction.update(resRef, {
            status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
            reconciliationReason: receiptVerification.reason,
            broadcastAccepted: false,
            minedBlockHash: existingReceipt.blockHash || null,
            canonicalBlockHash: receiptVerification.canonicalBlock?.hash || null,
            updatedAt: recoveryTime,
          });
          if (humanBatchId) {
            const batchRef = firestore.collection("batches").doc(humanBatchId);
            transaction.set(
              batchRef,
              {
                humanBatchId,
                batchId: reservation.expectedArgs?.batchId,
                status: "RECONCILIATION_REQUIRED",
                failureReason: receiptVerification.reason,
                intendedTxHash: txHash,
                updatedAt: recoveryTime,
              },
              { merge: true }
            );
          }
        });

        const error = new Error(`Transaction recovery detected canonical block anomaly: ${receiptVerification.reason}`);
        error.statusCode = 409;
        error.code = receiptVerification.reason;
        error.details = {
          txHash,
          reservationId,
          reason: receiptVerification.reason,
        };
        throw error;
      }

      // Canonical block confirmed: converge state
      const recoveryTime = new Date().toISOString();
      await resRef.update({
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        broadcastAccepted: true,
        broadcastAt: reservation.broadcastAt || recoveryTime,
        canonicalBlockVerified: receiptVerification.isCanonical,
        confirmationCount: receiptVerification.confirmationCount,
        isFinalized: receiptVerification.isFinalized,
        updatedAt: recoveryTime,
      });

      const humanBatchId = reservation.expectedArgs?.humanBatchId;
      if (humanBatchId) {
        const batchRef = firestore.collection("batches").doc(humanBatchId);
        await batchRef.set(
          {
            humanBatchId,
            batchId: reservation.expectedArgs?.batchId,
            metadataHash: reservation.expectedArgs?.metadataHash,
            status: "PENDING_BLOCKCHAIN",
            currentCustodian: canonicalUserWallet,
            farmer: canonicalUserWallet,
            latestTxHash: txHash,
            createdAt: reservation.broadcastAt || recoveryTime,
            updatedAt: recoveryTime,
          },
          { merge: true }
        );
      }

      const procTxRef = firestore.collection("processedTransactions").doc(`${chainId}_${txHash}`);
      await procTxRef.set(
        {
          docId: `${chainId}_${txHash}`,
          chainId,
          txHash,
          humanBatchId: reservation.expectedArgs?.humanBatchId || null,
          batchId: reservation.expectedArgs?.batchId || null,
          sender: canonicalUserWallet,
          nonce: reservation.nonce,
          targetFunction: reservation.targetFunction,
          targetStatus: "CREATED",
          targetStatusCode: 0,
          applied: false,
          superseded: false,
          canonicalBlockVerified: receiptVerification.isCanonical,
          confirmationCount: receiptVerification.confirmationCount,
          createdAt: reservation.broadcastAt || recoveryTime,
          updatedAt: recoveryTime,
        },
        { merge: true }
      );

      return {
        humanBatchId: reservation.expectedArgs?.humanBatchId || null,
        batchId: reservation.expectedArgs?.batchId || null,
        txHash,
        reservationId,
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        alreadySubmitted: true,
      };
    }

    // 2. If intended transaction is present in the node mempool (unmined)
    if (existingRpcTx) {
      logger.info("Transaction verified as present in node mempool during crash recovery", { txHash });
      const recoveryTime = new Date().toISOString();
      await resRef.update({
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        broadcastAccepted: true,
        broadcastAt: reservation.broadcastAt || recoveryTime,
        updatedAt: recoveryTime,
      });

      const humanBatchId = reservation.expectedArgs?.humanBatchId;
      if (humanBatchId) {
        const batchRef = firestore.collection("batches").doc(humanBatchId);
        await batchRef.set(
          {
            humanBatchId,
            batchId: reservation.expectedArgs?.batchId,
            metadataHash: reservation.expectedArgs?.metadataHash,
            status: "PENDING_BLOCKCHAIN",
            currentCustodian: canonicalUserWallet,
            farmer: canonicalUserWallet,
            latestTxHash: txHash,
            createdAt: reservation.broadcastAt || recoveryTime,
            updatedAt: recoveryTime,
          },
          { merge: true }
        );
      }

      const procTxRef = firestore.collection("processedTransactions").doc(`${chainId}_${txHash}`);
      await procTxRef.set(
        {
          docId: `${chainId}_${txHash}`,
          chainId,
          txHash,
          humanBatchId: reservation.expectedArgs?.humanBatchId || null,
          batchId: reservation.expectedArgs?.batchId || null,
          sender: canonicalUserWallet,
          nonce: reservation.nonce,
          targetFunction: reservation.targetFunction,
          targetStatus: "CREATED",
          targetStatusCode: 0,
          applied: false,
          superseded: false,
          canonicalBlockVerified: false,
          createdAt: reservation.broadcastAt || recoveryTime,
          updatedAt: recoveryTime,
        },
        { merge: true }
      );

      return {
        humanBatchId: reservation.expectedArgs?.humanBatchId || null,
        batchId: reservation.expectedArgs?.batchId || null,
        txHash,
        reservationId,
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        alreadySubmitted: true,
      };
    }

    // 3. Transaction was NOT found on RPC mempool or blockchain:
    // Check if the reserved nonce was consumed on-chain by another transaction while offline
    let latestMinedNonce = -1;
    try {
      latestMinedNonce = await provider.getTransactionCount(canonicalUserWallet, "latest");
    } catch (rpcErr) {
      logger.warn("Unable to query latest mined nonce during crash recovery investigation", {
        error: rpcErr.message,
        wallet: canonicalUserWallet,
      });
      latestMinedNonce = -1;
    }

    if (latestMinedNonce > reservation.nonce) {
      logger.error("Crash recovery: Intended transaction absent but nonce consumed on-chain by external transaction", {
        txHash,
        nonce: reservation.nonce,
        latestMinedNonce,
      });

      const { consumingTxHash, consumingReceipt, consumingReceiptStatus } = await findConsumingTransaction({
        provider,
        walletAddress: canonicalUserWallet,
        nonce: reservation.nonce,
        logger,
      });

      // If consuming transaction receipt was found, independently verify canonical status and finality
      let consumingVerification = null;
      if (consumingReceipt) {
        consumingVerification = await verifyReceiptFinality({
          receipt: consumingReceipt,
          provider,
        });

        if (!consumingVerification.isCanonical) {
          logger.error("External consuming transaction receipt is NOT canonical (reorg detected or block unavailable)", {
            consumingTxHash,
            reason: consumingVerification.reason,
          });

          await recordUnconfirmedExternalNonceConsumption({
            firestore,
            resRef,
            reservation,
            intendedTxHash: txHash,
            latestMinedNonce,
            consumingTxHash,
            consumingReceiptStatus,
            confirmationCount: 0,
            reason: consumingVerification.reason,
          });

          const error = new Error(`External consuming transaction failed canonical verification: ${consumingVerification.reason}`);
          error.statusCode = 409;
          error.code = consumingVerification.reason;
          error.details = {
            nonce: reservation.nonce,
            consumingTxHash,
            reason: consumingVerification.reason,
          };
          throw error;
        }

        if (!consumingVerification.isFinalized) {
          logger.warn("External consuming transaction is canonical but insufficiently confirmed / awaiting finality", {
            consumingTxHash,
            confirmationCount: consumingVerification.confirmationCount,
            reason: consumingVerification.reason,
          });

          await recordUnconfirmedExternalNonceConsumption({
            firestore,
            resRef,
            reservation,
            intendedTxHash: txHash,
            latestMinedNonce,
            consumingTxHash,
            consumingReceiptStatus,
            confirmationCount: consumingVerification.confirmationCount,
            reason: consumingVerification.reason,
          });

          const error = new Error(`External consuming transaction is insufficiently confirmed (${consumingVerification.confirmationCount} confirmations); awaiting finality`);
          error.statusCode = 409;
          error.code = consumingVerification.reason;
          error.details = {
            nonce: reservation.nonce,
            consumingTxHash,
            confirmationCount: consumingVerification.confirmationCount,
            reason: consumingVerification.reason,
          };
          throw error;
        }
      }

      // Canonical block confirmed AND finality threshold reached: permanently resolve external consumption
      await recordExternalNonceConsumption({
        firestore,
        resRef,
        reservation,
        intendedTxHash: txHash,
        latestMinedNonce,
        consumingTxHash,
        consumingReceiptStatus,
        broadcastErrorMsg: "Crash recovery: Nonce externally consumed on-chain while intended transaction was absent",
        finalityMethod: consumingVerification?.finalityMethod || null,
      });

      const error = new Error(`Transaction recovery failed: Nonce ${reservation.nonce} has already been consumed on-chain by an external transaction`);
      error.statusCode = 409;
      error.code = "NONCE_TOO_LOW";
      error.details = {
        nonce: reservation.nonce,
        nonceConsumed: true,
        externallyConsumed: true,
        latestMinedNonce,
        consumingTxHash,
        consumingReceiptStatus,
        finalityMethod: consumingVerification?.finalityMethod || null,
      };
      throw error;
    }

    // Transaction was not found on RPC AND nonce consumption is not established:
    // Crash occurred before broadcast completed; refresh submission claim atomically before rebroadcast.
    const now = new Date().toISOString();
    await firestore.runTransaction(async (transaction) => {
      const currentResDoc = await transaction.get(resRef);
      if (!currentResDoc.exists) throw new Error("Reservation not found");
      const currentRes = currentResDoc.data();
      if (currentRes.status !== TRANSACTION_STATUS.SUBMITTED) {
        const error = new Error(`Reservation status concurrently changed to ${currentRes.status}`);
        error.statusCode = 409;
        error.code = "RESERVATION_ALREADY_SUBMITTED";
        throw error;
      }
      if (currentRes.txHash && currentRes.txHash.toLowerCase() !== txHash) {
        const error = new Error("Reservation transaction hash mismatch during recovery");
        error.statusCode = 409;
        error.code = "RESERVATION_ALREADY_SUBMITTED";
        throw error;
      }
      transaction.update(resRef, {
        submissionClaimedAt: now,
        updatedAt: now,
      });
    });
  }

  // FAILED_AT_BROADCAST handling: can retry only if nonce was NOT consumed
  if (reservation.status === TRANSACTION_STATUS.FAILED_AT_BROADCAST) {
    if (reservation.nonceConsumed === true) {
      const error = new Error("Reservation nonce was already consumed on-chain; cannot resubmit");
      error.statusCode = 409;
      error.code = "NONCE_ALREADY_CONSUMED";
      throw error;
    }
  } else if (!isCrashRecovery && reservation.status !== TRANSACTION_STATUS.RESERVED) {
    const error = new Error(`Reservation is in incompatible status: ${reservation.status}`);
    error.statusCode = 409;
    error.code = "INVALID_RESERVATION_STATUS";
    throw error;
  }

  // Idempotency Key Conflict Check (for new submissions)
  if (!isCrashRecovery && idempotencyKey) {
    const idempDocId = `${canonicalUserWallet}_${idempotencyKey.trim()}`;
    const idempRef = firestore.collection("idempotencyKeys").doc(idempDocId);
    const idempDoc = await idempRef.get();
    if (idempDoc.exists) {
      const idempData = idempDoc.data();
      if (idempData.txHash && idempData.txHash.toLowerCase() !== txHash) {
        const error = new Error("Idempotency conflict: provided Idempotency-Key was already used for a different transaction hash");
        error.statusCode = 409;
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GATE 11: Atomic State Transition (Lock Reservation to SUBMITTED via OCC)
  // ---------------------------------------------------------------------------
  if (!isCrashRecovery) {
    const now = new Date().toISOString();
    await firestore.runTransaction(async (transaction) => {
      const currentResDoc = await transaction.get(resRef);
      if (!currentResDoc.exists) {
        const error = new Error("Reservation not found during submission commit");
        error.statusCode = 404;
        error.code = "RESERVATION_NOT_FOUND";
        throw error;
      }
      const currentRes = currentResDoc.data();
      const allowableStatuses = [
        TRANSACTION_STATUS.RESERVED,
        TRANSACTION_STATUS.FAILED_AT_BROADCAST,
      ];
      if (!allowableStatuses.includes(currentRes.status)) {
        const error = new Error(`Reservation status changed concurrently to ${currentRes.status}`);
        error.statusCode = 409;
        error.code = "RESERVATION_ALREADY_SUBMITTED";
        throw error;
      }

      transaction.update(resRef, {
        status: TRANSACTION_STATUS.SUBMITTED,
        txHash,
        signedTxHex,
        submissionClaimedAt: now,
        broadcastAccepted: false,
        submittedAt: now,
        updatedAt: now,
      });

      if (idempotencyKey) {
        const idempDocId = `${canonicalUserWallet}_${idempotencyKey.trim()}`;
        const idempRef = firestore.collection("idempotencyKeys").doc(idempDocId);
        transaction.set(
          idempRef,
          {
            reservationId,
            walletAddress: canonicalUserWallet,
            txHash,
            updatedAt: now,
          },
          { merge: true }
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // GATE 12: Blockchain RPC Broadcasting (Purely Non-Custodial)
  // ---------------------------------------------------------------------------
  let broadcastAccepted = false;
  let broadcastError = null;

  try {
    await provider.broadcastTransaction(rawTxToBroadcast);
    broadcastAccepted = true;
  } catch (rpcErr) {
    broadcastError = rpcErr;
  }

  // Handle Broadcast Success
  if (broadcastAccepted) {
    const broadcastTime = new Date().toISOString();
    try {
      // 1. Update reservation to PENDING_BLOCKCHAIN
      await resRef.update({
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        broadcastAccepted: true,
        broadcastAt: broadcastTime,
        updatedAt: broadcastTime,
      });

      // 2. Write initial batch document in batches collection
      const humanBatchId = reservation.expectedArgs?.humanBatchId;
      if (humanBatchId) {
        const batchRef = firestore.collection("batches").doc(humanBatchId);
        await batchRef.set(
          {
            humanBatchId,
            batchId: reservation.expectedArgs?.batchId,
            metadataHash: reservation.expectedArgs?.metadataHash,
            status: "PENDING_BLOCKCHAIN",
            currentCustodian: canonicalUserWallet,
            farmer: canonicalUserWallet,
            latestTxHash: txHash,
            createdAt: broadcastTime,
            updatedAt: broadcastTime,
          },
          { merge: true }
        );
      }

      // 3. Write processedTransactions record for deterministic reorg/idempotency tracking
      const procTxRef = firestore.collection("processedTransactions").doc(`${chainId}_${txHash}`);
      await procTxRef.set(
        {
          docId: `${chainId}_${txHash}`,
          chainId,
          txHash,
          humanBatchId: reservation.expectedArgs?.humanBatchId || null,
          batchId: reservation.expectedArgs?.batchId || null,
          sender: canonicalUserWallet,
          nonce: reservation.nonce,
          targetFunction: reservation.targetFunction,
          targetStatus: "CREATED",
          targetStatusCode: 0,
          applied: false,
          superseded: false,
          canonicalBlockVerified: false,
          createdAt: broadcastTime,
          updatedAt: broadcastTime,
        },
        { merge: true }
      );
    } catch (dbErr) {
      // Critical resilience requirement: NEVER lose transaction hash if Firestore fails post-broadcast!
      logger.error("CRITICAL: Firestore state update failed after successful RPC broadcast", {
        txHash,
        reservationId,
        error: dbErr.message,
      });
      return {
        humanBatchId: reservation.expectedArgs?.humanBatchId,
        batchId: reservation.expectedArgs?.batchId,
        txHash,
        reservationId,
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        warning: "FIRESTORE_SYNC_PENDING",
      };
    }

    logger.info("Transaction broadcast accepted into mempool", {
      reservationId,
      txHash,
      nonce: reservation.nonce,
      wallet: canonicalUserWallet,
    });

    return {
      humanBatchId: reservation.expectedArgs?.humanBatchId,
      batchId: reservation.expectedArgs?.batchId,
      txHash,
      reservationId,
      status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
    };
  }

  // Handle Broadcast Error
  const errMsg = (broadcastError.message || "").toLowerCase();

  // Case A: Transaction Already Known in Node Mempool
  if (
    errMsg.includes("already known") ||
    errMsg.includes("already in pool") ||
    errMsg.includes("already imported") ||
    errMsg.includes("known transaction")
  ) {
    logger.info("Transaction already known in mempool, treating as PENDING_BLOCKCHAIN", { txHash });
    await resRef.update({
      status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
      broadcastAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      humanBatchId: reservation.expectedArgs?.humanBatchId,
      batchId: reservation.expectedArgs?.batchId,
      txHash,
      reservationId,
      status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
    };
  }

  // Case B: Synchronous Rejection - Nonce Too Low (Correction 1)
  if (errMsg.includes("nonce too low") || errMsg.includes("nonce is too low")) {
    logger.error("Broadcast rejected: Nonce too low, independently investigating on-chain nonce consumption...", {
      txHash,
      nonce: reservation.nonce,
      error: broadcastError.message,
    });

    // Independently query RPC to verify whether another transaction genuinely consumed this nonce
    let latestMinedNonce = -1;
    try {
      latestMinedNonce = await provider.getTransactionCount(canonicalUserWallet, "latest");
    } catch (rpcErr) {
      logger.warn("Unable to query latest mined nonce during NONCE_TOO_LOW investigation", {
        error: rpcErr.message,
        wallet: canonicalUserWallet,
      });
      latestMinedNonce = -1;
    }

    const nonceConsumed = latestMinedNonce > reservation.nonce;
    let consumingTxHash = null;
    let consumingReceiptStatus = null;

    if (nonceConsumed) {
      const consumingInfo = await findConsumingTransaction({
        provider,
        walletAddress: canonicalUserWallet,
        nonce: reservation.nonce,
        logger,
      });
      consumingTxHash = consumingInfo.consumingTxHash;
      consumingReceiptStatus = consumingInfo.consumingReceiptStatus;
      const consumingReceipt = consumingInfo.consumingReceipt;

      let consumingVerification = null;
      if (consumingReceipt) {
        consumingVerification = await verifyReceiptFinality({
          receipt: consumingReceipt,
          provider,
        });

        if (!consumingVerification.isCanonical || !consumingVerification.isFinalized) {
          await recordUnconfirmedExternalNonceConsumption({
            firestore,
            resRef,
            reservation,
            intendedTxHash: txHash,
            latestMinedNonce,
            consumingTxHash,
            consumingReceiptStatus,
            confirmationCount: consumingVerification.confirmationCount,
            reason: consumingVerification.reason,
          });

          const error = new Error(
            `External consuming transaction ${!consumingVerification.isCanonical ? "failed canonical verification" : "is insufficiently confirmed"}: ${consumingVerification.reason}`
          );
          error.statusCode = 409;
          error.code = consumingVerification.reason;
          error.details = {
            nonce: reservation.nonce,
            consumingTxHash,
            confirmationCount: consumingVerification.confirmationCount,
            reason: consumingVerification.reason,
          };
          throw error;
        }
      }

      await recordExternalNonceConsumption({
        firestore,
        resRef,
        reservation,
        intendedTxHash: txHash,
        latestMinedNonce,
        consumingTxHash,
        consumingReceiptStatus,
        broadcastErrorMsg: broadcastError.message,
        finalityMethod: consumingVerification?.finalityMethod || null,
      });
    } else {
      await resRef.update({
        status: TRANSACTION_STATUS.FAILED_AT_BROADCAST,
        broadcastError: broadcastError.message,
        nonceConsumed: false,
        consumedOnChain: false,
        verifiedLatestMinedNonce: latestMinedNonce,
        updatedAt: new Date().toISOString(),
      });
    }

    const error = new Error(`Transaction rejected by network: Nonce ${reservation.nonce} ${nonceConsumed ? "has already been consumed on-chain by an external transaction" : "rejected as too low but unconfirmed on-chain"}`);
    error.statusCode = 409;
    error.code = "NONCE_TOO_LOW";
    error.details = {
      nonce: reservation.nonce,
      nonceConsumed,
      externallyConsumed: nonceConsumed,
      latestMinedNonce,
      consumingTxHash,
      consumingReceiptStatus,
      originalError: broadcastError.message,
    };
    throw error;
  }

  // Case C: Synchronous Rejection - Insufficient Funds (Correction 1)
  if (errMsg.includes("insufficient funds")) {
    logger.error("Broadcast rejected: Insufficient funds", { txHash, wallet: canonicalUserWallet, error: broadcastError.message });
    await resRef.update({
      status: TRANSACTION_STATUS.FAILED_AT_BROADCAST,
      broadcastError: broadcastError.message,
      nonceConsumed: false,
      consumedOnChain: false,
      updatedAt: new Date().toISOString(),
    });
    const error = new Error("Transaction rejected by network: Insufficient funds for gas * price + value");
    error.statusCode = 400;
    error.code = "INSUFFICIENT_FUNDS";
    error.details = { originalError: broadcastError.message };
    throw error;
  }

  // Case D: Network Timeout / Ambiguous Socket Drop
  const isNetworkTimeout =
    errMsg.includes("timeout") ||
    errMsg.includes("socket") ||
    errMsg.includes("econnreset") ||
    errMsg.includes("network") ||
    errMsg.includes("fetch failed");

  if (isNetworkTimeout) {
    logger.warn("RPC network timeout during broadcast. Investigating mempool for transaction hash...", { txHash });
    let mempoolTx = null;
    try {
      mempoolTx = await provider.getTransaction(txHash);
    } catch (_) {
      mempoolTx = null;
    }

    if (mempoolTx) {
      logger.info("Transaction verified in mempool after initial timeout", { txHash });
      await resRef.update({
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
        broadcastAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return {
        humanBatchId: reservation.expectedArgs?.humanBatchId,
        batchId: reservation.expectedArgs?.batchId,
        txHash,
        reservationId,
        status: TRANSACTION_STATUS.PENDING_BLOCKCHAIN,
      };
    }

    // Ambiguous outcome: mark RECONCILIATION_REQUIRED and preserve reservation lock
    logger.warn("Transaction status ambiguous after timeout; marking RECONCILIATION_REQUIRED", { txHash, reservationId });
    await resRef.update({
      status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
      reconciliationReason: "BROADCAST_TIMEOUT",
      updatedAt: new Date().toISOString(),
    });

    return {
      humanBatchId: reservation.expectedArgs?.humanBatchId,
      batchId: reservation.expectedArgs?.batchId,
      txHash,
      reservationId,
      status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
    };
  }

  // Case E: RPC Unavailable (e.g. ECONNREFUSED before sending)
  if (errMsg.includes("econnrefused") || errMsg.includes("enotfound")) {
    logger.error("Blockchain RPC node unavailable during broadcast", { txHash, error: broadcastError.message });
    await resRef.update({
      status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
      reconciliationReason: "RPC_UNAVAILABLE",
      updatedAt: new Date().toISOString(),
    });
    const error = new Error("Blockchain RPC unavailable during transaction broadcast");
    error.statusCode = 503;
    error.code = "BLOCKCHAIN_RPC_UNAVAILABLE";
    error.details = { originalError: broadcastError.message };
    throw error;
  }

  // Case F: General Broadcast Failure
  logger.error("Transaction broadcast failed", { txHash, error: broadcastError.message });
  await resRef.update({
    status: TRANSACTION_STATUS.FAILED_AT_BROADCAST,
    broadcastError: broadcastError.message,
    updatedAt: new Date().toISOString(),
  });
  const error = new Error(`Transaction broadcast rejected: ${broadcastError.message}`);
  error.statusCode = 422;
  error.code = "BROADCAST_REJECTED";
  error.details = { originalError: broadcastError.message };
  throw error;
}

module.exports = {
  prepareBatchCreation,
  submitBatchCreation,
};

