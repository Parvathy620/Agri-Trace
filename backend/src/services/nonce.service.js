const crypto = require("crypto");
const { ethers } = require("ethers");
const { firestore: defaultFirestore } = require("../config/firebase");
const { provider: defaultProvider } = require("../config/blockchain");
const {
  CONFIRMATION_BLOCKS,
  FALLBACK_FINALITY_BLOCKS,
  ALLOW_FALLBACK_FINALITY,
  NONCE_RESERVATION_TTL_MS,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
} = require("../config/constants");
const { classifyFinalizedBlockError } = require("../utils/finality.util");
const logger = require("../utils/logger");

/**
 * Validates and normalizes a 20-byte Ethereum address using ethers.js checksumming.
 * @param {string} address
 * @returns {string} Checksummed Ethereum address
 * @throws {Error} If address format is invalid
 */
function validateEthereumAddress(address) {
  if (!address || typeof address !== "string") {
    const error = new Error("Ethereum walletAddress must be a non-empty string");
    error.statusCode = 400;
    error.code = "INVALID_WALLET_ADDRESS";
    throw error;
  }

  try {
    return ethers.getAddress(address.trim());
  } catch (err) {
    const error = new Error(`Invalid 20-byte Ethereum wallet address format: ${address}`);
    error.statusCode = 400;
    error.code = "INVALID_WALLET_ADDRESS";
    throw error;
  }
}

/**
 * Atomically reserves the next sequential nonce for an authenticated participant wallet.
 * Enforces the Single Uncommitted Reservation Invariant and monotonic allocation formula:
 *   assignedNonce = max(rpcPendingNonce, tracker.highestReservedNonce + 1)
 *
 * @param {Object} params
 * @param {string} params.uid - Authenticated Firebase UID
 * @param {string} params.walletAddress - Ethereum address of the participant
 * @param {string} params.targetFunction - Smart contract function name (e.g. "createBatch")
 * @param {Object} [params.expectedArgs={}] - Expected parameters and hashes for pre-broadcast verification
 * @param {string} [params.idempotencyKey=null] - Optional idempotency key for safe client retries
 * @param {string} [params.callDataHash=null] - Optional keccak256 hash of expected transaction calldata
 * @param {boolean} [params.isReplacement=false] - True if this is a gas-bump replacement transaction
 * @param {string} [params.originalTxHash=null] - Hash of original transaction if replacing
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore=defaultFirestore] - Firestore instance
 * @param {ethers.Provider} [params.provider=defaultProvider] - ethers.js provider instance
 * @param {number} [params.ttlMs=NONCE_RESERVATION_TTL_MS] - Nonce reservation validity window (default 15m)
 * @returns {Promise<Object>} Created reservation record
 */
