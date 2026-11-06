/**
 * @file batch.controller.js
 * @description Controller handling agricultural batch operations and transaction preparation.
 * Operates strictly non-custodially: never signs transactions or stores private keys.
 */

const defaultBatchService = require("../services/batch.service");

/**
 * Creates batch controller with optional dependency injection for testing.
 * @param {Object} [deps]
 * @param {Object} [deps.batchService] - Batch service implementation override
 * @returns {Object} Controller methods
 */
function createBatchController({ batchService = defaultBatchService } = {}) {
  /**
   * POST /api/v1/batches/prepare
   * Prepares an unsigned blockchain transaction for creating an agricultural batch.
   */
  async function prepareBatch(req, res, next) {
    try {
      const uid = req.user.uid;
      const userRole = req.user.role;
      const userWalletAddress = req.user.walletAddress;

      // Extract client idempotency key from header or body
      let idempotencyKey = req.headers["idempotency-key"] || null;
      let requestedWalletAddress = null;
      let rawMetadata = null;

      if (req.body && typeof req.body === "object") {
        if (req.body.idempotencyKey) {
          idempotencyKey = req.body.idempotencyKey;
        }
        if (req.body.walletAddress) {
          requestedWalletAddress = req.body.walletAddress;
        }

        if (req.body.metadata && typeof req.body.metadata === "object") {
          rawMetadata = req.body.metadata;
        } else {
          // If metadata is passed flat at the root of the request body,
          // strip envelope fields (walletAddress, idempotencyKey) before validation
          const { walletAddress: _w, idempotencyKey: _k, ...rest } = req.body;
          rawMetadata = rest;
        }
      }

      const unsignedTx = await batchService.prepareBatchCreation({
        uid,
        userRole,
        userWalletAddress,
        rawMetadata,
        requestedWalletAddress,
        idempotencyKey,
      });

      return res.status(200).json({
        success: true,
        data: unsignedTx,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/batches
   * Submits a participant-signed raw transaction for validation and mempool broadcasting.
   */
  async function submitBatch(req, res, next) {
    try {
      const uid = req.user.uid;
      const userWalletAddress = req.user.walletAddress;

      const { signedTxHex, reservationId } = req.body || {};
      const idempotencyKey = req.headers["idempotency-key"] || req.body?.idempotencyKey || null;

      const result = await batchService.submitBatchCreation({
        uid,
        userWalletAddress,
        signedTxHex,
        reservationId,
        idempotencyKey,
      });

      const statusCode =
        result.status === "PENDING_BLOCKCHAIN" || result.status === "RECONCILIATION_REQUIRED"
          ? 202
          : 200;

      return res.status(statusCode).json({
        success: true,
        data: result,
      });
    } catch (err) {
      return next(err);
    }
  }

  return {
    prepareBatch,
    submitBatch,
  };
}

const defaultController = createBatchController();
defaultController.createBatchController = createBatchController;

module.exports = defaultController;

