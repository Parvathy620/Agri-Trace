/**
 * @file batch.test.js
 * @description Comprehensive automated test suite for Step 3B.5.2: Batch Transaction Preparation.
 * Tests POST /api/v1/batches/prepare across all authentication, authorization, metadata validation,
 * on-chain preflight, gas estimation, nonce reservation, idempotency, and security constraints.
 */

const { expect } = require("chai");
const request = require("supertest");
const express = require("express");
const { ethers } = require("ethers");
const { createAuthMiddleware } = require("../src/middleware/auth.middleware");
const { createBatchRouter } = require("../src/routes/batch.routes");
const { createBatchController } = require("../src/controllers/batch.controller");
const { prepareBatchCreation, submitBatchCreation } = require("../src/services/batch.service");
const { errorHandler } = require("../src/middleware/error.middleware");
const { CONTRACT_ROLES, ROLES, TRANSACTION_STATUS } = require("../src/config/constants");
const contractArtifact = require("../src/contracts/AgriTrace.json");

describe("Step 3B.5.2: Batch Transaction Preparation (POST /api/v1/batches/prepare)", () => {
  // Golden Vector Metadata from Section 6.3
  const GOLDEN_INPUT = Object.freeze({
    category: "Fresh Produce",
    cropVariety: "Roma Tomato",
    harvestDate: "2026-11-01T10:00:00Z",
    humanBatchId: "BATCH-2026-TOMATO-001",
    origin: "Green Valley Farm",
    quantity: 1500,
    unit: "kg",
  });

  const GOLDEN_BATCH_ID = "0x7078459f06a313998aff5f7192ae0fa5e58cf9823f4422a8073561b04462125e";
  const GOLDEN_METADATA_HASH = "0xbec1c34ae775c4e85a9d48774328d093061dadc4422fffb483384410e74e658e";

  let testWallet;
  let otherWallet;
  const testUid = "usr_farmer_001";
  const unlinkedUid = "usr_farmer_unlinked";
  const nonFarmerUid = "usr_transporter_002";
  const configuredChainId = 31337;
  const configuredContractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  let dbState;
  let mockFirestore;
  let mockAuth;
  let mockContract;
  let mockProvider;
  let app;
  let broadcastSpyCalled;

  beforeEach(() => {
    testWallet = ethers.Wallet.createRandom();
    otherWallet = ethers.Wallet.createRandom();
    broadcastSpyCalled = false;

    dbState = {
      users: {
        [testUid]: {
          uid: testUid,
          email: "farmer@agritrace.org",
          role: "FARMER",
          walletAddress: testWallet.address,
          isActive: true,
        },
        [unlinkedUid]: {
          uid: unlinkedUid,
          email: "unlinked@agritrace.org",
          role: "FARMER",
          walletAddress: null,
          isActive: true,
        },
        [nonFarmerUid]: {
          uid: nonFarmerUid,
          email: "transporter@agritrace.org",
          role: "TRANSPORTER",
          walletAddress: otherWallet.address,
          isActive: true,
        },
      },
      walletNonceTrackers: {},
      nonceReservations: {},
      idempotencyKeys: {},
      batches: {},
    };

    function makeDocRef(colName, docId) {
      return {
        _col: colName,
        _id: docId,
        get: async () => {
          const data = dbState[colName]?.[docId];
          return {
            exists: Boolean(data),
            data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          };
        },
        set: async (docData, options = {}) => {
          if (!dbState[colName]) dbState[colName] = {};
          if (options.merge && dbState[colName][docId]) {
            dbState[colName][docId] = { ...dbState[colName][docId], ...docData };
          } else {
            dbState[colName][docId] = { ...docData };
          }
        },
        update: async (updates) => {
          if (!dbState[colName]?.[docId]) {
            throw new Error(`Document ${colName}/${docId} not found`);
          }
          dbState[colName][docId] = { ...dbState[colName][docId], ...updates };
        },
      };
    }

    mockFirestore = {
      collection: (colName) => ({
        doc: (docId) => makeDocRef(colName, docId),
      }),
      runTransaction: async (updateFn) => {
        const transaction = {
          get: async (ref) => ref.get(),
          set: (ref, data, opts) => ref.set(data, opts),
          update: (ref, data) => ref.update(data),
        };
        return await updateFn(transaction);
      },
    };

    mockAuth = {
      verifyIdToken: async (token) => {
        if (token === "token_farmer_valid") {
          return { uid: testUid, email: "farmer@agritrace.org" };
        }
        if (token === "token_unlinked_wallet") {
          return { uid: unlinkedUid, email: "unlinked@agritrace.org" };
        }
        if (token === "token_non_farmer") {
          return { uid: nonFarmerUid, email: "transporter@agritrace.org" };
        }
        const err = new Error("Invalid or expired Firebase ID token");
        err.code = "auth/invalid-id-token";
        throw err;
      },
    };

    const iface = new ethers.Interface(contractArtifact.abi);

    mockContract = {
      interface: iface,
      hasRole: async (role, address) => {
        // testWallet has FARMER_ROLE
        return (
          role === CONTRACT_ROLES[ROLES.FARMER] &&
          address.toLowerCase() === testWallet.address.toLowerCase()
        );
      },
      createBatch: {
        staticCall: async (bId, mHash, overrides) => {
          // Preflight staticCall simulation
          if (bId === ethers.ZeroHash || mHash === ethers.ZeroHash) {
            throw new Error("Invalid batch ID or metadata hash");
          }
          return true;
        },
        estimateGas: async (bId, mHash, overrides) => {
          return 105000n;
        },
      },
    };

    mockProvider = {
      getTransactionCount: async (address, tag) => 0,
      getBlockNumber: async () => 100,
      broadcastTransaction: async () => {
        broadcastSpyCalled = true;
        throw new Error("UNEXPECTED: Backend must NEVER broadcast transactions in prepare endpoint!");
      },
      sendTransaction: async () => {
        broadcastSpyCalled = true;
        throw new Error("UNEXPECTED: Backend must NEVER send transactions in prepare endpoint!");
      },
    };

    // Build Express App with mocked dependencies
    const authMiddleware = createAuthMiddleware({ auth: mockAuth, firestore: mockFirestore });
    const batchService = {
      prepareBatchCreation: (params) =>
        prepareBatchCreation({
          ...params,
          contract: mockContract,
          provider: mockProvider,
          firestore: mockFirestore,
          chainId: configuredChainId,
          contractAddress: configuredContractAddress,
        }),
    };
    const batchController = createBatchController({ batchService });
    const batchRouter = createBatchRouter({
      authenticate: authMiddleware,
      controller: batchController,
    });

    app = express();
    app.use(express.json());
    app.use("/api/v1/batches", batchRouter);
    app.use(errorHandler);
  });

  // ==============================================================================
  // 1. Successful Batch Preparation
  // ==============================================================================
  it("1. Successfully prepares batch creation transaction returning complete structured payload", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    expect(res.body.success).to.be.true;

    const data = res.body.data;
    expect(data.reservationId).to.be.a("string").with.lengthOf(36);
    expect(data.humanBatchId).to.equal(GOLDEN_INPUT.humanBatchId);
    expect(data.batchId).to.equal(GOLDEN_BATCH_ID);
    expect(data.metadataHash).to.equal(GOLDEN_METADATA_HASH);
    expect(data.chainId).to.equal(configuredChainId);
    expect(data.contractAddress).to.equal(configuredContractAddress);
    expect(data.from.toLowerCase()).to.equal(testWallet.address.toLowerCase());
    expect(data.to).to.equal(configuredContractAddress);
    expect(data.value).to.equal("0x0");
    expect(data.nonce).to.equal(0);
    expect(data.gasLimit).to.equal("126000"); // 105000 * 1.2
    expect(data.expiresAt).to.be.a("string");
    expect(new Date(data.expiresAt).getTime()).to.be.greaterThan(Date.now());
  });

  // ==============================================================================
  // 2. Missing Firebase Authentication
  // ==============================================================================
  it("2. Rejects request missing Authorization header with 401 AUTH_HEADER_MISSING", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_HEADER_MISSING");
  });

  // ==============================================================================
  // 3. Missing Linked Wallet
  // ==============================================================================
  it("3. Rejects user without a linked wallet with 403 WALLET_NOT_LINKED", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_unlinked_wallet")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("WALLET_NOT_LINKED");
  });

  // ==============================================================================
  // 4. Wallet Mismatch Protection
  // ==============================================================================
  it("4. Rejects request when client-supplied walletAddress does not match linked wallet with 403 WALLET_MISMATCH", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({
        metadata: GOLDEN_INPUT,
        walletAddress: otherWallet.address, // Attempting to prepare for a different wallet
      });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("WALLET_MISMATCH");
  });

  // ==============================================================================
  // 5. Missing FARMER_ROLE
  // ==============================================================================
  it("5a. Rejects user lacking FARMER business role with 403 ROLE_FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_non_farmer")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("ROLE_FORBIDDEN");
  });

  it("5b. Rejects user whose wallet lacks on-chain FARMER_ROLE with 403 ON_CHAIN_ROLE_UNAUTHORIZED", async () => {
    // Override hasRole to report false
    mockContract.hasRole = async () => false;

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("ON_CHAIN_ROLE_UNAUTHORIZED");
  });

  // ==============================================================================
  // 6. Invalid Metadata Rejection
  // ==============================================================================
  it("6a. Rejects metadata missing required fields with 422 MISSING_METADATA_FIELD", async () => {
    const invalidInput = { ...GOLDEN_INPUT };
    delete invalidInput.cropVariety;

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: invalidInput });

    expect(res.status).to.equal(422);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("MISSING_METADATA_FIELD");
  });

  it("6b. Rejects metadata containing unexpected unapproved fields with 422 UNEXPECTED_METADATA_FIELD", async () => {
    const tamperedInput = { ...GOLDEN_INPUT, unauthorizedField: "injection" };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: tamperedInput });

    expect(res.status).to.equal(422);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("UNEXPECTED_METADATA_FIELD");
  });

  it("6c. Rejects impossible calendar dates (non-rollover) with 422 INVALID_HARVEST_DATE", async () => {
    const badDateInput = { ...GOLDEN_INPUT, harvestDate: "2026-02-30T10:00:00Z" };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: badDateInput });

    expect(res.status).to.equal(422);
    expect(res.body.success).to.be.false;
  });

  it("6d. Rejects empty body with 400 INVALID_METADATA", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({});

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INVALID_METADATA");
  });

  // ==============================================================================
  // 7. Duplicate Batch ID
  // ==============================================================================
  it("7a. Rejects duplicate batch ID when staticCall simulation reverts with 'Batch already exists'", async () => {
    mockContract.createBatch.staticCall = async () => {
      const err = new Error("VM Exception while processing transaction: reverted with reason string 'Batch already exists'");
      err.reason = "Batch already exists";
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(409);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("BATCH_ALREADY_EXISTS");
  });

  it("7b. Rejects duplicate batch ID when batch document already exists in Firestore", async () => {
    // Seed existing batch document in Firestore
    dbState.batches[GOLDEN_INPUT.humanBatchId] = {
      humanBatchId: GOLDEN_INPUT.humanBatchId,
      batchId: GOLDEN_BATCH_ID,
      status: "CREATED",
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(409);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("BATCH_ALREADY_EXISTS");
  });

  // ==============================================================================
  // 8. Golden-Vector Consistency
  // ==============================================================================
  it("8. Computes batchId and metadataHash exactly matching the Golden Vector", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    expect(res.body.data.batchId).to.equal(GOLDEN_BATCH_ID);
    expect(res.body.data.metadataHash).to.equal(GOLDEN_METADATA_HASH);
  });

  // ==============================================================================
  // 9. Correct Contract Calldata
  // ==============================================================================
  it("9. Encodes correct calldata with createBatch selector and arguments", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    const calldata = res.body.data.data;

    // Selector for createBatch(bytes32,bytes32)
    const expectedSelector = mockContract.interface.getFunction("createBatch").selector;
    expect(calldata.startsWith(expectedSelector)).to.be.true;

    // Decode calldata
    const decoded = mockContract.interface.decodeFunctionData("createBatch", calldata);
    expect(decoded[0]).to.equal(GOLDEN_BATCH_ID);
    expect(decoded[1]).to.equal(GOLDEN_METADATA_HASH);
  });

  // ==============================================================================
  // 10. Correct Chain ID & Contract Address
  // ==============================================================================
  it("10. Embeds correct configured chain ID and contract address", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    expect(res.body.data.chainId).to.equal(configuredChainId);
    expect(res.body.data.contractAddress).to.equal(configuredContractAddress);
    expect(res.body.data.to).to.equal(configuredContractAddress);
  });

  // ==============================================================================
  // 11. Static-Call Simulation Failure
  // ==============================================================================
  it("11. Rejects with 422 PREFLIGHT_SIMULATION_FAILED when contract simulation reverts", async () => {
    mockContract.createBatch.staticCall = async () => {
      const err = new Error("Execution reverted: Contract paused or invalid state");
      err.reason = "Contract paused";
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(422);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("PREFLIGHT_SIMULATION_FAILED");
  });

  // ==============================================================================
  // 12. RPC Failure
  // ==============================================================================
  it("12. Returns 503 BLOCKCHAIN_RPC_UNAVAILABLE when blockchain node is unreachable", async () => {
    mockContract.hasRole = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(503);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("BLOCKCHAIN_RPC_UNAVAILABLE");
  });

  // ==============================================================================
  // 13. Gas Estimation Failure Handling
  // ==============================================================================
  it("13. Handles gas estimation failure gracefully and returns gasLimit: null", async () => {
    mockContract.createBatch.estimateGas = async () => {
      throw new Error("RPC error: Gas estimation not supported on this node");
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    expect(res.body.success).to.be.true;
    expect(res.body.data.gasLimit).to.be.null;
    expect(res.body.data.reservationId).to.be.a("string");
  });

  // ==============================================================================
  // 14. Nonce Reservation Failure
  // ==============================================================================
  it("14. Propagates 500 error if Firestore fails during atomic nonce reservation", async () => {
    mockFirestore.runTransaction = async () => {
      throw new Error("Firestore connection timeout during nonce reservation");
    };

    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(500);
    expect(res.body.success).to.be.false;
  });

  // ==============================================================================
  // 15. Idempotent Retry Handling
  // ==============================================================================
  it("15a. Returning identical reservation when called twice with same Idempotency-Key", async () => {
    const idempotencyKey = "idemp_unique_key_001";

    const res1 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .set("Idempotency-Key", idempotencyKey)
      .send({ metadata: GOLDEN_INPUT });

    expect(res1.status).to.equal(200);
    const reservation1 = res1.body.data;

    // Second call with same idempotency key
    const res2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .set("Idempotency-Key", idempotencyKey)
      .send({ metadata: GOLDEN_INPUT });

    expect(res2.status).to.equal(200);
    const reservation2 = res2.body.data;

    expect(reservation2.reservationId).to.equal(reservation1.reservationId);
    expect(reservation2.nonce).to.equal(reservation1.nonce);
    expect(reservation2.data).to.equal(reservation1.data);
  });

  it("15b. Rejects with 409 IDEMPOTENCY_CONFLICT if Idempotency-Key is reused for different payload", async () => {
    const idempotencyKey = "idemp_conflict_key_002";

    // 1. First preparation
    const res1 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .set("Idempotency-Key", idempotencyKey)
      .send({ metadata: GOLDEN_INPUT });

    expect(res1.status).to.equal(200);

    // 2. Second preparation reusing same key but with different quantity
    const differentPayload = { ...GOLDEN_INPUT, quantity: 2000 };
    const res2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .set("Idempotency-Key", idempotencyKey)
      .send({ metadata: differentPayload });

    expect(res2.status).to.equal(409);
    expect(res2.body.success).to.be.false;
    expect(res2.body.error.code).to.equal("IDEMPOTENCY_CONFLICT");
  });

  // ==============================================================================
  // 16. Existing Unresolved Reservation Lock
  // ==============================================================================
  it("16. Rejects new reservation when an active unresolved reservation exists with 409 ACTIVE_RESERVATION_EXISTS", async () => {
    // 1. First reservation succeeds
    const res1 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res1.status).to.equal(200);

    // 2. Second reservation without resolving the first (different humanBatchId to avoid duplicate batch error)
    const secondBatch = { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-002" };
    const res2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: secondBatch });

    expect(res2.status).to.equal(409);
    expect(res2.body.success).to.be.false;
    expect(res2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // 17. Ensuring No Transaction is Broadcast
  // ==============================================================================
  it("17. Verifies that backend never broadcasts or sends transactions during preparation", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    expect(broadcastSpyCalled).to.be.false;
  });

  // ==============================================================================
  // 18. Ensuring No Private Key is Used
  // ==============================================================================
  it("18. Verifies that response is purely unsigned calldata and contains zero private keys or signatures", async () => {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: GOLDEN_INPUT });

    expect(res.status).to.equal(200);
    const data = res.body.data;

    // Must be unsigned
    expect(data.signature).to.be.undefined;
    expect(data.signedTx).to.be.undefined;
    expect(data.signedTxHex).to.be.undefined;
    expect(data.privateKey).to.be.undefined;
    expect(data.r).to.be.undefined;
    expect(data.s).to.be.undefined;
    expect(data.v).to.be.undefined;

    // Verify raw calldata is present for client-side signing
    expect(data.data).to.be.a("string").that.matches(/^0x[a-fA-F0-9]+$/);
  });
});