async function reserveNonce({
  uid,
  walletAddress,
  targetFunction,
  expectedArgs = {},
  idempotencyKey = null,
  callDataHash = null,
  isReplacement = false,
  originalTxHash = null,
  firestore = defaultFirestore,
  provider = defaultProvider,
  ttlMs = NONCE_RESERVATION_TTL_MS,
}) {
  // 1. Parameter Validation
  if (!uid || typeof uid !== "string" || !uid.trim()) {
    const error = new Error("Authenticated user UID is required");
    error.statusCode = 400;
    error.code = "MISSING_UID";
    throw error;
  }

  const canonicalAddress = validateEthereumAddress(walletAddress);
  const docId = canonicalAddress.toLowerCase();

  if (!targetFunction || typeof targetFunction !== "string" || !targetFunction.trim()) {
    const error = new Error("Target smart contract function name is required");
    error.statusCode = 400;
    error.code = "MISSING_TARGET_FUNCTION";
    throw error;
  }

  if (isReplacement) {
    if (!originalTxHash || !/^0x[a-fA-F0-9]{64}$/.test(originalTxHash)) {
      const error = new Error("Valid 32-byte originalTxHash is required for replacement transactions");
      error.statusCode = 400;
      error.code = "INVALID_ORIGINAL_TX_HASH";
      throw error;
    }
  }

  // 2. Query Blockchain RPC Outside Firestore Transaction
  // Fails safely: if RPC is unreachable, do NOT guess or fall back to an unsafe nonce.
  let rpcPendingNonce;
  let latestMinedNonce;
  try {
    [rpcPendingNonce, latestMinedNonce] = await Promise.all([
      provider.getTransactionCount(canonicalAddress, "pending"),
      provider.getTransactionCount(canonicalAddress, "latest"),
    ]);
  } catch (rpcErr) {
    logger.error("Failed to query nonce from blockchain RPC", {
      wallet: canonicalAddress,
      error: rpcErr.message,
    });
    const error = new Error(`Blockchain RPC failure: unable to query nonce for ${canonicalAddress}`);
    error.statusCode = 503;
    error.code = "BLOCKCHAIN_RPC_UNAVAILABLE";
    error.details = { originalError: rpcErr.message };
    throw error;
  }

  if (
    typeof rpcPendingNonce !== "number" ||
    typeof latestMinedNonce !== "number" ||
    Number.isNaN(rpcPendingNonce) ||
    Number.isNaN(latestMinedNonce) ||
    rpcPendingNonce < 0 ||
    latestMinedNonce < 0
  ) {
    const error = new Error(
      `Invalid nonce received from blockchain RPC: pending=${rpcPendingNonce}, latest=${latestMinedNonce}`
    );
    error.statusCode = 503;
    error.code = "INVALID_RPC_NONCE";
    throw error;
  }

  // 3. Atomic Firestore Transaction (Pure Database Reads & Writes)
  return await firestore.runTransaction(async (transaction) => {
    const userRef = firestore.collection("users").doc(uid);
    const trackerRef = firestore.collection("walletNonceTrackers").doc(docId);

    // =========================================================================
    // STEP A: ALL FIRESTORE READS FIRST
    // =========================================================================
    const [userDoc, trackerDoc] = await Promise.all([
      transaction.get(userRef),
      transaction.get(trackerRef),
    ]);

    // Optional Idempotency Read
    let existingReservationDoc = null;
    let idempotencyRef = null;
    if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim()) {
      idempotencyRef = firestore.collection("idempotencyKeys").doc(`${docId}_${idempotencyKey.trim()}`);
      const idempDoc = await transaction.get(idempotencyRef);
      if (idempDoc.exists && idempDoc.data().reservationId) {
        const resRef = firestore.collection("nonceReservations").doc(idempDoc.data().reservationId);
        existingReservationDoc = await transaction.get(resRef);
      }
    }

    // Active Reservation Read
    let activeReservationDoc = null;
    if (trackerDoc.exists && trackerDoc.data().activeReservationId) {
      const activeResRef = firestore
        .collection("nonceReservations")
        .doc(trackerDoc.data().activeReservationId);
      activeReservationDoc = await transaction.get(activeResRef);
    }

    // Replacement Original Reservation Read
    let origReservationDoc = null;
    if (isReplacement && originalTxHash) {
      const origResRef = firestore.collection("nonceReservations").doc(originalTxHash.toLowerCase());
      origReservationDoc = await transaction.get(origResRef);
    }

    // =========================================================================
    // STEP B: SECURITY & IDENTITY ASSERTIONS
    // =========================================================================

    // 1. User Profile Verification
    if (!userDoc.exists) {
      const error = new Error("Authenticated user profile not found");
      error.statusCode = 404;
      error.code = "USER_NOT_FOUND";
      throw error;
    }

    const userData = userDoc.data();
    if (userData.isActive === false) {
      const error = new Error("User account is inactive or disabled");
      error.statusCode = 403;
      error.code = "ACCOUNT_INACTIVE";
      throw error;
    }

    // 2. Strict User-Wallet Binding Verification
    if (!userData.walletAddress) {
      const error = new Error("User does not have a linked wallet address");
      error.statusCode = 403;
      error.code = "WALLET_NOT_LINKED";
      throw error;
    }

    if (userData.walletAddress.toLowerCase() !== canonicalAddress.toLowerCase()) {
      const error = new Error("Supplied wallet address does not match authenticated user's linked wallet");
      error.statusCode = 403;
      error.code = "WALLET_MISMATCH";
      throw error;
    }

    // =========================================================================
    // STEP C: IDEMPOTENCY GUARD
    // =========================================================================
    if (existingReservationDoc && existingReservationDoc.exists) {
      const existing = existingReservationDoc.data();
      if (
        existing.status === TRANSACTION_STATUS.RESERVED ||
        existing.status === TRANSACTION_STATUS.SUBMITTED
      ) {
        logger.info("Idempotent nonce reservation match returned", {
          reservationId: existing.reservationId,
          wallet: canonicalAddress,
          nonce: existing.nonce,
        });
        return existing;
      }
    }

    // =========================================================================
    // STEP D: SINGLE UNCOMMITTED RESERVATION INVARIANT
    // =========================================================================
    // A wallet is strictly restricted to at most one active/unresolved reservation.
    // Unresolved states lock the wallet to prevent Ethereum mempool nonce gaps until consumed or cancelled on-chain:
    //   1. RESERVED: uncommitted preparation
    //   2. EXPIRED: unsubmitted reservation whose TTL elapsed without confirmed consumption
    //   3. CANCELLATION_PENDING: cancellation self-transaction pending on-chain
    //   4. RECONCILIATION_REQUIRED: ambiguous broadcast timeout or chain reorganisation
    //   5. FAILED_AT_BROADCAST: broadcast rejected (e.g. INSUFFICIENT_FUNDS, NONCE_TOO_LOW) and nonce consumption NOT proven on-chain
    // Note: SUBMITTED and PENDING_BLOCKCHAIN represent committed transactions in-flight or in the mempool;
    // they do not block subsequent pipeline reservations under the mathematical allocation formula max(rpcPendingNonce, highestReserved + 1).
    const unresolvedStatuses = [
      TRANSACTION_STATUS.RESERVED,
      TRANSACTION_STATUS.EXPIRED,
      TRANSACTION_STATUS.CANCELLATION_PENDING,
      TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
    ];

    if (!isReplacement && activeReservationDoc && activeReservationDoc.exists) {
      const activeRes = activeReservationDoc.data();

      const isUnresolved =
        unresolvedStatuses.includes(activeRes.status) ||
        (activeRes.status === TRANSACTION_STATUS.SUBMITTED &&
          !activeRes.broadcastAccepted &&
          !activeRes.nonceConsumed) ||
        (activeRes.status === TRANSACTION_STATUS.FAILED_AT_BROADCAST &&
          !activeRes.nonceConsumed);

      if (isUnresolved) {
        logger.warn("Unresolved reservation blocks new nonce allocation to prevent nonce gap", {
          wallet: canonicalAddress,
          activeReservationId: activeRes.reservationId,
          nonce: activeRes.nonce,
          status: activeRes.status,
          nonceConsumed: activeRes.nonceConsumed,
        });
        const error = new Error(
          `An unresolved reservation at nonce ${activeRes.nonce} (status: ${activeRes.status}) exists for this wallet. To prevent blockchain nonce gaps, resolve it on-chain via submission or cancellation before preparing a new transaction.`
        );
        error.statusCode = 409;
        error.code = "ACTIVE_RESERVATION_EXISTS";
        error.details = {
          activeReservationId: activeRes.reservationId,
          nonce: activeRes.nonce,
          status: activeRes.status,
          expiresAt: activeRes.expiresAt,
        };
        throw error;
      }
    }

    // =========================================================================
    // STEP E: NONCE ALLOCATION FORMULA (MONOTONIC NONCE GUARANTEE)
    // =========================================================================
    let highestReserved =
      trackerDoc.exists && trackerDoc.data().highestReservedNonce !== undefined
        ? trackerDoc.data().highestReservedNonce
        : -1;

    let assignedNonce;
    if (isReplacement) {
      if (!origReservationDoc || !origReservationDoc.exists) {
        const error = new Error("Original transaction reservation not found for replacement");
        error.statusCode = 404;
        error.code = "ORIGINAL_TRANSACTION_NOT_FOUND";
        throw error;
      }
      const origRes = origReservationDoc.data();
      assignedNonce = origRes.nonce;
      if (assignedNonce < latestMinedNonce) {
        const error = new Error(`Original transaction at nonce ${assignedNonce} has already been mined`);
        error.statusCode = 409;
        error.code = "TRANSACTION_ALREADY_MINED";
        throw error;
      }
    } else {
      if (highestReserved === -1) {
        assignedNonce = Math.max(rpcPendingNonce, 0);
      } else {
        assignedNonce = Math.max(rpcPendingNonce, highestReserved + 1);
      }

      // Permanent Monotonicity Invariant: Nonce Rollback is Impossible
      if (highestReserved !== -1 && assignedNonce < highestReserved) {
        const fatalErr = new Error(
          `FATAL: Nonce rollback prevented! Attempted ${assignedNonce} but tracker is at ${highestReserved}`
        );
        fatalErr.statusCode = 500;
        fatalErr.code = "NONCE_ROLLBACK_PROHIBITED";
        throw fatalErr;
      }

      highestReserved = Math.max(highestReserved, assignedNonce);
    }

    // =========================================================================
    // STEP F: ATOMIC WRITES
    // =========================================================================
    const reservationId = crypto.randomUUID();
    const reservationRef = firestore.collection("nonceReservations").doc(reservationId);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const reservationData = {
      reservationId,
      uid,
      walletAddress: canonicalAddress,
      nonce: assignedNonce,
      type: isReplacement
        ? TRANSACTION_TYPE.REPLACEMENT_TRANSACTION
        : TRANSACTION_TYPE.NEW_TRANSACTION,
      targetFunction,
      expectedArgs,
      idempotencyKey: idempotencyKey ? idempotencyKey.trim() : null,
      callDataHash: callDataHash || null,
      status: TRANSACTION_STATUS.RESERVED,
      createdAt,
      expiresAt,
      submittedAt: null,
      broadcastAt: null,
      txHash: null,
      replacementForTxHash: isReplacement ? originalTxHash : null,
    };

    transaction.set(reservationRef, reservationData);

    transaction.set(
      trackerRef,
      {
        walletAddress: canonicalAddress,
        highestReservedNonce: highestReserved,
        activeReservationId: reservationId,
        lastAllocatedAt: createdAt,
        updatedAt: createdAt,
      },
      { merge: true }
    );

    if (idempotencyRef) {
      transaction.set(
        idempotencyRef,
        {
          reservationId,
          walletAddress: canonicalAddress,
          createdAt,
        },
        { merge: true }
      );
    }

    logger.info("Nonce reserved atomically", {
      reservationId,
      wallet: canonicalAddress,
      nonce: assignedNonce,
      highestReservedNonce: highestReserved,
    });

    return reservationData;
  });
}

