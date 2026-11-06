const { contract: defaultContract } = require("../config/blockchain");
const { CONTRACT_ROLES, ROLES } = require("../config/constants");

/**
 * Authorization middleware enforcing Firestore application roles.
 * Never trusts role values submitted in the request body.
 *
 * @param {string|string[]} allowedRoles - Single role or array of allowed roles
 * @returns {import("express").RequestHandler}
 */
function requireRole(allowedRoles) {
  const rolesList = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return function authorizeRole(req, res, next) {
    if (!req.user || !req.user.role) {
      return res.status(403).json({
        success: false,
        error: {
          message: "Role unauthorized: User profile does not have an assigned role",
          code: "ROLE_UNAUTHORIZED",
        },
      });
    }

    if (req.user.isActive === false) {
      return res.status(403).json({
        success: false,
        error: {
          message: "User account is inactive or disabled",
          code: "ACCOUNT_INACTIVE",
        },
      });
    }

    if (!rolesList.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          message: `Insufficient permissions: Requires one of [${rolesList.join(", ")}], but account has role '${req.user.role}'`,
          code: "ROLE_FORBIDDEN",
        },
      });
    }

    return next();
  };
}

/**
 * Preflight middleware verifying on-chain role membership using the smart contract.
 * Queries `hasRole(bytes32 role, address account)` on AgriTrace.sol.
 * Safely handles RPC failures by returning HTTP 503 without failing open.
 *
 * @param {string} requiredRole - Role key matching ROLES enum (e.g. 'FARMER')
 * @param {Object} [deps]
 * @param {import("ethers").Contract} [deps.contract] - Read-only contract instance
 * @returns {import("express").RequestHandler}
 */
function requireOnChainRole(requiredRole, { contract = defaultContract } = {}) {
  const roleBytes32 = CONTRACT_ROLES[requiredRole];
  if (!roleBytes32) {
    throw new Error(`Unknown contract role identifier: ${requiredRole}`);
  }

  return async function authorizeOnChainRole(req, res, next) {
    if (!req.user || !req.user.walletAddress) {
      return res.status(403).json({
        success: false,
        error: {
          message: "Wallet linking required: Authenticated user has no linked Ethereum wallet",
          code: "WALLET_NOT_LINKED",
        },
      });
    }

    const walletAddress = req.user.walletAddress;

    try {
      const hasRole = await contract.hasRole(roleBytes32, walletAddress);

      if (!hasRole) {
        return res.status(403).json({
          success: false,
          error: {
            message: `Wallet ${walletAddress} does not possess required on-chain role '${requiredRole}'`,
            code: "ON_CHAIN_ROLE_UNAUTHORIZED",
          },
        });
      }

      return next();
    } catch (err) {
      // Never treat an RPC failure as successful verification
      return res.status(503).json({
        success: false,
        error: {
          message: "Blockchain RPC node unavailable for on-chain role verification",
          code: "BLOCKCHAIN_UNAVAILABLE",
        },
      });
    }
  };
}

module.exports = {
  requireRole,
  requireOnChainRole,
  ROLES,
  CONTRACT_ROLES,
};

