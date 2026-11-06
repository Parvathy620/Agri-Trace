const crypto = require("crypto");
const { ethers } = require("ethers");
const { firestore: defaultFirestore } = require("../config/firebase");
const { WALLET_CHALLENGE_TTL_MS, CHALLENGE_DOMAIN } = require("../config/constants");

/**
 * Constructs the canonical human-readable challenge message signed by participant wallets.
 * Explicitly binds the domain, purpose, UID, wallet address, nonce, and lifecycle timestamps.
 */
function buildChallengeMessage({ uid, walletAddress, nonce, issuedAt, expiresAt, challengeId }) {
  return [
    "AgriTrace Wallet Link Verification",
    `Domain: ${CHALLENGE_DOMAIN}`,
    "Purpose: Link Ethereum wallet to AgriTrace account",
    `UID: ${uid}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    `Challenge ID: ${challengeId}`,
  ].join("\n");
}

/**
 * Creates and persists a time-bounded wallet-linking cryptographic challenge.
 *
 * @param {Object} params
 * @param {string} params.uid - Authenticated Firebase UID
 * @param {string} params.walletAddress - Ethereum wallet address to link
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore] - Firestore instance
 * @returns {Promise<{ challengeId: string, walletAddress: string, message: string, expiresAt: string }>}
 */
async function createChallenge({ uid, walletAddress, firestore = defaultFirestore }) {
  if (!walletAddress || typeof walletAddress !== "string") {
    const error = new Error("Valid Ethereum walletAddress is required");
    error.statusCode = 400;
    error.code = "INVALID_WALLET_ADDRESS";
    throw error;
  }

  let normalizedAddress;
  try {
    normalizedAddress = ethers.getAddress(walletAddress.trim());
  } catch (err) {
    const error = new Error("Invalid 20-byte Ethereum wallet address format");
    error.statusCode = 400;
    error.code = "INVALID_WALLET_ADDRESS";
    throw error;
  }

  // Check if caller's account already has a different linked wallet (prevent silent overwrite)
  const userDoc = await firestore.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().walletAddress) {
    const existingWallet = userDoc.data().walletAddress;
    if (existingWallet.toLowerCase() !== normalizedAddress.toLowerCase()) {
      const error = new Error(
        "User account already has a linked wallet. Overwriting an existing wallet association is prohibited"
      );
      error.statusCode = 409;
      error.code = "USER_WALLET_ALREADY_LINKED";
      throw error;
    }
  }

  // Pre-check if wallet is already linked to another participant account using canonical lowercase doc ID
  const canonicalDocId = normalizedAddress.toLowerCase();
  const mappingDoc = await firestore.collection("walletMappings").doc(canonicalDocId).get();
  if (mappingDoc.exists && mappingDoc.data().uid !== uid) {
    const error = new Error("Wallet is already linked to another participant account");
    error.statusCode = 409;
    error.code = "WALLET_ALREADY_LINKED";
    throw error;
  }

  const nonce = crypto.randomBytes(32).toString("hex");
  const challengeId = crypto.randomUUID();
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + WALLET_CHALLENGE_TTL_MS).toISOString();

  const message = buildChallengeMessage({
    uid,
    walletAddress: normalizedAddress,
    nonce,
    issuedAt,
    expiresAt,
    challengeId,
  });

  const challengeRecord = {
    challengeId,
    uid,
    walletAddress: normalizedAddress,
    nonce,
    purpose: "LINK_WALLET",
    domain: CHALLENGE_DOMAIN,
    message,
    issuedAt,
    expiresAt,
    isConsumed: false,
    status: "PENDING",
  };

  await firestore.collection("walletLinkChallenges").doc(challengeId).set(challengeRecord);

  return {
    challengeId,
    walletAddress: normalizedAddress,
    message,
    expiresAt,
  };
}

/**
 * Verifies a participant wallet's cryptographic signature against an issued challenge
 * and atomically commits the wallet linkage to Firestore.
 *
 * @param {Object} params
 * @param {string} params.uid - Authenticated Firebase UID
 * @param {string} params.challengeId - Unique challenge identifier
 * @param {string} params.signature - 65-byte hex signature (0x...) produced by personal_sign
 * @param {import("firebase-admin").firestore.Firestore} [params.firestore] - Firestore instance
 * @returns {Promise<{ walletAddress: string, linkedAt: string }>}
 */
async function verifyAndLinkWallet({ uid, challengeId, signature, firestore = defaultFirestore }) {
  if (!challengeId || typeof challengeId !== "string") {
    const error = new Error("Missing or invalid challengeId");
    error.statusCode = 400;
    error.code = "MISSING_CHALLENGE_ID";
    throw error;
  }

  if (!signature || typeof signature !== "string") {
    const error = new Error("Missing wallet cryptographic signature");
    error.statusCode = 400;
    error.code = "MISSING_SIGNATURE";
    throw error;
  }

  const cleanSignature = signature.trim();
  if (!/^0x[a-fA-F0-9]{130}$/.test(cleanSignature)) {
    const error = new Error("Invalid signature format: Expected 65-byte hex string (0x...)");
    error.statusCode = 400;
    error.code = "INVALID_SIGNATURE_FORMAT";
    throw error;
  }

  const linkedAt = new Date().toISOString();
  let verifiedWalletAddress;

  // Execute atomically via Firestore transaction to prevent replay and race conditions
  await firestore.runTransaction(async (transaction) => {
    const challengeRef = firestore.collection("walletLinkChallenges").doc(challengeId);
    const challengeDoc = await transaction.get(challengeRef);

    if (!challengeDoc.exists) {
      const error = new Error("Wallet link challenge not found");
      error.statusCode = 404;
      error.code = "CHALLENGE_NOT_FOUND";
      throw error;
    }

    const challenge = challengeDoc.data();

    // Verify challenge belongs to the authenticated user
    if (challenge.uid !== uid) {
      const error = new Error("Unauthorized: Challenge belongs to another user account");
      error.statusCode = 403;
      error.code = "CHALLENGE_UID_MISMATCH";
      throw error;
    }

    // Verify challenge has not already been consumed
    if (challenge.isConsumed || challenge.status === "CONSUMED") {
      const error = new Error("Challenge has already been consumed and cannot be replayed");
      error.statusCode = 409;
      error.code = "CHALLENGE_ALREADY_CONSUMED";
      throw error;
    }

    // Verify challenge has not expired
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      const error = new Error("Challenge has expired. Please request a new challenge");
      error.statusCode = 400;
      error.code = "CHALLENGE_EXPIRED";
      throw error;
    }

    // Cryptographically recover signer address from message and signature
    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyMessage(challenge.message, cleanSignature);
    } catch (err) {
      const error = new Error("Failed to verify signature against challenge message");
      error.statusCode = 400;
      error.code = "INVALID_SIGNATURE";
      throw error;
    }

    const normalizedRecovered = ethers.getAddress(recoveredAddress);
    if (normalizedRecovered !== challenge.walletAddress) {
      const error = new Error(
        `Signer mismatch: Recovered address ${normalizedRecovered} does not match challenge wallet ${challenge.walletAddress}`
      );
      error.statusCode = 403;
      error.code = "WALLET_SIGNATURE_MISMATCH";
      throw error;
    }

    // Verify target wallet is not already linked to another participant using canonical lowercase doc ID
    const canonicalDocId = challenge.walletAddress.toLowerCase();
    const walletMappingRef = firestore.collection("walletMappings").doc(canonicalDocId);
    const mappingDoc = await transaction.get(walletMappingRef);

    if (mappingDoc.exists && mappingDoc.data().uid !== uid) {
      const error = new Error("Wallet is already linked to another participant account");
      error.statusCode = 409;
      error.code = "WALLET_ALREADY_LINKED";
      throw error;
    }

    // Verify user profile exists and does not already have a different linked wallet
    const userRef = firestore.collection("users").doc(uid);
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      const error = new Error("User profile not found");
      error.statusCode = 404;
      error.code = "USER_PROFILE_NOT_FOUND";
      throw error;
    }

    const userData = userDoc.data();
    if (
      userData.walletAddress &&
      userData.walletAddress.toLowerCase() !== challenge.walletAddress.toLowerCase()
    ) {
      const error = new Error(
        "Account already has a linked wallet. Overwriting an existing wallet association is prohibited"
      );
      error.statusCode = 409;
      error.code = "USER_WALLET_ALREADY_LINKED";
      throw error;
    }

    // Commit atomic changes:
    // 1. Consume challenge
    transaction.update(challengeRef, {
      isConsumed: true,
      status: "CONSUMED",
      consumedAt: linkedAt,
    });

    // 2. Register global wallet-to-UID mapping with canonical lowercase doc ID
    transaction.set(walletMappingRef, {
      uid,
      walletAddress: challenge.walletAddress,
      canonicalAddress: canonicalDocId,
      linkedAt,
    });

    // 3. Update user profile with linked wallet
    transaction.update(userRef, {
      walletAddress: challenge.walletAddress,
      updatedAt: linkedAt,
    });

    verifiedWalletAddress = challenge.walletAddress;
  });

  return {
    walletAddress: verifiedWalletAddress,
    linkedAt,
  };
}

module.exports = {
  buildChallengeMessage,
  createChallenge,
  verifyAndLinkWallet,
};