/**
 * Retrieves a reservation record by its unique ID.
 * Decorates the record with isExpired if currently RESERVED and past its expiry timestamp.
 *
 * @param {string} reservationId
 * @param {Object} [options]
 * @param {import("firebase-admin").firestore.Firestore} [options.firestore=defaultFirestore]
 * @returns {Promise<Object|null>}
 */
async function getReservation(reservationId, { firestore = defaultFirestore } = {}) {
  if (!reservationId || typeof reservationId !== "string") {
    return null;
  }

  const resDoc = await firestore.collection("nonceReservations").doc(reservationId).get();
  if (!resDoc.exists) {
    return null;
  }

  const data = resDoc.data();
  const isPastExpiry =
    data.status === TRANSACTION_STATUS.RESERVED &&
    new Date(data.expiresAt).getTime() <= Date.now();

  return {
    ...data,
    isExpired: isPastExpiry,
  };
}

/**
 * Retrieves the current nonce tracker record for a participant wallet.
 *
 * @param {string} walletAddress
 * @param {Object} [options]
 * @param {import("firebase-admin").firestore.Firestore} [options.firestore=defaultFirestore]
 * @returns {Promise<Object|null>}
 */
async function getWalletNonceTracker(walletAddress, { firestore = defaultFirestore } = {}) {
  const canonicalAddress = validateEthereumAddress(walletAddress);
  const docId = canonicalAddress.toLowerCase();
  const trackerDoc = await firestore.collection("walletNonceTrackers").doc(docId).get();

  if (!trackerDoc.exists) {
    return null;
  }
  return trackerDoc.data();
}

