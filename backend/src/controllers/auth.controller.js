const walletService = require("../services/wallet.service");

/**
 * Controller handling user authentication, profile queries, and wallet-linking challenge flows.
 */

/**
 * POST /api/v1/auth/wallet/challenge
 * Issues a cryptographic challenge for linking a participant wallet.
 */
async function requestWalletChallenge(req, res, next) {
  try {
    const { walletAddress } = req.body;
    const challenge = await walletService.createChallenge({
      uid: req.user.uid,
      walletAddress,
    });

    return res.status(200).json({
      success: true,
      data: challenge,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/auth/wallet/verify
 * Validates cryptographic signature and atomically binds wallet to user account.
 */
async function verifyWalletChallenge(req, res, next) {
  try {
    const { challengeId, signature } = req.body;
    const result = await walletService.verifyAndLinkWallet({
      uid: req.user.uid,
      challengeId,
      signature,
    });

    return res.status(200).json({
      success: true,
      message: "Wallet linked successfully",
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/auth/me
 * Retrieves current authenticated user profile without exposing sensitive internal data.
 */
async function getMe(req, res, next) {
  try {
    const user = req.user;

    return res.status(200).json({
      success: true,
      data: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || null,
        role: user.role,
        walletAddress: user.walletAddress || null,
        organization: user.organization || null,
        isActive: user.isActive !== false,
        createdAt: user.createdAt || null,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  requestWalletChallenge,
  verifyWalletChallenge,
  getMe,
};

