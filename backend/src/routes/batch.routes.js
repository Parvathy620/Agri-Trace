/**
 * @file batch.routes.js
 * @description Express routing for agricultural batch endpoints.
 * Mounts the non-custodial batch preparation pipeline (/batches/prepare).
 */

const { Router } = require("express");
const { authenticate: defaultAuthenticate } = require("../middleware/auth.middleware");
const defaultBatchController = require("../controllers/batch.controller");

/**
 * Creates batch router with optional dependency injection for testing.
 * @param {Object} [deps]
 * @param {import("express").RequestHandler} [deps.authenticate] - Authentication middleware override
 * @param {Object} [deps.controller] - Batch controller override
 * @returns {Router} Express Router
 */
function createBatchRouter({
  authenticate = defaultAuthenticate,
  controller = defaultBatchController,
} = {}) {
  const router = Router();

  // POST /api/v1/batches/prepare
  // Prepares an unsigned blockchain transaction for creating an agricultural batch
  router.post("/prepare", authenticate, controller.prepareBatch);

  // POST /api/v1/batches
  // Submits a participant-signed raw transaction for validation and mempool broadcasting
  router.post("/", authenticate, controller.submitBatch);

  return router;
}

const batchRouter = createBatchRouter();
batchRouter.createBatchRouter = createBatchRouter;

module.exports = batchRouter;