/**
 * Handles explicit expiration of an uncommitted reservation.
 * CRITICAL DEFENSIVE INVARIANTS:
 *   1. The reservation status transitions to EXPIRED, remaining identifiable and unresolved.
 *   2. The wallet's activeReservationId pointer is NOT cleared merely because TTL elapsed.
 *   3. The highestReservedNonce on the wallet tracker is NEVER decremented.
 *   4. The unconsumed nonce is NEVER automatically released or reassigned to another transaction.
 *   5. The wallet is blocked from allocating higher nonces until this slot is resolved on-chain.
 *
 * @param {string} reservationId
 * @param {Object} [options]
 * @param {import("firebase-admin").firestore.Firestore} [options.firestore=defaultFirestore]
 * @returns {Promise<Object>} Updated reservation record
 */
async function expireReservation(reservationId, { firestore = defaultFirestore } = {}) {
  if (!reservationId || typeof reservationId !== "string") {
    const error = new Error("Valid reservationId is required to expire a reservation");
    error.statusCode = 400;
    error.code = "INVALID_RESERVATION_ID";
    throw error;
  }

  return await firestore.runTransaction(async (transaction) => {
    const resRef = firestore.collection("nonceReservations").doc(reservationId);
    const resDoc = await transaction.get(resRef);

    if (!resDoc.exists) {
      const error = new Error("Reservation not found");
      error.statusCode = 404;
      error.code = "RESERVATION_NOT_FOUND";
      throw error;
    }

    const reservation = resDoc.data();
    if (reservation.status !== TRANSACTION_STATUS.RESERVED) {
      const error = new Error(`Cannot expire reservation in status ${reservation.status}`);
      error.statusCode = 409;
      error.code = "INVALID_RESERVATION_STATUS";
      throw error;
    }

    const docId = reservation.walletAddress.toLowerCase();
    const trackerRef = firestore.collection("walletNonceTrackers").doc(docId);
    const trackerDoc = await transaction.get(trackerRef);

    const expiredAt = new Date().toISOString();

    // 1. Mark reservation expired (unresolved)
    transaction.update(resRef, {
      status: TRANSACTION_STATUS.EXPIRED,
      isExpired: true,
      expiredAt,
      updatedAt: expiredAt,
    });

    // 2. CRITICAL: activeReservationId is NOT cleared!
    // The expired reservation remains unresolved to prevent Ethereum mempool nonce gaps.
    // highestReservedNonce is NEVER decremented!
    if (trackerDoc.exists) {
      transaction.update(trackerRef, {
        updatedAt: expiredAt,
      });
    }

    logger.info("Reservation marked EXPIRED (Unresolved). Active pointer locked to prevent nonce gaps", {
      reservationId,
      wallet: reservation.walletAddress,
      nonce: reservation.nonce,
      highestReservedNonce: trackerDoc.data()?.highestReservedNonce,
    });

    return {
      ...reservation,
      status: TRANSACTION_STATUS.EXPIRED,
      isExpired: true,
      expiredAt,
    };
  });
}

