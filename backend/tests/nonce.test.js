const { expect } = require("chai");
const { ethers } = require("ethers");
const {
  reserveNonce,
  getReservation,
  getWalletNonceTracker,
  expireReservation,
  markCancellationPending,
  confirmCancellationOnChain,
  validateEthereumAddress,
} = require("../src/services/nonce.service");
const {
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
  NONCE_RESERVATION_TTL_MS,
} = require("../src/config/constants");

describe("Transaction Infrastructure & Nonce Reservation Service (Step 3B.5.1)", () => {
  let dbState;
  let mockFirestore;
  let mockProvider;
  let testWallet;
  let otherWallet;
  const testUid = "usr_farmer_991";
  const otherUid = "usr_inspector_992";

  beforeEach(() => {
    // Generate fresh test wallets with genuine cryptographic keys
    testWallet = ethers.Wallet.createRandom();
    otherWallet = ethers.Wallet.createRandom();

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
          email: "inspector@agritrace.org",
          role: "INSPECTOR",
          walletAddress: otherWallet.address,
          isActive: true,
        },
      },
      walletNonceTrackers: {},
      nonceReservations: {},
      idempotencyKeys: {},
    };

    const docVersions = {};

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
          docVersions[`${colName}/${docId}`] = (docVersions[`${colName}/${docId}`] || 0) + 1;
        },
        update: async (updates) => {
          if (!dbState[colName]?.[docId]) {
            throw new Error(`Document ${colName}/${docId} not found`);
          }
          dbState[colName][docId] = { ...dbState[colName][docId], ...updates };
          docVersions[`${colName}/${docId}`] = (docVersions[`${colName}/${docId}`] || 0) + 1;
        },
      };
    }

    // Realistic Firestore in-memory test double supporting atomic transactions with OCC
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
              const col = docRef._col;
              const id = docRef._id;
              const key = `${col}/${id}`;
              const docData = dbState[col]?.[id];
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

          try {
            const result = await updateFunction(transactionContext);

            // Optimistic Concurrency Control (OCC) conflict check:
            // Verify no other transaction mutated any read document during execution
            let conflictDetected = false;
            for (const [key, readVersion] of Object.entries(readVersions)) {
              if ((docVersions[key] || 0) !== readVersion) {
                conflictDetected = true;
                break;
              }
            }

            if (conflictDetected) {
              // Concurrency conflict detected: retry updateFunction
              continue;
            }

            // Commit all staged writes atomically
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
                dbState[write.col][write.id] = { ...dbState[write.col][write.id], ...write.data };
                docVersions[`${write.col}/${write.id}`] = (docVersions[`${write.col}/${write.id}`] || 0) + 1;
              }
            }

            return result;
          } catch (err) {
            // Re-throw non-concurrency domain errors
            throw err;
          }
        }

        throw new Error("Transaction failed after maximum OCC concurrency conflict retries");
      },
    };

    // Default mock blockchain provider returning 0 for both pending and latest
    mockProvider = {
      getTransactionCount: async (address, tag) => {
        return 0;
      },
    };
  });

  describe("1. Address Validation & Security Bindings", () => {
    it("Should validate and checksum Ethereum addresses correctly", () => {
      const lower = testWallet.address.toLowerCase();
      const checksummed = validateEthereumAddress(lower);
      expect(checksummed).to.equal(testWallet.address);
    });

    it("Should reject invalid or malformed Ethereum addresses", () => {
      expect(() => validateEthereumAddress("not-an-address")).to.throw("Invalid 20-byte Ethereum wallet address format");
      expect(() => validateEthereumAddress("")).to.throw("Ethereum walletAddress must be a non-empty string");
      expect(() => validateEthereumAddress(null)).to.throw("Ethereum walletAddress must be a non-empty string");
      expect(() => validateEthereumAddress(12345)).to.throw("Ethereum walletAddress must be a non-empty string");
    });

    it("Should reject reservation if uid is missing or empty", async () => {
      try {
        await reserveNonce({
          uid: "",
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown MISSING_UID");
      } catch (err) {
        expect(err.code).to.equal("MISSING_UID");
        expect(err.statusCode).to.equal(400);
      }
    });

    it("Should reject reservation if targetFunction is missing or empty", async () => {
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown MISSING_TARGET_FUNCTION");
      } catch (err) {
        expect(err.code).to.equal("MISSING_TARGET_FUNCTION");
        expect(err.statusCode).to.equal(400);
      }
    });

    it("Should reject reservation if authenticated user profile is not found", async () => {
      try {
        await reserveNonce({
          uid: "non_existent_uid",
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown USER_NOT_FOUND");
      } catch (err) {
        expect(err.code).to.equal("USER_NOT_FOUND");
        expect(err.statusCode).to.equal(404);
      }
    });

    it("Should reject reservation if user account is disabled or inactive", async () => {
      dbState.users[testUid].isActive = false;

      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown ACCOUNT_INACTIVE");
      } catch (err) {
        expect(err.code).to.equal("ACCOUNT_INACTIVE");
        expect(err.statusCode).to.equal(403);
      }
    });

    it("Should reject reservation if user has no linked wallet in Firestore", async () => {
      dbState.users[testUid].walletAddress = null;

      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown WALLET_NOT_LINKED");
      } catch (err) {
        expect(err.code).to.equal("WALLET_NOT_LINKED");
        expect(err.statusCode).to.equal(403);
      }
    });

    it("Should reject reservation if caller attempts to supply a different wallet than their linked wallet", async () => {
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: otherWallet.address, // testUid is linked to testWallet, not otherWallet!
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown WALLET_MISMATCH");
      } catch (err) {
        expect(err.code).to.equal("WALLET_MISMATCH");
        expect(err.statusCode).to.equal(403);
      }
    });
  });

  describe("2. Nonce Allocation Formula & Mathematical Monotonicity", () => {
    it("First reservation for fresh wallet: should allocate max(rpcPendingNonce, 0)", async () => {
      mockProvider.getTransactionCount = async (addr, tag) => 0;

      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(res.nonce).to.equal(0);
      expect(res.status).to.equal(TRANSACTION_STATUS.RESERVED);
      expect(res.type).to.equal(TRANSACTION_TYPE.NEW_TRANSACTION);

      // Verify walletNonceTrackers was updated correctly
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(0);
      expect(tracker.activeReservationId).to.equal(res.reservationId);
    });

    it("First reservation when RPC pending nonce is already ahead (e.g. 5)", async () => {
      mockProvider.getTransactionCount = async (addr, tag) => (tag === "pending" ? 5 : 4);

      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(res.nonce).to.equal(5);
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(5);
    });

    it("Reservation when pending nonce is greater than tracker highestReservedNonce", async () => {
      // Simulate existing tracker at nonce 3, but external mempool advanced to 7
      dbState.walletNonceTrackers[testWallet.address.toLowerCase()] = {
        walletAddress: testWallet.address,
        highestReservedNonce: 3,
        activeReservationId: null, // previously completed
      };

      mockProvider.getTransactionCount = async (addr, tag) => (tag === "pending" ? 7 : 6);

      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // max(7, 3 + 1) = max(7, 4) = 7
      expect(res.nonce).to.equal(7);
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(7);
    });

    it("Reservation when tracker highestReservedNonce is greater than pending nonce", async () => {
      // Tracker has highestReservedNonce = 10, but mempool is only at 2
      dbState.walletNonceTrackers[testWallet.address.toLowerCase()] = {
        walletAddress: testWallet.address,
        highestReservedNonce: 10,
        activeReservationId: null,
      };

      mockProvider.getTransactionCount = async (addr, tag) => (tag === "pending" ? 2 : 2);

      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // max(2, 10 + 1) = 11
      expect(res.nonce).to.equal(11);
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(11);
    });

    it("Prevention of nonce rollback: tracker highestReservedNonce must never decrease", async () => {
      dbState.walletNonceTrackers[testWallet.address.toLowerCase()] = {
        walletAddress: testWallet.address,
        highestReservedNonce: 15,
        activeReservationId: null,
      };

      // Even if RPC claims pending nonce dropped to 0
      mockProvider.getTransactionCount = async (addr, tag) => 0;

      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // Must be 16, NEVER rollback to 0
      expect(res.nonce).to.equal(16);
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(16);
    });
  });

  describe("3. Single Uncommitted Reservation Invariant", () => {
    it("Should reject second reservation if an active RESERVED transaction is outstanding for the wallet", async () => {
      // First reservation
      const res1 = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });
      expect(res1.status).to.equal(TRANSACTION_STATUS.RESERVED);

      // Attempt second reservation from same wallet before first is completed/submitted
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown ACTIVE_RESERVATION_EXISTS");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
        expect(err.details.activeReservationId).to.equal(res1.reservationId);
        expect(err.details.nonce).to.equal(res1.nonce);
      }
    });

    it("Should allow reservation if previous reservation has progressed beyond RESERVED (e.g. SUBMITTED)", async () => {
      // First reservation
      const res1 = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // Simulate client submitted transaction with broadcast accepted into mempool
      dbState.nonceReservations[res1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
      dbState.nonceReservations[res1.reservationId].broadcastAccepted = true;

      // Second reservation should now succeed and assign next nonce
      const res2 = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "verifyQuality",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(res2.nonce).to.equal(res1.nonce + 1);
      expect(res2.reservationId).to.not.equal(res1.reservationId);
    });

    it("SUBMITTED reservation with broadcastAccepted: false blocks higher nonce reservation with 409", async () => {
      const res1 = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // Reservation moved to SUBMITTED but broadcast has not been accepted
      dbState.nonceReservations[res1.reservationId].status = TRANSACTION_STATUS.SUBMITTED;
      dbState.nonceReservations[res1.reservationId].broadcastAccepted = false;

      let error = null;
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "verifyQuality",
          firestore: mockFirestore,
          provider: mockProvider,
        });
      } catch (err) {
        error = err;
      }

      expect(error).to.exist;
      expect(error.statusCode).to.equal(409);
      expect(error.code).to.equal("ACTIVE_RESERVATION_EXISTS");
    });

    it("Reservations from different wallets must not block each other", async () => {
      // Wallet 1 reserves
      const res1 = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // Wallet 2 reserves independently
      const res2 = await reserveNonce({
        uid: otherUid,
        walletAddress: otherWallet.address,
        targetFunction: "verifyQuality",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(res1.walletAddress).to.equal(testWallet.address);
      expect(res2.walletAddress).to.equal(otherWallet.address);
      expect(res1.nonce).to.equal(0);
      expect(res2.nonce).to.equal(0);
    });
  });

  describe("4. Concurrency Safety & Race Condition Prevention", () => {
    it("Concurrent reservation requests from the same wallet: exactly ONE succeeds, other is rejected with 409", async () => {
      // Trigger two simultaneous reservation calls for the exact same wallet
      const results = await Promise.allSettled([
        reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        }),
        reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Due to OCC and Single Uncommitted Invariant:
      // Exactly ONE must succeed and exactly ONE must fail with 409 Conflict
      expect(fulfilled.length).to.equal(1);
      expect(rejected.length).to.equal(1);

      expect(fulfilled[0].value.status).to.equal(TRANSACTION_STATUS.RESERVED);
      expect(rejected[0].reason.code).to.equal("ACTIVE_RESERVATION_EXISTS");
      expect(rejected[0].reason.statusCode).to.equal(409);
    });

    it("Simultaneous reservations across different wallets execute concurrently without collision", async () => {
      const results = await Promise.all([
        reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        }),
        reserveNonce({
          uid: otherUid,
          walletAddress: otherWallet.address,
          targetFunction: "verifyQuality",
          firestore: mockFirestore,
          provider: mockProvider,
        }),
      ]);

      expect(results[0].walletAddress).to.equal(testWallet.address);
      expect(results[1].walletAddress).to.equal(otherWallet.address);
      expect(results[0].reservationId).to.not.equal(results[1].reservationId);
    });
  });

  describe("5. Idempotent Retry Handling", () => {
    it("Calling reserveNonce with identical idempotencyKey returns the existing reservation without allocating a new nonce", async () => {
      const idempotencyKey = "idem_batch_registration_001";

      const firstCall = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        idempotencyKey,
        firestore: mockFirestore,
        provider: mockProvider,
      });

      const secondCall = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        idempotencyKey,
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(secondCall.reservationId).to.equal(firstCall.reservationId);
      expect(secondCall.nonce).to.equal(firstCall.nonce);
      expect(secondCall.createdAt).to.equal(firstCall.createdAt);

      // Verify tracker counter remained unchanged
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(firstCall.nonce);
    });
  });

  describe("6. Expiry Handling & Nonce Gap Prevention", () => {
    it("Expired reservation is flagged as expired on inspection", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        ttlMs: 50, // 50 milliseconds
        firestore: mockFirestore,
        provider: mockProvider,
      });

      // Wait 60ms for TTL to lapse
      await new Promise((resolve) => setTimeout(resolve, 60));

      const inspected = await getReservation(res.reservationId, { firestore: mockFirestore });
      expect(inspected.isExpired).to.be.true;
    });

    it("Expiring a reservation does NOT release the wallet for another reservation", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      expect(res.nonce).to.equal(0);

      // Explicitly expire the reservation
      const expired = await expireReservation(res.reservationId, { firestore: mockFirestore });
      expect(expired.status).to.equal(TRANSACTION_STATUS.EXPIRED);

      // Verify tracker state: activeReservationId MUST NOT be cleared!
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(res.reservationId);
      expect(tracker.highestReservedNonce).to.equal(0); // STRICTLY PRESERVED: NEVER DECREMENTED!

      // Attempting another reservation must be REJECTED with 409
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown ACTIVE_RESERVATION_EXISTS");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
        expect(err.details.status).to.equal(TRANSACTION_STATUS.EXPIRED);
      }
    });

    it("A second reservation is rejected while an expired nonce remains unresolved", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      await expireReservation(res.reservationId, { firestore: mockFirestore });

      // Second reservation attempt is rejected
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "verifyQuality",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have rejected unresolved reservation");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
        expect(err.message).to.include("An unresolved reservation at nonce 0");
      }
    });

    it("A higher nonce cannot be allocated while a lower reserved nonce remains unresolved", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });
      expect(res.nonce).to.equal(0);

      // Nonce 0 is unresolved. Ensure system refuses to allocate nonce 1
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "transferCustody",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have rejected allocating higher nonce");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
      }

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.highestReservedNonce).to.equal(0);
    });

    it("An unconfirmed cancellation does NOT release the reservation", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      const cancelTxHash = "0x" + "aa".repeat(32);
      await markCancellationPending({
        reservationId: res.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
      });

      const inspected = await getReservation(res.reservationId, { firestore: mockFirestore });
      expect(inspected.status).to.equal(TRANSACTION_STATUS.CANCELLATION_PENDING);

      // Verify active reservation pointer is STILL locked
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(res.reservationId);

      // Attempting another reservation must STILL be rejected with 409
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have rejected unconfirmed cancellation");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
        expect(err.message).to.include("An unresolved reservation at nonce 0");
      }
    });

    it("Failed on-chain cancellation does NOT release the reservation", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      const cancelTxHash = "0x" + "bb".repeat(32);
      await markCancellationPending({
        reservationId: res.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
      });

      // Cancellation receipt reverted on-chain (status === 0)
      const revertProvider = {
        getTransaction: async () => ({
          hash: cancelTxHash,
          from: testWallet.address,
          to: testWallet.address,
          nonce: res.nonce,
          value: 0n,
          data: "0x",
        }),
        getTransactionReceipt: async () => ({
          hash: cancelTxHash,
          blockNumber: 100,
          blockHash: "0x" + "11".repeat(32),
          status: 0, // REVERT
        }),
        getBlock: async (tagOrNum) => {
          if (tagOrNum === "finalized") {
            return { number: 105, hash: "0x" + "11".repeat(32) };
          }
          return { number: 100, hash: "0x" + "11".repeat(32) };
        },
        getBlockNumber: async () => 105,
      };

      const outcome = await confirmCancellationOnChain({
        reservationId: res.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider: revertProvider,
      });

      expect(outcome.resolved).to.be.false;

      // Active reservation pointer MUST STILL be locked!
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(res.reservationId);

      // Attempting another reservation must STILL be rejected with 409
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have rejected after failed cancellation");
      } catch (err) {
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.statusCode).to.equal(409);
        expect(err.message).to.include("An unresolved reservation at nonce 0");
      }
    });

    it("A confirmed on-chain cancellation resolves the outstanding reservation and allows the next sequential nonce", async () => {
      const res = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });
      expect(res.nonce).to.equal(0);

      const cancelTxHash = "0x" + "cc".repeat(32);
      await markCancellationPending({
        reservationId: res.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
      });

      // Cancellation transaction confirmed on-chain with valid receipt and canonical block
      const validCancelProvider = {
        getTransaction: async () => ({
          hash: cancelTxHash,
          from: testWallet.address,
          to: testWallet.address,
          nonce: res.nonce,
          value: 0n,
          data: "0x",
        }),
        getTransactionReceipt: async () => ({
          hash: cancelTxHash,
          blockNumber: 100,
          blockHash: "0x" + "11".repeat(32),
          status: 1, // SUCCESS
        }),
        getBlock: async (tagOrNum) => {
          if (tagOrNum === "finalized") {
            return { number: 105, hash: "0x" + "11".repeat(32) };
          }
          return { number: 100, hash: "0x" + "11".repeat(32) };
        },
        getBlockNumber: async () => 105,
        getTransactionCount: async () => 1,
      };

      const outcome = await confirmCancellationOnChain({
        reservationId: res.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider: validCancelProvider,
        requiredConfirmations: 2,
      });

      expect(outcome.resolved).to.be.true;
      expect(outcome.status).to.equal(TRANSACTION_STATUS.CANCELLED_ON_CHAIN);

      // Verify active reservation pointer is NOW CLEARED
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.be.null;
      expect(tracker.highestReservedNonce).to.equal(0); // STILL 0 (never decremented)

      // Next reservation now succeeds, allocating nonce 1 (avoiding any nonce gap!)
      const nextRes = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: validCancelProvider,
      });

      expect(nextRes.nonce).to.equal(1);
      const updatedTracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(updatedTracker.highestReservedNonce).to.equal(1);
      expect(updatedTracker.activeReservationId).to.equal(nextRes.reservationId);
    });
  });

  describe("7. RPC & Database Failure Modes (Fail-Safe Resilience)", () => {
    it("Should fail safely and throw 503 BLOCKCHAIN_RPC_UNAVAILABLE when RPC call throws", async () => {
      mockProvider.getTransactionCount = async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      };

      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown BLOCKCHAIN_RPC_UNAVAILABLE");
      } catch (err) {
        expect(err.code).to.equal("BLOCKCHAIN_RPC_UNAVAILABLE");
        expect(err.statusCode).to.equal(503);
        expect(err.details.originalError).to.include("ECONNREFUSED");
      }

      // Assert no reservation was created and no tracker was modified
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker).to.be.null;
    });

    it("Should fail safely when RPC returns non-numeric or negative nonce", async () => {
      mockProvider.getTransactionCount = async () => -5;

      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have thrown INVALID_RPC_NONCE");
      } catch (err) {
        expect(err.code).to.equal("INVALID_RPC_NONCE");
        expect(err.statusCode).to.equal(503);
      }
    });

    it("Should properly propagate Firestore database errors without partial state corruption", async () => {
      const failingFirestore = {
        collection: () => ({
          doc: () => ({
            get: async () => {
              throw new Error("Firestore quota exceeded / network partitioned");
            },
          }),
        }),
        runTransaction: async () => {
          throw new Error("Firestore transaction timeout");
        },
      };

      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: failingFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have failed on Firestore error");
      } catch (err) {
        expect(err.message).to.equal("Firestore transaction timeout");
      }
    });
  });

  describe("8. Independent Cancellation On-Chain Verification & Reorganisation Defense", () => {
    let baseRes;
    const cancelTxHash = "0x" + "77".repeat(32);
    const validBlockHash = "0x" + "88".repeat(32);

    function createMockProvider({
      txSender = testWallet.address,
      txRecipient = testWallet.address,
      txNonce = 0,
      txValue = 0n,
      txData = "0x",
      receiptStatus = 1,
      receiptHash = cancelTxHash,
      receiptBlockNumber = 200,
      receiptBlockHash = validBlockHash,
      canonicalBlockHash = validBlockHash,
      currentBlockNumber = 210, // 210 - 200 + 1 = 11 confirmations (>= 2)
      txThrows = false,
      receiptThrows = false,
      missingTx = false,
      missingReceipt = false,
      finalizedSupported = true,
      finalizedBlockNumber = 205, // 205 >= 200 (Casper FFG finalized checkpoint)
      finalizedBlockHash = validBlockHash,
      finalizedThrows = false,
      finalizedNetworkError = false,
      finalizedBlockObject = undefined,
    } = {}) {
      return {
        getTransaction: async (hash) => {
          if (txThrows) throw new Error("RPC network timeout in getTransaction");
          if (missingTx) return null;
          return {
            hash,
            from: txSender,
            to: txRecipient,
            nonce: txNonce,
            value: txValue,
            data: txData,
          };
        },
        getTransactionReceipt: async (hash) => {
          if (receiptThrows) throw new Error("RPC network timeout in getTransactionReceipt");
          if (missingReceipt) return null;
          return {
            hash: receiptHash,
            blockNumber: receiptBlockNumber,
            blockHash: receiptBlockHash,
            status: receiptStatus,
          };
        },
        getBlock: async (blockTagOrNumber) => {
          if (blockTagOrNumber === "finalized") {
            if (finalizedNetworkError) throw new Error("RPC network timeout querying finalized block");
            if (finalizedThrows) throw new Error("Method eth_getBlockByNumber not supported for tag finalized");
            if (finalizedBlockObject !== undefined) return finalizedBlockObject;
            if (!finalizedSupported) {
              throw new Error("Method eth_getBlockByNumber with tag 'finalized' not supported on this network");
            }
            return {
              number: finalizedBlockNumber,
              hash: finalizedBlockHash,
            };
          }
          if (canonicalBlockHash === null) return null;
          return {
            number: blockTagOrNumber,
            hash: canonicalBlockHash,
          };
        },
        getBlockNumber: async () => currentBlockNumber,
      };
    }

    beforeEach(async () => {
      baseRes = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });

      await markCancellationPending({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
      });
    });

    it("1. Successful finalized cancellation on PoS network releases reservation and unlocks wallet", async () => {
      const provider = createMockProvider({ finalizedSupported: true, finalizedBlockNumber: 205 });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.true;
      expect(outcome.status).to.equal(TRANSACTION_STATUS.CANCELLED_ON_CHAIN);
      expect(outcome.finalityMethod).to.equal("ETH_FINALIZED_TAG");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.be.null;

      const res = await getReservation(baseRes.reservationId, { firestore: mockFirestore });
      expect(res.status).to.equal(TRANSACTION_STATUS.CANCELLED_ON_CHAIN);
      expect(res.finalityMethod).to.equal("ETH_FINALIZED_TAG");
    });

    it("2. Rejects release when transaction sender does not equal reservation linked wallet", async () => {
      const provider = createMockProvider({ txSender: otherWallet.address });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("SENDER_MISMATCH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("3. Rejects release when transaction recipient is not the same wallet (not a self-transfer)", async () => {
      const provider = createMockProvider({ txRecipient: otherWallet.address });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RECIPIENT_MISMATCH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("4. Rejects release when transaction nonce does not match reserved nonce", async () => {
      const provider = createMockProvider({ txNonce: 99 });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("NONCE_MISMATCH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("5. Rejects release when transaction value is non-zero (must be exactly 0 native Ether)", async () => {
      const provider = createMockProvider({ txValue: ethers.parseEther("0.1") });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("NON_ZERO_VALUE");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("6. Rejects release when transaction data is non-empty (must be strictly 0x)", async () => {
      const provider = createMockProvider({ txData: "0x1234abcd" });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("NON_EMPTY_CALLDATA");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("7. Rejects release when receipt status is 0 (reverted on-chain)", async () => {
      const provider = createMockProvider({ receiptStatus: 0 });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RECEIPT_STATUS_REVERTED");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("8. Rejects release when transaction is missing from blockchain", async () => {
      const provider = createMockProvider({ missingTx: true });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("TRANSACTION_NOT_FOUND");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("9. Rejects release when receipt is missing (still pending in mempool)", async () => {
      const provider = createMockProvider({ missingReceipt: true });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RECEIPT_NOT_FOUND");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("10. Rejects release when receipt transaction hash does not match cancelTxHash", async () => {
      const provider = createMockProvider({ receiptHash: "0x" + "ff".repeat(32) });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RECEIPT_HASH_MISMATCH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("11. Reorganisation detected: marks reservation RECONCILIATION_REQUIRED and keeps wallet locked", async () => {
      const provider = createMockProvider({ canonicalBlockHash: "0x" + "99".repeat(32) });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("REORGANISATION_DETECTED");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);

      // Verify reservation was marked RECONCILIATION_REQUIRED
      const res = await getReservation(baseRes.reservationId, { firestore: mockFirestore });
      expect(res.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);
    });

    it("12. RECONCILIATION_REQUIRED blocks subsequent nonce reservations with HTTP 409 until genuinely resolved", async () => {
      // 1. Reorganisation changes the reservation to RECONCILIATION_REQUIRED
      const reorgProvider = createMockProvider({ canonicalBlockHash: "0x" + "reorg".repeat(6) + "0000" });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider: reorgProvider,
      });
      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("REORGANISATION_DETECTED");

      const resAfterReorg = await getReservation(baseRes.reservationId, { firestore: mockFirestore });
      expect(resAfterReorg.status).to.equal(TRANSACTION_STATUS.RECONCILIATION_REQUIRED);

      // 2. The active reservation pointer remains locked
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);

      // 3. A subsequent reserveNonce request returns HTTP 409
      try {
        await reserveNonce({
          uid: testUid,
          walletAddress: testWallet.address,
          targetFunction: "createBatch",
          firestore: mockFirestore,
          provider: mockProvider,
        });
        expect.fail("Should have rejected reserveNonce when reservation is in RECONCILIATION_REQUIRED");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("ACTIVE_RESERVATION_EXISTS");
        expect(err.message).to.include("RECONCILIATION_REQUIRED");
      }

      // 4. The wallet remains locked until the outstanding nonce is genuinely resolved
      const validCanonicalFinalizedProvider = createMockProvider({
        finalizedSupported: true,
        finalizedBlockNumber: 205,
      });
      const resolvedOutcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider: validCanonicalFinalizedProvider,
      });
      expect(resolvedOutcome.resolved).to.be.true;
      expect(resolvedOutcome.status).to.equal(TRANSACTION_STATUS.CANCELLED_ON_CHAIN);

      // Verify active reservation pointer is NOW cleared
      const unlockedTracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(unlockedTracker.activeReservationId).to.be.null;

      // 5. Subsequent reservation now succeeds cleanly at next sequential nonce
      const newRes = await reserveNonce({
        uid: testUid,
        walletAddress: testWallet.address,
        targetFunction: "createBatch",
        firestore: mockFirestore,
        provider: mockProvider,
      });
      expect(newRes.nonce).to.equal(1);
    });

    it("13. Rejects release when confirmation depth is insufficient (< requiredConfirmations)", async () => {
      // Mined at block 200, current block 200 => depth = 1 (< 2 required)
      const provider = createMockProvider({ currentBlockNumber: 200 });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
        requiredConfirmations: 2,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("INSUFFICIENT_CONFIRMATIONS");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("14. Insufficient Casper FFG finality keeps reservation locked (receipt block > finalized block)", async () => {
      // 11 confirmations (current 210, receipt 200), BUT finalized block is 195 (< 200)
      const provider = createMockProvider({
        currentBlockNumber: 210,
        receiptBlockNumber: 200,
        finalizedSupported: true,
        finalizedBlockNumber: 195, // Not yet reached Casper FFG checkpoint!
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("AWAITING_FINALITY");
      expect(outcome.details.receiptBlockNumber).to.equal(200);
      expect(outcome.details.finalizedBlockNumber).to.equal(195);

      // Active reservation pointer MUST STILL be locked!
      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("15. Unsupported finalized-block RPC uses only the documented fallback (rejects when depth < fallback)", async () => {
      // Network does not support 'finalized' block tag (e.g. local Hardhat)
      // Mined at 200, current at 202 => depth = 3 (satisfies base 2, but < fallback 5)
      const provider = createMockProvider({
        finalizedSupported: false,
        receiptBlockNumber: 200,
        currentBlockNumber: 202,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
        fallbackFinalityConfirmations: 5,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("INSUFFICIENT_FINALITY_DEPTH");
      expect(outcome.details.confirmationCount).to.equal(3);
      expect(outcome.details.requiredFallbackConfirmations).to.equal(5);

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("16. Unsupported finalized-block RPC releases reservation when fallback confirmation depth is met", async () => {
      // Network does not support 'finalized' block tag (returns null)
      // Mined at 200, current at 205 => depth = 6 (>= fallback 5)
      const provider = createMockProvider({
        finalizedSupported: false,
        receiptBlockNumber: 200,
        currentBlockNumber: 205,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
        fallbackFinalityConfirmations: 5,
      });

      expect(outcome.resolved).to.be.true;
      expect(outcome.status).to.equal(TRANSACTION_STATUS.CANCELLED_ON_CHAIN);
      expect(outcome.finalityMethod).to.equal("FALLBACK_DEPTH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.be.null;
    });

    it("17. Unsupported finalized-block RPC tag throwing error falls back to configurable depth", async () => {
      // Provider throws 'Method not supported for tag finalized'
      // Mined at 200, current at 205 => depth = 6 (>= fallback 5)
      const provider = createMockProvider({
        finalizedThrows: true,
        receiptBlockNumber: 200,
        currentBlockNumber: 205,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
        fallbackFinalityConfirmations: 5,
      });

      expect(outcome.resolved).to.be.true;
      expect(outcome.finalityMethod).to.equal("FALLBACK_DEPTH");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.be.null;
    });

    it("18. RPC network error during finalized block query never releases reservation", async () => {
      const provider = createMockProvider({ finalizedNetworkError: true });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RPC_ERROR");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("19. RPC network error during transaction or receipt query never releases reservation", async () => {
      const provider = createMockProvider({ txThrows: true });
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("RPC_ERROR");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("20. Nonce field matching uses the exact persisted reservation.nonce field", async () => {
      // 1. Transaction nonce differs from persisted reservation.nonce
      const mismatchProvider = createMockProvider({ txNonce: 5 }); // baseRes.nonce is 0
      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider: mismatchProvider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("NONCE_MISMATCH");
      expect(outcome.details.expected).to.equal(0);
      expect(outcome.details.actual).to.equal(5);

      // 2. Corrupted reservation record missing integer nonce field throws 500 error
      await mockFirestore.collection("nonceReservations").doc(baseRes.reservationId).update({
        nonce: undefined,
      });

      try {
        await confirmCancellationOnChain({
          reservationId: baseRes.reservationId,
          cancelTxHash,
          firestore: mockFirestore,
          provider: createMockProvider(),
        });
        expect.fail("Should have thrown error on corrupted reservation missing nonce");
      } catch (err) {
        expect(err.statusCode).to.equal(500);
        expect(err.code).to.equal("CORRUPTED_RESERVATION_RECORD");
      }
    });

    it("21. Disabled fallback finality rejects release with FINALITY_TAG_REQUIRED when finalized tag is unsupported", async () => {
      // Network does not support 'finalized' block tag (returns null), but allowFallbackFinality is false
      // Mined at 200, current at 210 => depth = 11 (satisfies depth, but fallback is disabled)
      const provider = createMockProvider({
        finalizedSupported: false,
        receiptBlockNumber: 200,
        currentBlockNumber: 210,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
        allowFallbackFinality: false,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("FINALITY_TAG_REQUIRED");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("22. Invalid finalized-block response fails closed without releasing reservation", async () => {
      // RPC returns an invalid object (negative block number)
      const provider = createMockProvider({
        finalizedBlockObject: { number: -10, hash: "0x123" },
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("INVALID_FINALIZED_BLOCK_RESPONSE");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("23. Inconsistent future finalized-block response fails closed without releasing reservation", async () => {
      // RPC returns finalized block height in the future (currentBlock = 210, finalized = 999)
      const provider = createMockProvider({
        finalizedBlockObject: { number: 999, hash: "0x123" },
        currentBlockNumber: 210,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("INCONSISTENT_FINALITY_RESPONSE");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });

    it("24. Ambiguous null finalized-block response fails closed without unlocking reservation", async () => {
      // RPC returns null without throwing an explicit unsupported block tag error
      const provider = createMockProvider({
        finalizedBlockObject: null,
      });

      const outcome = await confirmCancellationOnChain({
        reservationId: baseRes.reservationId,
        cancelTxHash,
        firestore: mockFirestore,
        provider,
      });

      expect(outcome.resolved).to.be.false;
      expect(outcome.reason).to.equal("FINALIZED_BLOCK_UNAVAILABLE");

      const tracker = await getWalletNonceTracker(testWallet.address, { firestore: mockFirestore });
      expect(tracker.activeReservationId).to.equal(baseRes.reservationId);
    });
  });
});

