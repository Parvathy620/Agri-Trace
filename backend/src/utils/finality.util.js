/**
 * Finality Error Classification Utility.
 *
 * Provides a strict allowlist for detecting EVM providers that do not support
 * the post-Merge Casper FFG 'finalized' block tag (e.g. local Hardhat/Anvil dev nodes),
 * while strictly preventing authentication failures, rate limiting, network timeouts,
 * and unknown server errors from triggering fallback finality.
 */

/**
 * Strict allowlist of recognised unsupported-method or unsupported-block-tag errors.
 * Explicitly excludes network failures, auth failures, rate limiting, and unknown server errors.
 *
 * @param {Error} error
 * @returns {boolean} True only if error positively establishes that the finalized tag or method is unsupported.
 */
function isRecognisedUnsupportedFinalizedTagError(error) {
  if (!error) return false;

  const errMsg = (error.message || "").toLowerCase();
  const errCode = (error.code || "").toString().toUpperCase();
  const jsonRpcCode =
    error.error && typeof error.error.code === "number"
      ? error.error.code
      : typeof error.code === "number"
      ? error.code
      : null;

  // JSON-RPC Standard: -32601 is Method not found
  if (jsonRpcCode === -32601 || errCode === "UNSUPPORTED_OPERATION") {
    return true;
  }

  // Explicit allowlist of recognized unsupported finalized tag phrases across EVM clients:
  // (Hardhat, Anvil, Ganache, Geth, Besu, Nethermind, Erigon)
  const explicitPhrases = [
    "with tag 'finalized' not supported",
    "with tag \"finalized\" not supported",
    "tag 'finalized' not supported",
    "tag \"finalized\" not supported",
    "tag 'finalized' is not supported",
    "tag \"finalized\" is not supported",
    "not supported for tag finalized",
    "unsupported block tag",
    "invalid block tag",
    "unknown block tag",
    "tag finalized not found",
    "cannot find block with tag finalized",
    "tag 'finalized' is not recognized",
    "invalid block parameter: finalized",
    "invalid block parameter 'finalized'",
    "invalid block parameter \"finalized\"",
    "the method eth_getblockbynumber does not support block tag finalized",
    "unknown block 'finalized'",
    "unknown block \"finalized\"",
    "unknown block finalized",
    "header not found for tag finalized",
    "block not found for tag 'finalized'",
    "unrecognized block tag: finalized",
    "block tag finalized is not supported",
  ];

  for (const phrase of explicitPhrases) {
    if (errMsg.includes(phrase)) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies an error thrown while querying provider.getBlock("finalized").
 *
 * @param {Error} error
 * @returns {{ isNetwork?: boolean, isAuth?: boolean, isRateLimit?: boolean, isUnsupported?: boolean, isUnknown?: boolean, reason: string|null }}
 */
function classifyFinalizedBlockError(error) {
  if (!error) return { isUnknown: true, reason: "RPC_UNKNOWN_ERROR" };

  const errMsg = (error.message || "").toLowerCase();
  const errCode = (error.code || "").toString().toUpperCase();

  // 1. Network / Timeout Failures
  const isNetworkOrTimeout =
    errCode === "TIMEOUT" ||
    errCode === "NETWORK_ERROR" ||
    errCode === "SERVER_ERROR" ||
    errMsg.includes("timeout") ||
    errMsg.includes("timed out") ||
    errMsg.includes("econnrefused") ||
    errMsg.includes("econnreset") ||
    errMsg.includes("enotfound") ||
    errMsg.includes("socket") ||
    errMsg.includes("network error") ||
    errMsg.includes("network timeout") ||
    errMsg.includes("network failure") ||
    errMsg.includes("network disconnected") ||
    errMsg.includes("fetch failed") ||
    errMsg.includes("bad response") ||
    errMsg.includes("gateway") ||
    errMsg.includes("service unavailable");

  if (isNetworkOrTimeout) {
    return { isNetwork: true, reason: "RPC_FINALITY_QUERY_FAILED" };
  }

  // 2. Authentication or Authorization Failures
  const isAuthFailure =
    errCode === "AUTH_ERROR" ||
    errMsg.includes("unauthorized") ||
    errMsg.includes("forbidden") ||
    errMsg.includes("authentication") ||
    errMsg.includes("authorization") ||
    errMsg.includes("invalid api key") ||
    errMsg.includes("bad credentials") ||
    errMsg.includes("access denied") ||
    errMsg.includes("invalid project id");

  if (isAuthFailure) {
    return { isAuth: true, reason: "RPC_AUTH_FAILURE" };
  }

  // 3. Rate Limiting
  const isRateLimited =
    errMsg.includes("rate limit") ||
    errMsg.includes("too many requests") ||
    errMsg.includes("throughput exceeded") ||
    errMsg.includes("request limit exceeded") ||
    errMsg.includes("compute units") ||
    errMsg.includes("exceeded the rate");

  if (isRateLimited) {
    return { isRateLimit: true, reason: "RPC_RATE_LIMITED" };
  }

  // 4. Explicit Unsupported Method or Block Tag Allowlist
  if (isRecognisedUnsupportedFinalizedTagError(error)) {
    return { isUnsupported: true, reason: null };
  }

  // 5. All other unknown errors, unexpected exceptions, server errors fail closed
  return { isUnknown: true, reason: "RPC_UNKNOWN_ERROR" };
}

module.exports = {
  isRecognisedUnsupportedFinalizedTagError,
  classifyFinalizedBlockError,
};