/**
 * Transitions an unresolved reservation to CANCELLATION_PENDING upon broadcast
 * of an on-chain 0-ETH cancellation transaction.
 *
 * @param {Object} params
 * @param {string} params.reservationId
 * @param {string} params.cancelTxHash
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore=defaultFirestore]
 * @returns {Promise<Object>}
 */
async function markCancellationPending({ reservationId, cancelTxHash, firestore = defaultFirestore }) {
  if (!reservationId || !cancelTxHash) {
    const error = new Error("reservationId and cancelTxHash are required to mark cancellation pending");
    error.statusCode = 400;
    error.code = "INVALID_CANCELLATION_PARAMS";
    throw error;
  }

  return await firestore.runTransaction(async (transaction) => {
    const resRef = firestore.collection("nonceReservations").doc(reservationId);
    const resDoc = await transaction.get(resRef);

    if (!resDoc.exists) {
      const error = new Error("Reservation not found");
      error.statusCode = 404;
      error.code = "RESERVATION_NOT_FOUND";
      throw error;
    }

    const reservation = resDoc.data();
    const cancellableStatuses = [
      TRANSACTION_STATUS.RESERVED,
      TRANSACTION_STATUS.EXPIRED,
      TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
      TRANSACTION_STATUS.FAILED_AT_BROADCAST,
    ];
    if (!cancellableStatuses.includes(reservation.status)) {
      const error = new Error(`Cannot cancel reservation in status ${reservation.status}`);
      error.statusCode = 409;
      error.code = "INVALID_RESERVATION_STATUS";
      throw error;
    }

    const now = new Date().toISOString();
    transaction.update(resRef, {
      status: TRANSACTION_STATUS.CANCELLATION_PENDING,
      cancelTxHash: cancelTxHash.toLowerCase(),
      cancellationSubmittedAt: now,
      updatedAt: now,
    });

    return {
      ...reservation,
      status: TRANSACTION_STATUS.CANCELLATION_PENDING,
      cancelTxHash: cancelTxHash.toLowerCase(),
    };
  });
}

/**
 * Independently verifies and confirms on-chain cancellation of an abandoned reservation.
 * NEVER trusts client-supplied receipt information: queries the configured blockchain RPC
 * provider for the transaction, receipt, block, canonical status, confirmation depth, and
 * Ethereum finality.
 *
 * Enforces the following verification invariants:
 *   1. Transaction presence on-chain
 *   2. Transaction receipt presence (mined status)
 *   3. Receipt hash match (receipt.hash === cancelTxHash)
 *   4. Transaction sender equals reservation linked wallet
 *   5. Transaction recipient equals the same wallet (0-ETH self-transfer)
 *   6. Transaction nonce equals the persisted reservation.nonce field
 *   7. Transaction value is exactly 0 native Ether (0n)
 *   8. Transaction data is strictly empty / 0x
 *   9. Receipt status is successful (1, not reverted)
 *   10. Canonical Block Continuity: receipt.blockHash matches canonical provider.getBlock(receipt.blockNumber).hash
 *       (If a reorganisation is detected, status transitions to RECONCILIATION_REQUIRED and the wallet remains locked)
 *   11. Required base confirmation depth has been achieved (confirmationCount >= requiredConfirmations)
 *   12. Blockchain Finality Verification:
 *       - Where supported, retrieves Ethereum post-Merge Casper FFG finalized block (provider.getBlock("finalized"))
 *         and enforces receipt.blockNumber <= finalizedBlock.number.
 *       - Two block confirmations are NEVER treated as equivalent to absolute finality.
 *       - If Casper FFG finality is supported but not yet reached, the reservation remains unresolved and the wallet locked.
 *       - For development networks where the 'finalized' block tag is unsupported (e.g. local Hardhat dev nodes),
 *         uses an explicit configurable confirmation-depth fallback (default: FALLBACK_FINALITY_BLOCKS = 5).
 *         LIMITATION: Fixed confirmation depth provides probabilistic shallow reorganisation protection on dev
 *         nodes only; it does NOT provide cryptographic Casper FFG finality.
 *
 * @param {Object} params
 * @param {string} params.reservationId
 * @param {string} params.cancelTxHash
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore=defaultFirestore]
 * @param {ethers.Provider} [params.provider=defaultProvider]
 * @param {number} [params.requiredConfirmations=CONFIRMATION_BLOCKS]
 * @param {number} [params.fallbackFinalityConfirmations=FALLBACK_FINALITY_BLOCKS]
 * @returns {Promise<{ resolved: boolean, status?: string, reason?: string, details?: Object, alreadyResolved?: boolean }>}
 */
