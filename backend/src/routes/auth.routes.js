const { Router } = require("express");
const { authenticate: defaultAuthenticate } = require("../middleware/auth.middleware");
const defaultAuthController = require("../controllers/auth.controller");

/**
 * Creates authentication and wallet-linking route handler with optional dependency injection.
 * @param {Object} [deps]
 * @param {import("express").RequestHandler} [deps.authenticate] - Authentication middleware override
 * @param {Object} [deps.controller] - Controller implementation override
 * @returns {Router} Express Router
 */
function createAuthRouter({
  authenticate = defaultAuthenticate,
  controller = defaultAuthController,
} = {}) {
  const router = Router();

  // Request a cryptographic wallet challenge
  router.post("/wallet/challenge", authenticate, controller.requestWalletChallenge);

  // Submit wallet signature to verify and link wallet atomically
  router.post("/wallet/verify", authenticate, controller.verifyWalletChallenge);

  // Retrieve authenticated participant profile
  router.get("/me", authenticate, controller.getMe);

  return router;
}

const authRouter = createAuthRouter();
authRouter.createAuthRouter = createAuthRouter;

module.exports = authRouter;

