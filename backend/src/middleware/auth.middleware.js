const { auth: defaultAuth, firestore: defaultFirestore } = require("../config/firebase");

/**
 * Creates Firebase Authentication middleware with dependency injection for testing.
 * @param {Object} [deps]
 * @param {import("firebase-admin").auth.Auth} [deps.auth] - Firebase Auth instance
 * @param {import("firebase-admin").firestore.Firestore} [deps.firestore] - Firestore instance
 * @returns {import("express").RequestHandler}
 */
function createAuthMiddleware({ auth = defaultAuth, firestore = defaultFirestore } = {}) {
  return async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: {
          message: "Authorization header missing",
          code: "AUTH_HEADER_MISSING",
        },
      });
    }

    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || !parts[1]) {
      return res.status(401).json({
        success: false,
        error: {
          message: "Malformed Authorization header. Format: Bearer <token>",
          code: "AUTH_TOKEN_MALFORMED",
        },
      });
    }

    const idToken = parts[1];

    let decodedToken;
    try {
      // Check token validity and revocation status (checkRevoked = true)
      decodedToken = await auth.verifyIdToken(idToken, true);
    } catch (err) {
      const isRevoked = err.code === "auth/id-token-revoked";
      return res.status(401).json({
        success: false,
        error: {
          message: isRevoked
            ? "Authentication token has been revoked"
            : "Authentication token is invalid or expired",
          code: isRevoked ? "AUTH_TOKEN_REVOKED" : "AUTH_TOKEN_INVALID",
        },
      });
    }

    // Retrieve active participant profile from Firestore
    let userDoc;
    try {
      userDoc = await firestore.collection("users").doc(decodedToken.uid).get();
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: {
          message: "Failed to retrieve user profile",
          code: "DATABASE_ERROR",
        },
      });
    }

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          message: "User profile not found. User registration is required.",
          code: "USER_PROFILE_NOT_FOUND",
        },
      });
    }

    const userData = userDoc.data() || {};

    if (userData.isActive === false) {
      return res.status(403).json({
        success: false,
        error: {
          message: "User account is inactive or disabled",
          code: "ACCOUNT_INACTIVE",
        },
      });
    }

    // Attach verified identity to request object
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || userData.email || null,
      ...userData,
    };
    req.token = decodedToken;

    return next();
  };
}

const authenticate = createAuthMiddleware();

module.exports = {
  createAuthMiddleware,
  authenticate,
};