async function confirmCancellationOnChain({
  reservationId,
  cancelTxHash,
  firestore = defaultFirestore,
  provider = defaultProvider,
  requiredConfirmations = CONFIRMATION_BLOCKS,
  fallbackFinalityConfirmations = FALLBACK_FINALITY_BLOCKS,
  allowFallbackFinality = ALLOW_FALLBACK_FINALITY,
}) {
  if (!reservationId || typeof reservationId !== "string") {
    const error = new Error("Valid reservationId is required to confirm cancellation");
    error.statusCode = 400;
    error.code = "INVALID_RESERVATION_ID";
    throw error;
  }

  if (!cancelTxHash || !/^0x[a-fA-F0-9]{64}$/.test(cancelTxHash)) {
    const error = new Error("Valid 32-byte cancelTxHash is required to confirm cancellation");
    error.statusCode = 400;
    error.code = "INVALID_CANCELLATION_TX_HASH";
    throw error;
  }

  // 1. Fetch Reservation from Firestore
  const resDoc = await firestore.collection("nonceReservations").doc(reservationId).get();
  if (!resDoc.exists) {
    const error = new Error("Reservation not found");
    error.statusCode = 404;
    error.code = "RESERVATION_NOT_FOUND";
    throw error;
  }
  const reservation = resDoc.data();

  // If already resolved, return idempotently
  if (reservation.status === TRANSACTION_STATUS.CANCELLED_ON_CHAIN) {
    return {
      resolved: true,
      status: TRANSACTION_STATUS.CANCELLED_ON_CHAIN,
      alreadyResolved: true,
      nonce: reservation.nonce,
    };
  }

  // Assert exact persisted reservation.nonce field integrity
  if (
    typeof reservation.nonce !== "number" ||
    !Number.isInteger(reservation.nonce) ||
    reservation.nonce < 0
  ) {
    const error = new Error("Corrupted reservation record: missing or invalid integer 'nonce' field");
    error.statusCode = 500;
    error.code = "CORRUPTED_RESERVATION_RECORD";
    throw error;
  }
  const persistedNonce = reservation.nonce;
  const canonicalWallet = reservation.walletAddress.toLowerCase();

  // 2. Independently Query Blockchain RPC Outside Firestore Transaction
  let tx;
  let receipt;
  let canonicalBlock = null;
  let currentBlockNumber = 0;

  try {
    [tx, receipt, currentBlockNumber] = await Promise.all([
      provider.getTransaction(cancelTxHash),
      provider.getTransactionReceipt(cancelTxHash),
      provider.getBlockNumber(),
    ]);

    if (receipt && receipt.blockNumber !== undefined && receipt.blockNumber !== null) {
      canonicalBlock = await provider.getBlock(receipt.blockNumber);
    }
  } catch (rpcErr) {
    logger.error("RPC error during cancellation verification", {
      reservationId,
      cancelTxHash,
      error: rpcErr.message,
    });
    return {
      resolved: false,
      reason: "RPC_ERROR",
      details: { error: rpcErr.message },
    };
  }

  // 3. Verify Transaction Presence
  if (!tx) {
    logger.warn("Cancellation transaction not found on blockchain", { reservationId, cancelTxHash });
    return {
      resolved: false,
      reason: "TRANSACTION_NOT_FOUND",
      details: { cancelTxHash },
    };
  }

  // 4. Verify Receipt Presence (Mined status)
  if (!receipt) {
    logger.warn("Cancellation transaction still pending in mempool (receipt not found)", {
      reservationId,
      cancelTxHash,
    });
    return {
      resolved: false,
      reason: "RECEIPT_NOT_FOUND",
      details: { cancelTxHash },
    };
  }

  // 5. Verify Receipt Transaction Hash Match
  if (!receipt.hash || receipt.hash.toLowerCase() !== cancelTxHash.toLowerCase()) {
    logger.error("Receipt transaction hash mismatch", {
      expected: cancelTxHash,
      actual: receipt.hash,
    });
    return {
      resolved: false,
      reason: "RECEIPT_HASH_MISMATCH",
      details: { expected: cancelTxHash, actual: receipt.hash },
    };
  }

  // 6. Verify Transaction Sender (Must equal reservation's linked wallet)
  let txFrom;
  try {
    txFrom = ethers.getAddress(tx.from).toLowerCase();
  } catch (e) {
    txFrom = (tx.from || "").toLowerCase();
  }
  if (txFrom !== canonicalWallet) {
    logger.error("Cancellation transaction sender mismatch", {
      expected: canonicalWallet,
      actual: txFrom,
    });
    return {
      resolved: false,
      reason: "SENDER_MISMATCH",
      details: { expected: canonicalWallet, actual: txFrom },
    };
  }

  // 7. Verify Transaction Recipient (Must equal same wallet for 0-ETH self-transfer)
  let txTo;
  try {
    txTo = tx.to ? ethers.getAddress(tx.to).toLowerCase() : null;
  } catch (e) {
    txTo = (tx.to || "").toLowerCase();
  }
  if (!txTo || txTo !== canonicalWallet) {
    logger.error("Cancellation transaction recipient mismatch (must be self-transfer)", {
      expected: canonicalWallet,
      actual: txTo,
    });
    return {
      resolved: false,
      reason: "RECIPIENT_MISMATCH",
      details: { expected: canonicalWallet, actual: txTo },
    };
  }

  // 8. Verify Transaction Nonce (Must equal the exact persisted reservation.nonce field)
  if (Number(tx.nonce) !== persistedNonce) {
    logger.error("Cancellation transaction nonce mismatch against persisted reservation.nonce", {
      persistedReservationNonce: persistedNonce,
      txNonce: Number(tx.nonce),
    });
    return {
      resolved: false,
      reason: "NONCE_MISMATCH",
      details: { expected: persistedNonce, actual: Number(tx.nonce) },
    };
  }

  // 9. Verify Transaction Value (Must be exactly 0 native Ether)
  if (BigInt(tx.value || 0n) !== 0n) {
    logger.error("Cancellation transaction value non-zero", {
      value: tx.value.toString(),
    });
    return {
      resolved: false,
      reason: "NON_ZERO_VALUE",
      details: { value: tx.value.toString() },
    };
  }

  // 10. Verify Transaction Calldata (Must be empty 0x)
  const cleanData = (tx.data || "0x").toLowerCase();
  if (cleanData !== "0x" && cleanData !== "0x0") {
    logger.error("Cancellation transaction calldata non-empty", {
      data: tx.data,
    });
    return {
      resolved: false,
      reason: "NON_EMPTY_CALLDATA",
      details: { data: tx.data },
    };
  }

  // 11. Verify Receipt Status (Must be 1 = Success, not reverted)
  if (receipt.status !== 1) {
    logger.error("Cancellation transaction reverted on-chain", {
      receiptStatus: receipt.status,
    });
    await firestore.collection("nonceReservations").doc(reservationId).update({
      cancellationReverted: true,
      updatedAt: new Date().toISOString(),
    });
    return {
      resolved: false,
      reason: "RECEIPT_STATUS_REVERTED",
      details: { receiptStatus: receipt.status },
    };
  }

  // 12. Verify Canonical Block Continuity (No reorganisation / orphaned block)
  const isCanonical =
    canonicalBlock !== null &&
    canonicalBlock.hash &&
    receipt.blockHash &&
    canonicalBlock.hash.toLowerCase() === receipt.blockHash.toLowerCase();

  if (!isCanonical) {
    logger.error("Reorganisation detected: cancellation block is not canonical", {
      reservationId,
      minedBlockHash: receipt.blockHash,
      canonicalBlockHash: canonicalBlock?.hash || null,
    });
    await firestore.collection("nonceReservations").doc(reservationId).update({
      cancellationReorgDetected: true,
      status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED,
      updatedAt: new Date().toISOString(),
    });
    return {
      resolved: false,
      reason: "REORGANISATION_DETECTED",
      details: {
        minedBlockHash: receipt.blockHash,
        canonicalBlockHash: canonicalBlock?.hash || null,
      },
    };
  }

  // 13. Verify Base Confirmation Depth (Must satisfy requiredConfirmations)
  const confirmationCount = Math.max(0, currentBlockNumber - receipt.blockNumber + 1);
  if (confirmationCount < requiredConfirmations) {
    logger.warn("Cancellation confirmed but depth insufficient", {
      confirmationCount,
      requiredConfirmations,
    });
    return {
      resolved: false,
      reason: "INSUFFICIENT_CONFIRMATIONS",
      details: { confirmationCount, requiredConfirmations },
    };
  }

  // 14. Blockchain Finality Verification
  // Two block confirmations are NEVER treated as equivalent to absolute finality.
  let isFinalized = false;
  let finalityMethod = null;
  let finalizedBlock = null;
  let explicitUnsupportedEstablished = false;

  try {
    finalizedBlock = await provider.getBlock("finalized");
  } catch (finalizedErr) {
    const classification = classifyFinalizedBlockError(finalizedErr);
    if (classification.isUnsupported) {
      explicitUnsupportedEstablished = true;
    } else {
      logger.error("RPC error querying finalized block during cancellation confirmation", {
        reservationId,
        reason: classification.reason,
        error: finalizedErr.message,
      });
      return {
        resolved: false,
        reason: classification.reason === "RPC_FINALITY_QUERY_FAILED" ? "RPC_ERROR" : (classification.reason || "RPC_ERROR"),
        details: { error: finalizedErr.message },
      };
    }
  }

  if (finalizedBlock !== null && finalizedBlock !== undefined) {
    if (
      typeof finalizedBlock !== "object" ||
      typeof finalizedBlock.number !== "number" ||
      !Number.isInteger(finalizedBlock.number) ||
      isNaN(finalizedBlock.number) ||
      finalizedBlock.number < 0
    ) {
      return {
        resolved: false,
        reason: "INVALID_FINALIZED_BLOCK_RESPONSE",
        details: { finalizedBlock },
      };
    }
    if (finalizedBlock.number > currentBlockNumber) {
      return {
        resolved: false,
        reason: "INCONSISTENT_FINALITY_RESPONSE",
        details: {
          finalizedBlockNumber: finalizedBlock.number,
          currentBlockNumber,
        },
      };
    }

    // Ethereum PoS Casper FFG Finality Verification
    finalityMethod = "ETH_FINALIZED_TAG";
    if (receipt.blockNumber <= finalizedBlock.number) {
      isFinalized = true;
    } else {
      logger.warn("Cancellation confirmed on canonical chain but awaiting Ethereum Casper FFG finality checkpoint", {
        receiptBlockNumber: receipt.blockNumber,
        finalizedBlockNumber: finalizedBlock.number,
        confirmationCount,
      });
      return {
        resolved: false,
        reason: "AWAITING_FINALITY",
        details: {
          receiptBlockNumber: receipt.blockNumber,
          finalizedBlockNumber: finalizedBlock.number,
          confirmationCount,
          finalityMethod,
        },
      };
    }
  } else {
    // finalizedBlock is null or undefined
    if (!explicitUnsupportedEstablished) {
      // Null response is ambiguous: fail closed and retain lock
      return {
        resolved: false,
        reason: "FINALIZED_BLOCK_UNAVAILABLE",
        details: {
          message: "RPC provider returned null for 'finalized' block tag without positively indicating unsupported capability.",
        },
      };
    }

    // Positively established unsupported finalized tag -> check fallback policy
    if (!allowFallbackFinality) {
      return {
        resolved: false,
        reason: "FINALITY_TAG_REQUIRED",
        details: {
          message: "RPC node does not support Casper FFG 'finalized' block tag and fallback finality is disabled.",
        },
      };
    }

    finalityMethod = "FALLBACK_DEPTH";
    if (confirmationCount >= fallbackFinalityConfirmations) {
      isFinalized = true;
    } else {
      logger.warn("Cancellation confirmed on dev network but insufficient fallback finality depth", {
        confirmationCount,
        requiredFallbackConfirmations: fallbackFinalityConfirmations,
      });
      return {
        resolved: false,
        reason: "INSUFFICIENT_FINALITY_DEPTH",
        details: {
          confirmationCount,
          requiredFallbackConfirmations: fallbackFinalityConfirmations,
          finalityMethod,
        },
      };
    }
  }

  if (!isFinalized) {
    return {
      resolved: false,
      reason: "FINALITY_NOT_ESTABLISHED",
    };
  }

  // =========================================================================
  // ALL CHECKS PASSED & FINALITY ESTABLISHED: ATOMIC COMMIT VIA FIRESTORE TRANSACTION
  // =========================================================================
  return await firestore.runTransaction(async (transaction) => {
    const resRef = firestore.collection("nonceReservations").doc(reservationId);
    const trackerRef = firestore.collection("walletNonceTrackers").doc(canonicalWallet);

    const [currentResDoc, currentTrackerDoc] = await Promise.all([
      transaction.get(resRef),
      transaction.get(trackerRef),
    ]);

    if (!currentResDoc.exists) {
      throw new Error("Reservation not found during commit");
    }

    const now = new Date().toISOString();

    // 1. Mark reservation CANCELLED_ON_CHAIN
    transaction.update(resRef, {
      status: TRANSACTION_STATUS.CANCELLED_ON_CHAIN,
      cancelTxHash: cancelTxHash.toLowerCase(),
      cancelBlockHash: receipt.blockHash.toLowerCase(),
      cancelBlockNumber: receipt.blockNumber,
      confirmationCount,
      finalityMethod,
      finalizedBlockNumber: finalizedBlock ? finalizedBlock.number : null,
      cancelledAt: now,
      updatedAt: now,
    });

    // 2. Clear activeReservationId on the tracker
    // highestReservedNonce is NEVER decremented (strictly monotonic)
    if (
      currentTrackerDoc.exists &&
      currentTrackerDoc.data().activeReservationId === reservationId
    ) {
      transaction.update(trackerRef, {
        activeReservationId: null,
        updatedAt: now,
      });
    }

    logger.info(
      "Cancellation independently verified and finalized on-chain. Nonce safely consumed and slot resolved",
      {
        reservationId,
        wallet: canonicalWallet,
        nonce: persistedNonce,
        cancelBlockNumber: receipt.blockNumber,
        confirmationCount,
        finalityMethod,
        highestReservedNonce: currentTrackerDoc.data()?.highestReservedNonce,
      }
    );

    return {
      resolved: true,
      status: TRANSACTION_STATUS.CANCELLED_ON_CHAIN,
      nonce: persistedNonce,
      cancelBlockNumber: receipt.blockNumber,
      confirmationCount,
      finalityMethod,
    };
  });
}

module.exports = {
  validateEthereumAddress,
  reserveNonce,
  getReservation,
  getWalletNonceTracker,
  expireReservation,
  markCancellationPending,
  confirmCancellationOnChain,
};