// ==============================================================================
// Step 3B.5.3: Signed Batch Submission & Broadcasting (POST /api/v1/batches)
// ==============================================================================
describe("Step 3B.5.3: Signed Batch Submission & Broadcasting (POST /api/v1/batches)", () => {
  const GOLDEN_INPUT = Object.freeze({
    category: "Fresh Produce",
    cropVariety: "Roma Tomato",
    harvestDate: "2026-11-01T10:00:00Z",
    humanBatchId: "BATCH-2026-TOMATO-001",
    origin: "Green Valley Farm",
    quantity: 1500,
    unit: "kg",
  });

  const GOLDEN_BATCH_ID = "0x7078459f06a313998aff5f7192ae0fa5e58cf9823f4422a8073561b04462125e";
  const GOLDEN_METADATA_HASH = "0xbec1c34ae775c4e85a9d48774328d093061dadc4422fffb483384410e74e658e";

  let testWallet;
  let otherWallet;
  const testUid = "usr_farmer_001";
  const otherUid = "usr_farmer_002";
  const unlinkedUid = "usr_farmer_unlinked";
  const configuredChainId = 31337;
  const configuredContractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  let dbState;
  let docVersions;
  let mockFirestore;
  let mockAuth;
  let mockContract;
  let mockProvider;
  let app;
  let broadcastSpyCalled;
  let broadcastCount;
  let lastBroadcastRawTx;
  let broadcastFailureError;
  let mempoolTxs;
  let mempoolReceipts;
  let mockBlocks;
  let mockBlockNumber;
  let mockLatestMinedNonce;
  let mockRpcPendingNonce;
  let failFirestorePostBroadcast;

  beforeEach(() => {
    testWallet = ethers.Wallet.createRandom();
    otherWallet = ethers.Wallet.createRandom();
    broadcastSpyCalled = false;
    broadcastCount = 0;
    lastBroadcastRawTx = null;
    broadcastFailureError = null;
    mempoolTxs = {};
    mempoolReceipts = {};
    mockBlocks = {};
    mockBlockNumber = 110;
    mockLatestMinedNonce = undefined;
    mockRpcPendingNonce = undefined;
    failFirestorePostBroadcast = false;

    dbState = {
      users: {
        [testUid]: {
          uid: testUid,
          email: "farmer@agritrace.org",
          role: "FARMER",
          walletAddress: testWallet.address,
          isActive: true,
        },
        [otherUid]: {
          uid: otherUid,
          email: "otherfarmer@agritrace.org",
          role: "FARMER",
          walletAddress: otherWallet.address,
          isActive: true,
        },
        [unlinkedUid]: {
          uid: unlinkedUid,
          email: "unlinked@agritrace.org",
          role: "FARMER",
          walletAddress: null,
          isActive: true,
        },
      },
      walletNonceTrackers: {},
      nonceReservations: {},
      idempotencyKeys: {},
      batches: {},
      processedTransactions: {},
    };

    docVersions = {};

    function makeDocRef(colName, docId) {
      return {
        _col: colName,
        _id: docId,
        get: async () => {
          const data = dbState[colName]?.[docId];
          return {
            exists: Boolean(data),
            data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          };
        },
        set: async (docData, options = {}) => {
          if (failFirestorePostBroadcast && colName === "batches") {
            throw new Error("Simulated Firestore outage on batches.set");
          }
          if (!dbState[colName]) dbState[colName] = {};
          if (options.merge && dbState[colName][docId]) {
            dbState[colName][docId] = { ...dbState[colName][docId], ...docData };
          } else {
            dbState[colName][docId] = { ...docData };
          }
          docVersions[`${colName}/${docId}`] = (docVersions[`${colName}/${docId}`] || 0) + 1;
        },
        update: async (updates) => {
          if (failFirestorePostBroadcast && updates.status === TRANSACTION_STATUS.PENDING_BLOCKCHAIN) {
            throw new Error("Simulated Firestore outage on reservation.update");
          }
          if (!dbState[colName]?.[docId]) {
            throw new Error(`Document ${colName}/${docId} not found`);
          }
          dbState[colName][docId] = { ...dbState[colName][docId], ...updates };
          docVersions[`${colName}/${docId}`] = (docVersions[`${colName}/${docId}`] || 0) + 1;
        },
      };
    }

    mockFirestore = {
      collection: (colName) => ({
        doc: (docId) => makeDocRef(colName, docId),
      }),
      runTransaction: async (updateFunction) => {
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
          attempts++;
          const readVersions = {};
          const stagedWrites = [];
          const transactionContext = {
            get: async (docRef) => {
              const key = `${docRef._col}/${docRef._id}`;
              const docData = dbState[docRef._col]?.[docRef._id];
              readVersions[key] = docVersions[key] || 0;
              return {
                exists: Boolean(docData),
                data: () => (docData ? JSON.parse(JSON.stringify(docData)) : undefined),
              };
            },
            set: (docRef, data, options = {}) => {
              stagedWrites.push({ type: "set", col: docRef._col, id: docRef._id, data, options });
            },
            update: (docRef, data) => {
              stagedWrites.push({ type: "update", col: docRef._col, id: docRef._id, data });
            },
          };

          const result = await updateFunction(transactionContext);

          // Concurrency OCC validation
          let conflictDetected = false;
          for (const [key, readVersion] of Object.entries(readVersions)) {
            if ((docVersions[key] || 0) !== readVersion) {
              conflictDetected = true;
              break;
            }
          }

          if (conflictDetected) {
            continue; // Retry
          }

          for (const write of stagedWrites) {
            if (write.type === "set") {
              if (!dbState[write.col]) dbState[write.col] = {};
              if (write.options?.merge && dbState[write.col][write.id]) {
                dbState[write.col][write.id] = { ...dbState[write.col][write.id], ...write.data };
              } else {
                dbState[write.col][write.id] = { ...write.data };
              }
              docVersions[`${write.col}/${write.id}`] = (docVersions[`${write.col}/${write.id}`] || 0) + 1;
            } else if (write.type === "update") {
              if (!dbState[write.col]?.[write.id]) {
                throw new Error(`Document ${write.col}/${write.id} not found`);
              }
              dbState[write.col][write.id] = { ...dbState[write.col][write.id], ...write.data };
              docVersions[`${write.col}/${write.id}`] = (docVersions[`${write.col}/${write.id}`] || 0) + 1;
            }
          }

          return result;
        }
        throw new Error("Transaction failed after maximum OCC retries");
      },
    };

    mockAuth = {
      verifyIdToken: async (token) => {
        if (token === "token_farmer_valid") {
          return { uid: testUid, email: "farmer@agritrace.org" };
        }
        if (token === "token_other_farmer") {
          return { uid: otherUid, email: "otherfarmer@agritrace.org" };
        }
        if (token === "token_unlinked_wallet") {
          return { uid: unlinkedUid, email: "unlinked@agritrace.org" };
        }
        const err = new Error("Invalid or expired Firebase ID token");
        err.code = "auth/invalid-id-token";
        throw err;
      },
    };

    const iface = new ethers.Interface(contractArtifact.abi);

    mockContract = {
      interface: iface,
      hasRole: async (role, address) => {
        return (
          role === CONTRACT_ROLES[ROLES.FARMER] &&
          address.toLowerCase() === testWallet.address.toLowerCase()
        );
      },
      createBatch: {
        staticCall: async () => true,
        estimateGas: async () => 105000n,
      },
    };

    mockProvider = {
      getTransactionCount: async (address, tag) => {
        if (tag === "latest" && mockLatestMinedNonce !== undefined) {
          return mockLatestMinedNonce;
        }
        if (tag === "pending" && mockRpcPendingNonce !== undefined) {
          return mockRpcPendingNonce;
        }
        return 0;
      },
      getBlockNumber: async () => (mockBlockNumber !== undefined ? mockBlockNumber : 110),
      getBlock: async (blockTag, prefetch) => {
        if (blockTag === "finalized") {
          if (mockBlocks.hasOwnProperty("finalized")) {
            if (typeof mockBlocks["finalized"] === "function") {
              return mockBlocks["finalized"]();
            }
            return mockBlocks["finalized"];
          }
          throw new Error("Method eth_getBlockByNumber with tag 'finalized' not supported on this network");
        }
        if (mockBlocks.hasOwnProperty(blockTag)) {
          return mockBlocks[blockTag];
        }
        return {
          number: typeof blockTag === "number" ? blockTag : 100,
          hash: "0x" + "a".repeat(64),
          transactions: [],
          prefetchedTransactions: [],
        };
      },
      broadcastTransaction: async (rawTx) => {
        broadcastSpyCalled = true;
        broadcastCount++;
        lastBroadcastRawTx = rawTx;
        if (broadcastFailureError) {
          throw broadcastFailureError;
        }
        const parsed = ethers.Transaction.from(rawTx);
        mempoolTxs[parsed.hash.toLowerCase()] = parsed;
        return { hash: parsed.hash };
      },
      getTransaction: async (hash) => {
        return mempoolTxs[hash.toLowerCase()] || null;
      },
      getTransactionReceipt: async (hash) => {
        return mempoolReceipts[hash.toLowerCase()] || null;
      },
      sendTransaction: async () => {
        throw new Error("UNEXPECTED: Backend must NEVER call sendTransaction!");
      },
    };

    const authMiddleware = createAuthMiddleware({ auth: mockAuth, firestore: mockFirestore });
    const batchService = {
      prepareBatchCreation: (params) =>
        prepareBatchCreation({
          ...params,
          contract: mockContract,
          provider: mockProvider,
          firestore: mockFirestore,
          chainId: configuredChainId,
          contractAddress: configuredContractAddress,
        }),
      submitBatchCreation: (params) =>
        submitBatchCreation({
          ...params,
          contract: mockContract,
          provider: mockProvider,
          firestore: mockFirestore,
          chainId: configuredChainId,
          contractAddress: configuredContractAddress,
        }),
    };

    const batchController = createBatchController({ batchService });
    const batchRouter = createBatchRouter({
      authenticate: authMiddleware,
      controller: batchController,
    });

    app = express();
    app.use(express.json());
    app.use("/api/v1/batches", batchRouter);
    app.use(errorHandler);
  });

  async function prepareValidBatch(customMetadata = GOLDEN_INPUT) {
    const res = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: customMetadata });
    expect(res.status).to.equal(200);
    return res.body.data;
  }

  async function signBatchTx(wallet, unsignedData, overrides = {}) {
    const txData = {
      to: overrides.to !== undefined ? overrides.to : unsignedData.to,
      data: overrides.data !== undefined ? overrides.data : unsignedData.data,
      nonce: overrides.nonce !== undefined ? overrides.nonce : unsignedData.nonce,
      chainId: overrides.chainId !== undefined ? overrides.chainId : unsignedData.chainId,
      gasLimit: overrides.gasLimit !== undefined ? overrides.gasLimit : (unsignedData.gasLimit || 120000n),
      maxFeePerGas: overrides.maxFeePerGas !== undefined ? overrides.maxFeePerGas : ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas !== undefined ? overrides.maxPriorityFeePerGas : ethers.parseUnits("1.5", "gwei"),
      type: overrides.type !== undefined ? overrides.type : 2,
      value: overrides.value !== undefined ? overrides.value : 0n,
    };
    return await wallet.signTransaction(txData);
  }

  // ==============================================================================
  // 1. Successful Signed Batch Submission
  // ==============================================================================
  it("1. Successfully submits signed transaction and broadcasts to mempool, returning 202 PENDING_BLOCKCHAIN", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.success).to.be.true;
    expect(res.body.data).to.deep.include({
      humanBatchId: "BATCH-2026-TOMATO-001",
      batchId: GOLDEN_BATCH_ID,
      txHash: expectedTxHash,
      reservationId: prep.reservationId,
      status: "PENDING_BLOCKCHAIN",
    });

    // Firestore state assertions
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal("PENDING_BLOCKCHAIN");
    expect(resDoc.txHash).to.equal(expectedTxHash);
    expect(resDoc.signedTxHex).to.equal(signedTxHex);
    expect(resDoc.broadcastAt).to.be.a("string");

    const batchDoc = dbState.batches["BATCH-2026-TOMATO-001"];
    expect(batchDoc.status).to.equal("PENDING_BLOCKCHAIN");
    expect(batchDoc.currentCustodian.toLowerCase()).to.equal(testWallet.address.toLowerCase());
    expect(batchDoc.farmer.toLowerCase()).to.equal(testWallet.address.toLowerCase());
    expect(batchDoc.latestTxHash).to.equal(expectedTxHash);

    const procTxDoc = dbState.processedTransactions[`${configuredChainId}_${expectedTxHash}`];
    expect(procTxDoc.applied).to.be.false;
    expect(procTxDoc.superseded).to.be.false;
    expect(procTxDoc.canonicalBlockVerified).to.be.false;
    expect(procTxDoc.nonce).to.equal(prep.nonce);
    expect(procTxDoc.targetFunction).to.equal("createBatch");

    expect(broadcastCount).to.equal(1);
    expect(lastBroadcastRawTx).to.equal(signedTxHex);
  });

  // ==============================================================================
  // 2. Missing Authentication
  // ==============================================================================
  it("2. Rejects request missing Authorization header with 401 AUTH_HEADER_MISSING", async () => {
    const res = await request(app)
      .post("/api/v1/batches")
      .send({ signedTxHex: "0x123", reservationId: "res_123" });

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_HEADER_MISSING");
  });

  // ==============================================================================
  // 3. Missing Reservation
  // ==============================================================================
  it("3. Rejects request with non-existent reservationId with 404 RESERVATION_NOT_FOUND", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: "res_non_existent_9999" });

    expect(res.status).to.equal(404);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("RESERVATION_NOT_FOUND");
  });

  // ==============================================================================
  // 4. Reservation Belonging to Another User
  // ==============================================================================
  it("4. Rejects submission when reservation belongs to another user with 403 RESERVATION_OWNERSHIP_MISMATCH", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    // Tamper reservation UID to another user
    dbState.nonceReservations[prep.reservationId].uid = otherUid;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("RESERVATION_OWNERSHIP_MISMATCH");
  });

  // ==============================================================================
  // 5. Wallet Mismatch
  // ==============================================================================
  it("5. Rejects submission when reservation wallet does not match user linked wallet with 403 WALLET_MISMATCH", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    // Tamper reservation wallet address
    dbState.nonceReservations[prep.reservationId].walletAddress = otherWallet.address.toLowerCase();

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("WALLET_MISMATCH");
  });

  // ==============================================================================
  // 6. Invalid Raw Transaction
  // ==============================================================================
  it("6. Rejects malformed signedTxHex string with 400 INVALID_RAW_TRANSACTION", async () => {
    const prep = await prepareValidBatch();

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: "0xdeadbeefnotavalidtransaction", reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INVALID_RAW_TRANSACTION");
  });

  // ==============================================================================
  // 7. Invalid Signature / Unsigned Transaction
  // ==============================================================================
  it("7. Rejects unsigned or improperly signed raw transaction with 400 INVALID_TRANSACTION_SIGNATURE", async () => {
    const prep = await prepareValidBatch();

    const tx = ethers.Transaction.from({
      to: prep.to,
      data: prep.data,
      nonce: prep.nonce,
      chainId: prep.chainId,
      gasLimit: 120000n,
      maxFeePerGas: ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1.5", "gwei"),
      type: 2,
    });
    const unsignedRawHex = tx.unsignedSerialized;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: unsignedRawHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INVALID_TRANSACTION_SIGNATURE");
  });

  // ==============================================================================
  // 8. Incorrect Recovered Sender
  // ==============================================================================
  it("8. Rejects transaction when recovered signer does not match authenticated user with 403 INCORRECT_RECOVERED_SENDER", async () => {
    const prep = await prepareValidBatch();
    // Signed by otherWallet instead of testWallet
    const signedTxHex = await signBatchTx(otherWallet, prep);

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INCORRECT_RECOVERED_SENDER");
  });

  // ==============================================================================
  // 9. Incorrect Chain ID
  // ==============================================================================
  it("9. Rejects transaction signed for a mismatched chain ID with 400 CHAIN_ID_MISMATCH", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep, { chainId: 1 }); // Mainnet chain ID

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("CHAIN_ID_MISMATCH");
  });

  // ==============================================================================
  // 10. Incorrect Contract Destination
  // ==============================================================================
  it("10. Rejects transaction destined for an unapproved contract address with 400 INVALID_CONTRACT_DESTINATION", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep, { to: otherWallet.address });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INVALID_CONTRACT_DESTINATION");
  });

  // ==============================================================================
  // 11. Non-Zero Transaction Value
  // ==============================================================================
  it("11. Rejects transaction containing non-zero native Ether value with 400 NON_ZERO_TRANSACTION_VALUE", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep, { value: ethers.parseEther("0.1") });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("NON_ZERO_TRANSACTION_VALUE");
  });

  // ==============================================================================
  // 12. Incorrect Nonce
  // ==============================================================================
  it("12. Rejects transaction signed with a nonce different from the reserved nonce with 400 NONCE_MISMATCH", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep, { nonce: 42 });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("NONCE_MISMATCH");
  });

  // ==============================================================================
  // 13. Altered Calldata
  // ==============================================================================
  it("13. Rejects transaction whose calldata hash does not match the prepared reservation with 400 ALTERED_CALLDATA", async () => {
    const prep = await prepareValidBatch();
    const alteredData = prep.data.slice(0, -8) + "12345678";
    const signedTxHex = await signBatchTx(testWallet, prep, { data: alteredData });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("ALTERED_CALLDATA");
  });

  // ==============================================================================
  // 14. Incorrect Target Function Selector
  // ==============================================================================
  it("14. Rejects transaction calling an unapproved smart contract function with 400 TARGET_FUNCTION_MISMATCH", async () => {
    const prep = await prepareValidBatch();
    const iface = new ethers.Interface(contractArtifact.abi);
    const differentFuncData = iface.encodeFunctionData("verifyQuality", [
      GOLDEN_BATCH_ID,
      true,
      GOLDEN_METADATA_HASH,
    ]);

    dbState.nonceReservations[prep.reservationId].callDataHash = null;

    const signedTxHex = await signBatchTx(testWallet, prep, { data: differentFuncData });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("TARGET_FUNCTION_MISMATCH");
  });

  // ==============================================================================
  // 15. Incorrect Transaction Arguments
  // ==============================================================================
  it("15. Rejects transaction whose decoded arguments do not match expected reservation args with 400 ARGUMENT_MISMATCH", async () => {
    const prep = await prepareValidBatch();

    dbState.nonceReservations[prep.reservationId].expectedArgs.batchId =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    dbState.nonceReservations[prep.reservationId].callDataHash = null;

    const signedTxHex = await signBatchTx(testWallet, prep);

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("ARGUMENT_MISMATCH");
  });

  // ==============================================================================
  // 16. Expired or Unresolved Reservation
  // ==============================================================================
  it("16. Rejects submission when reservation is EXPIRED or in an unresolved state with 409", async () => {
    // 16a: EXPIRED
    const prep1 = await prepareValidBatch({ ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-EXPIRED-001" });
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.EXPIRED;
    const signed1 = await signBatchTx(testWallet, prep1);

    const res1 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signed1, reservationId: prep1.reservationId });

    expect(res1.status).to.equal(409);
    expect(res1.body.error.code).to.equal("RESERVATION_EXPIRED");

    // 16b: RECONCILIATION_REQUIRED
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.RECONCILIATION_REQUIRED;
    const res2 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signed1, reservationId: prep1.reservationId });

    expect(res2.status).to.equal(409);
    expect(res2.body.error.code).to.equal("INVALID_RESERVATION_STATUS");

    // 16c: CANCELLATION_PENDING
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.CANCELLATION_PENDING;
    const res3 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signed1, reservationId: prep1.reservationId });

    expect(res3.status).to.equal(409);
    expect(res3.body.error.code).to.equal("INVALID_RESERVATION_STATUS");
  });

  // ==============================================================================
  // 17. Duplicate Submission (Idempotent vs Conflict)
  // ==============================================================================
  it("17. Handles duplicate submission idempotently for identical tx, and rejects different tx with 409 RESERVATION_ALREADY_SUBMITTED", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex1 = await signBatchTx(testWallet, prep);
    const parsed1 = ethers.Transaction.from(signedTxHex1);

    // Initial submission
    const res1 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signedTxHex1, reservationId: prep.reservationId });

    expect(res1.status).to.equal(202);
    expect(broadcastCount).to.equal(1);

    // Idempotent retry with exact same signedTxHex
    const res2 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signedTxHex1, reservationId: prep.reservationId });

    expect(res2.status).to.equal(202);
    expect(res2.body.data.alreadySubmitted).to.be.true;
    expect(res2.body.data.txHash).to.equal(parsed1.hash.toLowerCase());
    // Broadcast must not have been executed a second time
    expect(broadcastCount).to.equal(1);

    // Submitting a different transaction hash to the same reservation
    const signedTxHex2 = await signBatchTx(testWallet, prep, {
      maxFeePerGas: ethers.parseUnits("30", "gwei"),
    });

    const res3 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signedTxHex2, reservationId: prep.reservationId });

    expect(res3.status).to.equal(409);
    expect(res3.body.error.code).to.equal("RESERVATION_ALREADY_SUBMITTED");
  });

  // ==============================================================================
  // 18. Idempotency Key Conflict
  // ==============================================================================
  it("18. Rejects submission with an Idempotency-Key already used for a different transaction hash with 409 IDEMPOTENCY_CONFLICT", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    const idempKey = "client-idemp-12345";
    const idempDocId = `${testWallet.address.toLowerCase()}_${idempKey}`;
    dbState.idempotencyKeys[idempDocId] = {
      txHash: "0x" + "a".repeat(64),
      reservationId: "res_other",
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .set("Idempotency-Key", idempKey)
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("IDEMPOTENCY_CONFLICT");
  });

  // ==============================================================================
  // 19. Insufficient Funds Error
  // ==============================================================================
  it("19. Maps RPC insufficient funds error to 400 INSUFFICIENT_FUNDS and marks reservation FAILED_AT_BROADCAST", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("insufficient funds for gas * price + value: balance 100, tx cost 1000");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(400);
    expect(res.body.error.code).to.equal("INSUFFICIENT_FUNDS");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.broadcastError).to.include("insufficient funds");
  });

  // ==============================================================================
  // 20. Nonce Too Low Error
  // ==============================================================================
  it("20. Maps RPC nonce-too-low error to 409 NONCE_TOO_LOW and marks reservation FAILED_AT_BROADCAST", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("nonce too low: next nonce 5, tx nonce 0");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.broadcastError).to.include("nonce too low");
  });

  // ==============================================================================
  // 21. Already-Known Transaction Handling
  // ==============================================================================
  it("21. Handles RPC 'already known' mempool error gracefully by returning 202 PENDING_BLOCKCHAIN", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("already known: transaction is already in mempool");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
  });

  // ==============================================================================
  // 22. RPC Network Timeout Handling
  // ==============================================================================
  it("22. Handles RPC network timeout by querying mempool, marking RECONCILIATION_REQUIRED if absent, and preserving wallet lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("network timeout: request timed out after 30000ms");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("RECONCILIATION_REQUIRED");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("BROADCAST_TIMEOUT");

    // Wallet remains locked: cannot prepare a new batch while in RECONCILIATION_REQUIRED
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-LOCKTEST" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // 23. RPC Unavailable Handling
  // ==============================================================================
  it("23. Returns 503 BLOCKCHAIN_RPC_UNAVAILABLE when blockchain RPC node is unreachable during broadcast", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("connect ECONNREFUSED 127.0.0.1:8545");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(503);
    expect(res.body.error.code).to.equal("BLOCKCHAIN_RPC_UNAVAILABLE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("RPC_UNAVAILABLE");
  });

  // ==============================================================================
  // 24. Firestore Failure After Broadcast
  // ==============================================================================
  it("24. Never loses transaction hash if Firestore updates fail after successful broadcast, returning 202 with FIRESTORE_SYNC_PENDING warning", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Trigger Firestore write failure post-broadcast
    failFirestorePostBroadcast = true;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.txHash).to.equal(expectedTxHash);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.warning).to.equal("FIRESTORE_SYNC_PENDING");
  });

  // ==============================================================================
  // 25. Concurrent Submission Attempts
  // ==============================================================================
  it("25. Resolves concurrent submissions safely via OCC atomic lock, allowing exactly one broadcast and rejecting concurrent attempts with 409", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex1 = await signBatchTx(testWallet, prep, { maxFeePerGas: ethers.parseUnits("20", "gwei") });
    const signedTxHex2 = await signBatchTx(testWallet, prep, { maxFeePerGas: ethers.parseUnits("25", "gwei") });

    const [res1, res2] = await Promise.all([
      request(app)
        .post("/api/v1/batches")
        .set("Authorization", "Bearer token_farmer_valid")
        .send({ signedTxHex: signedTxHex1, reservationId: prep.reservationId }),
      request(app)
        .post("/api/v1/batches")
        .set("Authorization", "Bearer token_farmer_valid")
        .send({ signedTxHex: signedTxHex2, reservationId: prep.reservationId }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).to.deep.equal([202, 409]);

    const successfulRes = res1.status === 202 ? res1 : res2;
    const failedRes = res1.status === 409 ? res1 : res2;

    expect(successfulRes.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(failedRes.body.error.code).to.equal("RESERVATION_ALREADY_SUBMITTED");
    expect(broadcastCount).to.equal(1);
  });

  // ==============================================================================
  // 26. Verification Backend Never Signs Transactions
  // ==============================================================================
  it("26. Verifies that backend operates strictly non-custodially, possesses zero private keys, and broadcasts the participant's exact raw transaction byte-for-byte", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);

    // 1. Transaction broadcasted verbatim byte-for-byte
    expect(lastBroadcastRawTx).to.equal(signedTxHex);

    // 2. Response contains zero private keys or signatures created by backend
    expect(res.body.data.privateKey).to.be.undefined;
    expect(res.body.data.signature).to.be.undefined;
    expect(res.body.data.signedTxHex).to.be.undefined;

    // 3. Backend did not alter any field of the raw transaction
    const parsedBroadcast = ethers.Transaction.from(lastBroadcastRawTx);
    expect(parsedBroadcast.from.toLowerCase()).to.equal(testWallet.address.toLowerCase());
    expect(parsedBroadcast.nonce).to.equal(prep.nonce);
    expect(parsedBroadcast.data).to.equal(prep.data);
  });

  // ==============================================================================
  // 27. Nonce Gap Defense - INSUFFICIENT_FUNDS does not release wallet
  // ==============================================================================
  it("27. Failed broadcast for INSUFFICIENT_FUNDS marks nonceConsumed: false and prevents allocating a higher nonce", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("insufficient funds for gas * price + value");

    const submitRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(submitRes.status).to.equal(400);
    expect(submitRes.body.error.code).to.equal("INSUFFICIENT_FUNDS");

    // Reservation must be in FAILED_AT_BROADCAST with nonceConsumed: false
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.false;

    // Tracker highestReservedNonce is preserved (not decremented)
    const trackerDoc = dbState.walletNonceTrackers[testWallet.address.toLowerCase()];
    expect(trackerDoc.highestReservedNonce).to.equal(prep.nonce);
    expect(trackerDoc.activeReservationId).to.equal(prep.reservationId);

    // Attempting to prepare a new batch must be BLOCKED with 409 ACTIVE_RESERVATION_EXISTS
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-GAPTEST" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // 28. Resubmission after Funding Wallet from FAILED_AT_BROADCAST
  // ==============================================================================
  it("28. Resubmitting transaction after wallet is funded resolves FAILED_AT_BROADCAST and broadcasts to mempool", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    // First attempt fails with insufficient funds
    broadcastFailureError = new Error("insufficient funds for gas * price + value");
    const failRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(failRes.status).to.equal(400);

    // User funds their wallet; retry submission succeeds
    broadcastFailureError = null;
    const retryRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(retryRes.status).to.equal(202);
    expect(retryRes.body.data.status).to.equal("PENDING_BLOCKCHAIN");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
  });

  // ==============================================================================
  // 29. Nonce Gap Defense - NONCE_TOO_LOW independent verification (unconsumed)
  // ==============================================================================
  it("29. NONCE_TOO_LOW rejection when latest mined nonce <= reserved nonce preserves lock and marks nonceConsumed: false", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("nonce too low: next nonce 0, tx nonce 0");
    mockLatestMinedNonce = 0; // Same nonce, NOT consumed on-chain!

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.false;

    // Trying to reserve a new nonce must be blocked because nonce was not proven consumed
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-UNCONFIRMED" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // 30. Nonce Gap Defense - NONCE_TOO_LOW independent verification (consumed on-chain)
  // ==============================================================================
  it("30. NONCE_TOO_LOW rejection when latest mined nonce > reserved nonce marks nonceConsumed: true and allows sequential allocation", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("nonce too low: next nonce 5, tx nonce 0");
    mockLatestMinedNonce = 1; // 1 > 0: Nonce 0 has genuinely been mined on-chain!

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.true;

    // Now preparing a new transaction is permitted because nonce 0 was genuinely consumed on-chain
    mockRpcPendingNonce = 1;
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-CONSUMED" } });

    expect(prep2.status).to.equal(200);
    expect(prep2.body.data.nonce).to.equal(1);
  });

  // ==============================================================================
  // 31. Crash immediately after Firestore lock (SUBMITTED, broadcastAccepted: false)
  // ==============================================================================
  it("31. Persists exact signed raw transaction and txHash in SUBMITTED state before RPC broadcast", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Cause a crash by simulating provider.broadcastTransaction throwing an uncaught fatal error or simulated interrupt
    let broadcastInvoked = false;
    mockProvider.broadcastTransaction = async () => {
      broadcastInvoked = true;
      throw new Error("SIMULATED_PROCESS_CRASH_BEFORE_BROADCAST_COMPLETION");
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(broadcastInvoked).to.be.true;
    // Reservation must have persisted exact signedTxHex and txHash
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.txHash).to.equal(expectedTxHash);
    expect(resDoc.signedTxHex).to.equal(signedTxHex);
  });

  // ==============================================================================
  // 32. Retry after crash before broadcast (tx missing from RPC)
  // ==============================================================================
  it("32. Retrying after crash before broadcast detects tx missing from RPC, rebroadcasts exact raw tx, and converges to PENDING_BLOCKCHAIN", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Simulate crash state: reservation is SUBMITTED, but broadcast was never completed
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;
    dbState.nonceReservations[prep.reservationId].submissionClaimedAt = new Date().toISOString();

    // RPC has no record
    expect(mempoolTxs[expectedTxHash]).to.be.undefined;

    // Client retries POST /api/v1/batches
    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.txHash).to.equal(expectedTxHash);
    expect(broadcastCount).to.equal(1);
    expect(lastBroadcastRawTx).to.equal(signedTxHex);

    // Reservation state is updated to PENDING_BLOCKCHAIN
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
    expect(resDoc.broadcastAccepted).to.be.true;
  });

  // ==============================================================================
  // 33. Retry after successful broadcast (tx already present in mempool)
  // ==============================================================================
  it("33. Retrying after crash when tx is already in mempool converges to PENDING_BLOCKCHAIN without rebroadcasting", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Simulate crash state: reservation is SUBMITTED, but RPC mempool ALREADY received the tx
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Mempool contains the tx
    mempoolTxs[expectedTxHash] = parsed;

    // Retry submission
    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.alreadySubmitted).to.be.true;

    // Must NOT have called broadcastTransaction again
    expect(broadcastCount).to.equal(0);

    // Firestore records are properly synchronized
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
    expect(resDoc.broadcastAccepted).to.be.true;
    expect(dbState.batches["BATCH-2026-TOMATO-001"].status).to.equal("PENDING_BLOCKCHAIN");
  });

  // ==============================================================================
  // 34. Retry after successful broadcast (tx already mined on-chain with receipt)
  // ==============================================================================
  it("34. Retrying when tx is already mined on-chain converges to PENDING_BLOCKCHAIN without rebroadcasting", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Simulate reservation in SUBMITTED
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;

    // Mined receipt exists on RPC with matching canonical block
    mempoolReceipts[expectedTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "a".repeat(64),
      transactionHash: expectedTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.alreadySubmitted).to.be.true;
    expect(broadcastCount).to.equal(0);
  });

  // ==============================================================================
  // 35. Ambiguous RPC timeout during recovery rebroadcast
  // ==============================================================================
  it("35. Ambiguous RPC timeout during recovery rebroadcast marks RECONCILIATION_REQUIRED and keeps wallet locked", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Reservation in SUBMITTED
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;

    // Rebroadcast will timeout
    broadcastFailureError = new Error("network timeout: request timed out");

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("RECONCILIATION_REQUIRED");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);

    // New /prepare must be blocked because reservation is in RECONCILIATION_REQUIRED
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-RECONLOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // 36. Concurrent recovery attempts allow exactly one broadcast
  // ==============================================================================
  it("36. Concurrent recovery attempts resolve safely with exactly one broadcast execution", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Reservation in SUBMITTED
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;

    const [res1, res2] = await Promise.all([
      request(app)
        .post("/api/v1/batches")
        .set("Authorization", "Bearer token_farmer_valid")
        .send({ signedTxHex, reservationId: prep.reservationId }),
      request(app)
        .post("/api/v1/batches")
        .set("Authorization", "Bearer token_farmer_valid")
        .send({ signedTxHex, reservationId: prep.reservationId }),
    ]);

    expect(res1.status).to.equal(202);
    expect(res2.status).to.equal(202);
    expect(broadcastCount).to.equal(1); // Exactly one broadcast executed!
  });

  // ==============================================================================
  // 37. Recovery strictly rejects tampered signed transaction or altered nonce
  // ==============================================================================
  it("37. Recovery strictly rejects tampered transaction hash with 409 RESERVATION_ALREADY_SUBMITTED", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex1 = await signBatchTx(testWallet, prep);
    const parsed1 = ethers.Transaction.from(signedTxHex1);

    // Reservation claimed for signedTxHex1
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = parsed1.hash.toLowerCase();
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex1;

    // Client attempts recovery with a DIFFERENT transaction (e.g. different gas fee)
    const signedTxHex2 = await signBatchTx(testWallet, prep, {
      maxFeePerGas: ethers.parseUnits("35", "gwei"),
    });

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex: signedTxHex2, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RESERVATION_ALREADY_SUBMITTED");
  });

  // ==============================================================================
  // ISSUE 1: SUBMITTED / broadcastAccepted=false Nonce Gap Defenses
  // ==============================================================================

  // 38. Reservation N is SUBMITTED with broadcastAccepted=false; preparation of N+1 returns 409
  it("38. Blocks preparation of nonce N+1 with 409 ACTIVE_RESERVATION_EXISTS while reservation N is SUBMITTED with broadcastAccepted=false", async () => {
    const prep1 = await prepareValidBatch();

    // Move reservation to SUBMITTED but with broadcastAccepted = false
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep1.reservationId].broadcastAccepted = false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-NEXT" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 39. Reservation N becomes broadcastAccepted=true; preparation of N+1 can proceed
  it("39. Permits preparation of nonce N+1 sequentially once reservation N transitions to broadcastAccepted=true", async () => {
    const prep1 = await prepareValidBatch();

    // Reservation N was accepted by mempool
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep1.reservationId].broadcastAccepted = true;

    // Next prepare request succeeds with sequential nonce N+1
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-NEXT" } });

    expect(prep2.status).to.equal(200);
    expect(prep2.body.data.nonce).to.equal(prep1.nonce + 1);
  });

  // 40. Backend crashes after persisting SUBMITTED but before RPC broadcast; N+1 remains blocked
  it("40. Keeps nonce N+1 strictly blocked after simulated process crash between SUBMITTED state lock and RPC broadcast", async () => {
    const prep1 = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep1);
    const parsed = ethers.Transaction.from(signedTxHex);
    const expectedTxHash = parsed.hash.toLowerCase();

    // Simulate crash state: backend persisted SUBMITTED with broadcastAccepted=false, but died before broadcast
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep1.reservationId].txHash = expectedTxHash;
    dbState.nonceReservations[prep1.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep1.reservationId].broadcastAccepted = false;

    // Reservation is persisted in SUBMITTED state with broadcastAccepted=false
    const resDoc = dbState.nonceReservations[prep1.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.SUBMITTED);
    expect(resDoc.broadcastAccepted).to.be.false;

    // Preparing N+1 must be rejected with 409 to prevent nonce gap
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-NEXT-GAP" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 41. Recovery finds N in the mempool; state converges and N+1 becomes eligible
  it("41. Recovery finds transaction N in mempool, converges state to PENDING_BLOCKCHAIN with broadcastAccepted=true, and unlocks sequential allocation of N+1", async () => {
    const prep1 = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep1);
    const parsed = ethers.Transaction.from(signedTxHex);
    const txHash = parsed.hash.toLowerCase();

    // Set crash state: SUBMITTED, broadcastAccepted: false
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep1.reservationId].txHash = txHash;
    dbState.nonceReservations[prep1.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep1.reservationId].broadcastAccepted = false;

    // Transaction is present in the node mempool
    mempoolTxs[txHash] = parsed;

    // Recovery request converges state
    const recoverRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep1.reservationId });

    expect(recoverRes.status).to.equal(202);
    expect(recoverRes.body.data.status).to.equal("PENDING_BLOCKCHAIN");

    const resDoc = dbState.nonceReservations[prep1.reservationId];
    expect(resDoc.broadcastAccepted).to.be.true;

    // Now preparing N+1 succeeds
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-NEXT-ELIGIBLE" } });

    expect(prep2.status).to.equal(200);
    expect(prep2.body.data.nonce).to.equal(prep1.nonce + 1);
  });

  // 42. Recovery cannot find N and encounters an ambiguous RPC error; N+1 remains blocked
  it("42. Recovery encounters ambiguous RPC timeout when tx is missing, transitions to RECONCILIATION_REQUIRED, and keeps N+1 blocked", async () => {
    const prep1 = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep1);
    const parsed = ethers.Transaction.from(signedTxHex);
    const txHash = parsed.hash.toLowerCase();

    // Crash state: SUBMITTED, broadcastAccepted: false, tx NOT in mempool
    dbState.nonceReservations[prep1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep1.reservationId].txHash = txHash;
    dbState.nonceReservations[prep1.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep1.reservationId].broadcastAccepted = false;

    // Rebroadcast encounters ambiguous network timeout
    broadcastFailureError = new Error("network timeout: request timed out");

    const recoverRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep1.reservationId });

    expect(recoverRes.status).to.equal(202);
    expect(recoverRes.body.data.status).to.equal("RECONCILIATION_REQUIRED");

    // Preparing N+1 must remain blocked
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-TIMEOUT-BLOCKED" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // ==============================================================================
  // ISSUE 2: Clarify Externally Consumed Nonce Handling Defenses
  // ==============================================================================

  // 43. Another successful transaction consumes the reserved nonce (consuming tx status 1)
  it("43. NONCE_TOO_LOW identifies successful external consuming transaction (receipt status 1) and records consumingTxHash and receiptStatus", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const consumingTxHash = "0x" + "11".repeat(32);

    broadcastFailureError = new Error("nonce too low: next nonce 1, tx nonce 0");
    mockLatestMinedNonce = 1; // Nonce 0 consumed on-chain!

    // Populate recent block with the external transaction that consumed nonce 0
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "bb".repeat(32),
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1, // Successful external transaction
      blockNumber: 100,
      blockHash: "0x" + "bb".repeat(32),
      transactionHash: consumingTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.consumingTxHash).to.equal(consumingTxHash);
    expect(res.body.error.details.consumingReceiptStatus).to.equal(1);

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingTxHash).to.equal(consumingTxHash);
    expect(resDoc.consumingReceiptStatus).to.equal(1);
    expect(resDoc.resolutionReason).to.equal("NONCE_EXTERNALLY_CONSUMED");

    // Batch document is marked CREATION_FAILED
    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.failureReason).to.equal("NONCE_EXTERNALLY_CONSUMED");
    expect(batchDoc.consumingTxHash).to.equal(consumingTxHash);
  });

  // 44. Another reverted transaction consumes the reserved nonce (consuming tx status 0)
  it("44. NONCE_TOO_LOW identifies reverted external consuming transaction (receipt status 0) and marks nonce consumed while recording failure", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const consumingTxHash = "0x" + "22".repeat(32);

    broadcastFailureError = new Error("nonce too low: next nonce 1, tx nonce 0");
    mockLatestMinedNonce = 1;

    // Populate recent block with reverted external transaction
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "cc".repeat(32),
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 0, // Reverted external transaction
      blockNumber: 100,
      blockHash: "0x" + "cc".repeat(32),
      transactionHash: consumingTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.consumingTxHash).to.equal(consumingTxHash);
    expect(res.body.error.details.consumingReceiptStatus).to.equal(0);

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingReceiptStatus).to.equal(0);

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.failureReason).to.equal("NONCE_EXTERNALLY_CONSUMED");
  });

  // 45. The original intended transaction is not found on-chain
  it("45. NONCE_TOO_LOW marks externally consumed safely even when specific consuming tx is not discovered in recent block window", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("nonce too low: next nonce 1, tx nonce 0");
    mockLatestMinedNonce = 1;

    // No matching transaction found in recent blocks
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "dd".repeat(32),
      prefetchedTransactions: [],
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.consumingTxHash).to.be.null;

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingTxHash).to.be.null;
    expect(resDoc.resolutionReason).to.equal("NONCE_EXTERNALLY_CONSUMED");

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.failureReason).to.equal("NONCE_EXTERNALLY_CONSUMED");
  });

  // 46. The reservation is resolved without falsely marking the intended batch operation successful
  it("46. Does NOT create a successful batch or processedTransactions record when a nonce is consumed externally", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    broadcastFailureError = new Error("nonce too low: next nonce 1, tx nonce 0");
    mockLatestMinedNonce = 1;

    await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    // 1. Batch document must NOT be CREATED, PENDING_BLOCKCHAIN, or CONFIRMED
    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.status).to.not.equal("CREATED");
    expect(batchDoc.status).to.not.equal("PENDING_BLOCKCHAIN");
    expect(batchDoc.status).to.not.equal("CONFIRMED");

    // 2. processedTransactions MUST NOT contain an applied or verified entry for the intended transaction
    const procDoc = dbState.processedTransactions[`${configuredChainId}_${intendedTxHash}`];
    expect(procDoc).to.be.undefined;
  });

  // 47. Subsequent nonce allocation remains sequential and safe
  it("47. Preserves sequential safety for subsequent nonce allocations after external nonce consumption", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);

    broadcastFailureError = new Error("nonce too low: next nonce 1, tx nonce 0");
    mockLatestMinedNonce = 1;

    await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    // Nonce 0 is consumed externally; RPC now reports latest mined nonce = 1, pending nonce = 1
    mockLatestMinedNonce = 1;
    mockRpcPendingNonce = 1;

    // Subsequent batch preparation must succeed and allocate nonce 1 (no gaps!)
    const nextPrep = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-SEQUENTIAL" } });

    expect(nextPrep.status).to.equal(200);
    expect(nextPrep.body.data.nonce).to.equal(1);
    expect(nextPrep.body.data.nonce).to.be.greaterThan(prep.nonce);

    // Tracker highestReservedNonce is updated monotonically
    const tracker = dbState.walletNonceTrackers[testWallet.address.toLowerCase()];
    expect(tracker.highestReservedNonce).to.equal(1);
    expect(tracker.activeReservationId).to.equal(nextPrep.body.data.reservationId);
  });

  // ==============================================================================
  // ISSUE 3: External Nonce Consumption During Crash Recovery
  // ==============================================================================

  // 48. Crash before broadcast, followed by an unrelated successful transaction consuming the nonce
  it("48. Crash recovery detects unrelated successful transaction (receipt status 1) consuming nonce on-chain and marks CREATION_FAILED", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const unrelatedConsumingTxHash = "0x" + "aa".repeat(32);

    // Backend crashed before broadcast: reservation is SUBMITTED with broadcastAccepted=false
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Intended transaction is absent from RPC mempool and blockchain
    expect(mempoolTxs[intendedTxHash]).to.be.undefined;
    expect(mempoolReceipts[intendedTxHash]).to.be.undefined;

    // Nonce 0 was consumed on-chain by an unrelated transaction while backend was down
    mockLatestMinedNonce = 1;

    // Block scan finds the unrelated consuming transaction with receipt status 1
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "11".repeat(32),
      prefetchedTransactions: [
        {
          hash: unrelatedConsumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[unrelatedConsumingTxHash] = {
      status: 1, // Successful external transaction
      blockNumber: 100,
      blockHash: "0x" + "11".repeat(32),
      transactionHash: unrelatedConsumingTxHash,
    };

    // Client retries POST /api/v1/batches
    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.externallyConsumed).to.be.true;
    expect(res.body.error.details.consumingTxHash).to.equal(unrelatedConsumingTxHash);
    expect(res.body.error.details.consumingReceiptStatus).to.equal(1);

    // Reservation updated atomically with external consumption records
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingTxHash).to.equal(unrelatedConsumingTxHash);
    expect(resDoc.consumingReceiptStatus).to.equal(1);
    expect(resDoc.resolutionReason).to.equal("NONCE_EXTERNALLY_CONSUMED");

    // Batch is marked CREATION_FAILED, never successful
    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.failureReason).to.equal("NONCE_EXTERNALLY_CONSUMED");
    expect(batchDoc.intendedTxHash).to.equal(intendedTxHash);
    expect(batchDoc.consumingTxHash).to.equal(unrelatedConsumingTxHash);

    // processedTransactions MUST NOT contain the intended transaction
    const procDoc = dbState.processedTransactions[`${configuredChainId}_${intendedTxHash}`];
    expect(procDoc).to.be.undefined;
  });

  // 49. Crash before broadcast, followed by an unrelated reverted transaction consuming the nonce
  it("49. Crash recovery detects unrelated reverted transaction (receipt status 0) consuming nonce on-chain and marks CREATION_FAILED", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const unrelatedConsumingTxHash = "0x" + "bb".repeat(32);

    // Crash state
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Nonce was consumed on-chain
    mockLatestMinedNonce = 1;

    // Block scan finds reverted external transaction
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "22".repeat(32),
      prefetchedTransactions: [
        {
          hash: unrelatedConsumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[unrelatedConsumingTxHash] = {
      status: 0, // Reverted external transaction
      blockNumber: 100,
      blockHash: "0x" + "22".repeat(32),
      transactionHash: unrelatedConsumingTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.consumingReceiptStatus).to.equal(0);

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingReceiptStatus).to.equal(0);

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
  });

  // 50. External consuming transaction cannot be identified in the recent block window
  it("50. Crash recovery marks externally consumed safely when specific consuming tx is not in the recent block window", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    // Crash state
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Nonce 0 consumed on-chain
    mockLatestMinedNonce = 1;

    // Empty block scan
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "33".repeat(32),
      prefetchedTransactions: [],
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.consumingTxHash).to.be.null;

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.nonceConsumed).to.be.true;
    expect(resDoc.externallyConsumed).to.be.true;
    expect(resDoc.consumingTxHash).to.be.null;

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
  });

  // 51. Intended transaction is found in the mempool
  it("51. Crash recovery converges state to PENDING_BLOCKCHAIN when intended transaction is verified in mempool", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    // Crash state
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Intended transaction IS in mempool
    mempoolTxs[intendedTxHash] = parsed;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.txHash).to.equal(intendedTxHash);

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
    expect(resDoc.broadcastAccepted).to.be.true;

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("PENDING_BLOCKCHAIN");
    expect(batchDoc.latestTxHash).to.equal(intendedTxHash);

    const procDoc = dbState.processedTransactions[`${configuredChainId}_${intendedTxHash}`];
    expect(procDoc).to.exist;
    expect(procDoc.txHash).to.equal(intendedTxHash);
  });

  // 52. Intended transaction is found in a canonical mined block
  it("52. Crash recovery converges state to PENDING_BLOCKCHAIN when intended transaction is verified in a canonical mined block", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    // Crash state
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Intended transaction has mined receipt
    mempoolReceipts[intendedTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "a".repeat(64),
      transactionHash: intendedTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.alreadySubmitted).to.be.true;

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.broadcastAccepted).to.be.true;

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("PENDING_BLOCKCHAIN");
  });

  // 53. Recovery does not falsely mark the original batch as successful
  it("53. Crash recovery never marks original batch as successful when external consumption occurs", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("CREATION_FAILED");
    expect(batchDoc.status).to.not.equal("CREATED");
    expect(batchDoc.status).to.not.equal("CONFIRMED");
    expect(batchDoc.status).to.not.equal("PENDING_BLOCKCHAIN");

    expect(dbState.processedTransactions[`${configuredChainId}_${intendedTxHash}`]).to.be.undefined;
  });

  // 54. Subsequent nonce allocation remains sequential and safe
  it("54. Preserves sequential safety for subsequent nonce allocations after crash recovery resolves external consumption", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    // Crash recovery resolves external consumption
    await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    // Nonce tracker can now allocate nonce 1 sequentially
    mockRpcPendingNonce = 1;
    const nextPrep = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-RECOVERED-SEQ" } });

    expect(nextPrep.status).to.equal(200);
    expect(nextPrep.body.data.nonce).to.equal(1);
  });

  // 55. Recovery attempts do not create duplicate processedTransactions records
  it("55. Repeated recovery attempts do not create duplicate processedTransactions records", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mempoolTxs[intendedTxHash] = parsed;

    // First recovery attempt
    const res1 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });
    expect(res1.status).to.equal(202);

    // Second recovery attempt
    const res2 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });
    expect(res2.status).to.equal(202);

    // Third recovery attempt
    const res3 = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });
    expect(res3.status).to.equal(202);

    // Check processedTransactions: exactly ONE entry exists with docId ${chainId}_${intendedTxHash}
    const matchingDocs = Object.keys(dbState.processedTransactions).filter(
      (k) => k === `${configuredChainId}_${intendedTxHash}`
    );
    expect(matchingDocs.length).to.equal(1);
    expect(Object.keys(dbState.processedTransactions).length).to.equal(1);
  });

  // ==============================================================================
  // ISSUE 4: Receipt Verification, Canonical Continuity & Finality Defenses
  // ==============================================================================

  // 56. Intended transaction receipt with a matching canonical block hash
  it("56. Intended transaction receipt with matching canonical block hash converges to PENDING_BLOCKCHAIN with canonicalBlockVerified: true", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const canonicalHash = "0x" + "aa".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Canonical block at 100 has hash canonicalHash
    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      transactions: [],
      prefetchedTransactions: [],
    };
    mempoolReceipts[intendedTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash, // Matches!
      transactionHash: intendedTxHash,
    };
    mockBlockNumber = 110; // Deep confirmation (11 confirmations >= 5)

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(202);
    expect(res.body.data.status).to.equal("PENDING_BLOCKCHAIN");
    expect(res.body.data.alreadySubmitted).to.be.true;

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.PENDING_BLOCKCHAIN);
    expect(resDoc.broadcastAccepted).to.be.true;
    expect(resDoc.canonicalBlockVerified).to.be.true;

    const procDoc = dbState.processedTransactions[`${configuredChainId}_${intendedTxHash}`];
    expect(procDoc.canonicalBlockVerified).to.be.true;
  });

  // 57. Intended transaction receipt whose block hash differs from the canonical block
  it("57. Intended transaction receipt whose block hash differs from canonical block transitions to RECONCILIATION_REQUIRED and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Canonical block has hash 0x1111... but receipt has hash 0x2222... (orphaned block / reorg)
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "11".repeat(32),
      transactions: [],
      prefetchedTransactions: [],
    };
    mempoolReceipts[intendedTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "22".repeat(32), // Mismatched! Reorganised out!
      transactionHash: intendedTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("REORGANISATION_DETECTED");

    // Reservation moved to RECONCILIATION_REQUIRED, broadcastAccepted remains false
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("REORGANISATION_DETECTED");
    expect(resDoc.broadcastAccepted).to.be.false;

    // Attempting to prepare a new batch MUST be rejected because wallet is locked
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-REORGLOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 58. Canonical block unavailable during recovery
  it("58. Canonical block unavailable during recovery transitions to RECONCILIATION_REQUIRED and retains nonce lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Receipt exists but provider fails to fetch block 100 (null block)
    mockBlocks[100] = null;
    mempoolReceipts[intendedTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "aa".repeat(32),
      transactionHash: intendedTxHash,
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("CANONICAL_BLOCK_UNAVAILABLE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("CANONICAL_BLOCK_UNAVAILABLE");
    expect(resDoc.broadcastAccepted).to.be.false;

    // Preparing a new batch remains blocked
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-BLOCKUNAVAIL" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 59. External consuming transaction in a canonical but insufficiently confirmed block
  it("59. External consuming transaction in a canonical but insufficiently confirmed block retains lock and rejects with 409", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "55".repeat(32);
    const canonicalHash = "0x" + "55".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    // Nonce consumed on-chain
    mockLatestMinedNonce = 1;

    // Consuming tx mined in block 100 with matching canonical block
    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    // Shallow block height: block 100, currentBlock = 100 -> confirmationCount = 1 (< CONFIRMATION_BLOCKS = 2)
    mockBlockNumber = 100;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("INSUFFICIENT_CONFIRMATIONS");

    // Reservation updated to RECONCILIATION_REQUIRED, nonceConsumed remains FALSE
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("INSUFFICIENT_CONFIRMATIONS");
    expect(resDoc.nonceConsumed).to.be.false;

    // Preparing next nonce MUST be blocked with 409
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-SHALLOW-BLOCKED" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 60. External consuming transaction reaching the required confirmation/finality threshold
  it("60. External consuming transaction reaching required confirmation/finality threshold resolves reservation and unlocks sequential nonce", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "66".repeat(32);
    const canonicalHash = "0x" + "66".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    // Deep confirmation height: currentBlock = 110 -> 11 confirmations (satisfies FALLBACK_FINALITY_BLOCKS = 5)
    mockBlockNumber = 110;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(res.body.error.details.nonceConsumed).to.be.true;
    expect(res.body.error.details.externallyConsumed).to.be.true;
    expect(res.body.error.details.finalityMethod).to.equal("FALLBACK_DEPTH");

    // Reservation is now resolved with nonceConsumed = true
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.finalityMethod).to.equal("FALLBACK_DEPTH");
    expect(resDoc.nonceConsumed).to.be.true;

    // Sequential prepare succeeds with nonce 1
    mockRpcPendingNonce = 1;
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-FINALIZED-NEXT" } });

    expect(prep2.status).to.equal(200);
    expect(prep2.body.data.nonce).to.equal(1);
  });

  // 61. External consuming transaction being removed by a simulated reorganisation
  it("61. External consuming transaction being removed by simulated reorganisation marks RECONCILIATION_REQUIRED and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "77".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    // Canonical block has hash 0x7777... but consuming receipt has hash 0x8888... (reorg detected!)
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "77".repeat(32),
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "88".repeat(32), // Mismatched!
      transactionHash: consumingTxHash,
    };
    mockBlockNumber = 110;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("REORGANISATION_DETECTED");

    // Must be in RECONCILIATION_REQUIRED, nonceConsumed remains false
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("REORGANISATION_DETECTED");
    expect(resDoc.nonceConsumed).to.be.false;

    // Batch document is NOT falsely resolved
    const batchDoc = dbState.batches[prep.humanBatchId];
    expect(batchDoc.status).to.equal("RECONCILIATION_REQUIRED");
    expect(batchDoc.failureReason).to.equal("REORGANISATION_DETECTED");

    // Wallet remains locked
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-2026-TOMATO-REORG-BLOCKED" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 62. Wallet nonce remains locked whenever canonical consumption is not sufficiently established
  it("62. Wallet nonce remains strictly locked whenever canonical consumption is not sufficiently established", async () => {
    const prep = await prepareValidBatch();

    // Verify each unresolved state prevents new nonce allocation
    const testCases = [
      { status: TRANSACTION_STATUS.RECONCILIATION_REQUIRED, nonceConsumed: false, broadcastAccepted: false },
      { status: TRANSACTION_STATUS.SUBMITTED, nonceConsumed: false, broadcastAccepted: false },
      { status: TRANSACTION_STATUS.FAILED_AT_BROADCAST, nonceConsumed: false, broadcastAccepted: false },
      { status: TRANSACTION_STATUS.CANCELLATION_PENDING, nonceConsumed: false, broadcastAccepted: false },
      { status: TRANSACTION_STATUS.EXPIRED, nonceConsumed: false, broadcastAccepted: false },
    ];

    for (const tc of testCases) {
      dbState.nonceReservations[prep.reservationId] = {
        ...dbState.nonceReservations[prep.reservationId],
        ...tc,
      };

      const prepRes = await request(app)
        .post("/api/v1/batches/prepare")
        .set("Authorization", "Bearer token_farmer_valid")
        .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: `BATCH-LOCKTEST-${tc.status.replace(/_/g, "-")}` } });

      expect(prepRes.status).to.equal(409);
      expect(prepRes.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
    }
  });

  // 63. Temporary RPC timeout does not use fallback finality
  it("63. Temporary RPC timeout during finalized block query does NOT use fallback finality and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "81".repeat(32);
    const canonicalHash = "0x" + "81".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    // Deep confirmation height: currentBlock = 110 (11 confirmations >= 5 fallback)
    mockBlockNumber = 110;

    // But finalized query throws a network timeout!
    mockBlocks["finalized"] = () => {
      const err = new Error("Request timed out after 5000ms");
      err.code = "TIMEOUT";
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RPC_FINALITY_QUERY_FAILED");

    // Reservation updated to RECONCILIATION_REQUIRED, nonceConsumed remains false
    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    // Preparing next nonce MUST be blocked with 409
    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-TIMEOUT-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 64. RPC connection failure does not unlock a reservation
  it("64. RPC connection failure during finalized block query does NOT unlock reservation", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "82".repeat(32);
    const canonicalHash = "0x" + "82".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Finalized query throws ECONNREFUSED
    mockBlocks["finalized"] = () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:8545");
      err.code = "NETWORK_ERROR";
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RPC_FINALITY_QUERY_FAILED");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-CONNREFUSED-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 65. Invalid finalized-block response fails closed
  it("65. Invalid finalized-block response fails closed without unlocking reservation", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "83".repeat(32);
    const canonicalHash = "0x" + "83".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Invalid finalized block object (negative number)
    mockBlocks["finalized"] = { number: -1, hash: "0x123" };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("INVALID_FINALIZED_BLOCK_RESPONSE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-INVALIDRESP-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 66. Inconsistent future finalized-block response fails closed
  it("66. Inconsistent future finalized-block response fails closed without unlocking reservation", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "84".repeat(32);
    const canonicalHash = "0x" + "84".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Inconsistent future finalized block (number 999 > current 110)
    mockBlocks["finalized"] = { number: 999, hash: "0x123" };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("INCONSISTENT_FINALITY_RESPONSE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;
  });

  // 67. A transaction below required fallback confirmation depth remains unresolved
  it("67. A transaction below required fallback confirmation depth remains unresolved", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "85".repeat(32);
    const canonicalHash = "0x" + "85".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    // Mined at block 100, currentBlock = 103 -> depth = 4 (< FALLBACK_FINALITY_BLOCKS = 5)
    mockBlockNumber = 103;
    delete mockBlocks["finalized"]; // unsupported finalized tag

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("INSUFFICIENT_FALLBACK_CONFIRMATIONS");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("INSUFFICIENT_FALLBACK_CONFIRMATIONS");
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-INSUFF-FALLBACK-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 68. A transaction reaching the required fallback depth is accepted only when its block hash is canonical
  it("68. A transaction reaching the required fallback depth is accepted only when its block hash is canonical", async () => {
    // Sub-case A: Reaching fallback depth (depth 6 >= 5) but block hash mismatch (reorganised)
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "86".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    // Canonical block hash differs from receipt block hash
    mockBlocks[100] = {
      number: 100,
      hash: "0x" + "canonical100".repeat(5) + "0000",
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: "0x" + "orphaned100".repeat(5) + "0000",
      transactionHash: consumingTxHash,
    };

    // Deep depth: 105 - 100 + 1 = 6 confirmations (>= 5 fallback)
    mockBlockNumber = 105;
    delete mockBlocks["finalized"];

    const reorgRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(reorgRes.status).to.equal(409);
    expect(reorgRes.body.error.code).to.equal("REORGANISATION_DETECTED");

    // Sub-case B: Same transaction, but canonical block hash matches: accepted and resolved with finalityMethod FALLBACK_DEPTH
    mockBlocks[100].hash = mempoolReceipts[consumingTxHash].blockHash;
    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    const validRes = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(validRes.status).to.equal(409);
    expect(validRes.body.error.code).to.equal("NONCE_TOO_LOW");
    expect(validRes.body.error.details.finalityMethod).to.equal("FALLBACK_DEPTH");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.FAILED_AT_BROADCAST);
    expect(resDoc.finalityMethod).to.equal("FALLBACK_DEPTH");
    expect(resDoc.nonceConsumed).to.be.true;
  });

  // 69. Authentication failure does not activate fallback
  it("69. Authentication failure during finalized block query does NOT activate fallback and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "87".repeat(32);
    const canonicalHash = "0x" + "87".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Finalized query throws authentication failure
    mockBlocks["finalized"] = () => {
      const err = new Error("401 Unauthorized: Invalid API key or project ID");
      err.code = "AUTH_ERROR";
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RPC_AUTH_FAILURE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-AUTHFAIL-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 70. Rate-limit response does not activate fallback
  it("70. Rate-limit response during finalized block query does NOT activate fallback and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "88".repeat(32);
    const canonicalHash = "0x" + "88".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Finalized query throws rate-limit failure
    mockBlocks["finalized"] = () => {
      const err = new Error("429 Too Many Requests: Monthly compute units or rate limit exceeded");
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RPC_RATE_LIMITED");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-RATELIMIT-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 71. Unknown RPC error does not activate fallback
  it("71. Unknown RPC error during finalized block query does NOT activate fallback and retains lock", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "89".repeat(32);
    const canonicalHash = "0x" + "89".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // Finalized query throws unknown JSON-RPC server error
    mockBlocks["finalized"] = () => {
      const err = new Error("-32603 Internal JSON-RPC server error: unexpected database state");
      err.code = -32603;
      throw err;
    };

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("RPC_UNKNOWN_ERROR");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-UNKNOWNERR-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });

  // 72. Null finalized-block response fails closed unless unsupported capability is positively established
  it("72. Null finalized-block response fails closed unless unsupported capability is positively established", async () => {
    const prep = await prepareValidBatch();
    const signedTxHex = await signBatchTx(testWallet, prep);
    const parsed = ethers.Transaction.from(signedTxHex);
    const intendedTxHash = parsed.hash.toLowerCase();
    const consumingTxHash = "0x" + "8a".repeat(32);
    const canonicalHash = "0x" + "8a".repeat(32);

    dbState.nonceReservations[prep.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
    dbState.nonceReservations[prep.reservationId].txHash = intendedTxHash;
    dbState.nonceReservations[prep.reservationId].signedTxHex = signedTxHex;
    dbState.nonceReservations[prep.reservationId].broadcastAccepted = false;

    mockLatestMinedNonce = 1;

    mockBlocks[100] = {
      number: 100,
      hash: canonicalHash,
      prefetchedTransactions: [
        {
          hash: consumingTxHash,
          from: testWallet.address,
          nonce: prep.nonce,
        },
      ],
    };
    mempoolReceipts[consumingTxHash] = {
      status: 1,
      blockNumber: 100,
      blockHash: canonicalHash,
      transactionHash: consumingTxHash,
    };

    mockBlockNumber = 110;

    // RPC node returns null (without an explicit unsupported block tag error)
    mockBlocks["finalized"] = null;

    const res = await request(app)
      .post("/api/v1/batches")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ signedTxHex, reservationId: prep.reservationId });

    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal("FINALIZED_BLOCK_UNAVAILABLE");

    const resDoc = dbState.nonceReservations[prep.reservationId];
    expect(resDoc.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    expect(resDoc.reconciliationReason).to.equal("FINALIZED_BLOCK_UNAVAILABLE");
    expect(resDoc.nonceConsumed).to.be.false;

    const prep2 = await request(app)
      .post("/api/v1/batches/prepare")
      .set("Authorization", "Bearer token_farmer_valid")
      .send({ metadata: { ...GOLDEN_INPUT, humanBatchId: "BATCH-NULLFINAL-LOCK" } });

    expect(prep2.status).to.equal(409);
    expect(prep2.body.error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
  });
});


