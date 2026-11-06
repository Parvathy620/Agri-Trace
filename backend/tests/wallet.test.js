const { expect } = require("chai");
const { ethers } = require("ethers");
const {
  createChallenge,
  verifyAndLinkWallet,
  buildChallengeMessage,
} = require("../src/services/wallet.service");

describe("Wallet Ownership Verification & Linking Service", () => {
  let dbState;
  let mockFirestore;
  let testWallet;
  let otherWallet;
  const testUid = "usr_farmer_101";
  const otherUid = "usr_transporter_202";

  beforeEach(() => {
    // Generate fresh ephemeral test wallets with genuine cryptographic keys
    testWallet = ethers.Wallet.createRandom();
    otherWallet = ethers.Wallet.createRandom();

    dbState = {
      users: {
        [testUid]: {
          uid: testUid,
          email: "farmer@agritrace.org",
          role: "FARMER",
          walletAddress: null,
          isActive: true,
        },
        [otherUid]: {
          uid: otherUid,
          email: "transporter@agritrace.org",
          role: "TRANSPORTER",
          walletAddress: null,
          isActive: true,
        },
      },
      walletMappings: {},
      walletLinkChallenges: {},
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
        set: async (docData) => {
          if (!dbState[colName]) dbState[colName] = {};
          dbState[colName][docId] = { ...docData };
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
        const maxAttempts = 5;

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
            set: (docRef, data) => {
              stagedWrites.push({ type: "set", col: docRef._col, id: docRef._id, data });
            },
            update: (docRef, data) => {
              stagedWrites.push({ type: "update", col: docRef._col, id: docRef._id, data });
            },
          };

          const result = await updateFunction(transactionContext);

          // Check if any read document was modified concurrently
          let conflict = false;
          for (const key of Object.keys(readVersions)) {
            const currentVersion = docVersions[key] || 0;
            if (currentVersion !== readVersions[key]) {
              conflict = true;
              break;
            }
          }

          if (conflict) {
            // Concurrent modification detected; retry transaction with refreshed state
            continue;
          }

          // Commit staged atomic writes and increment document versions
          for (const write of stagedWrites) {
            const key = `${write.col}/${write.id}`;
            if (!dbState[write.col]) dbState[write.col] = {};
            if (write.type === "set") {
              dbState[write.col][write.id] = { ...write.data };
            } else {
              dbState[write.col][write.id] = { ...dbState[write.col][write.id], ...write.data };
            }
            docVersions[key] = (docVersions[key] || 0) + 1;
          }

          return result;
        }

        throw new Error("Transaction failed due to contention after maximum retries");
      },
    };
  });

  describe("Challenge Creation (createChallenge)", () => {
    it("Should generate a valid time-bounded challenge with cryptographically secure nonce", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      expect(challenge).to.be.an("object");
      expect(challenge.challengeId).to.be.a("string");
      expect(challenge.walletAddress).to.equal(ethers.getAddress(testWallet.address));
      expect(challenge.message).to.be.a("string");
      expect(challenge.message).to.include("AgriTrace Wallet Link Verification");
      expect(challenge.message).to.include(`UID: ${testUid}`);
      expect(challenge.message).to.include(`Wallet: ${ethers.getAddress(testWallet.address)}`);
      expect(challenge.message).to.include("Domain: agritrace.io");
      expect(challenge.expiresAt).to.be.a("string");

      // Verify persisted in Firestore
      const savedDoc = dbState.walletLinkChallenges[challenge.challengeId];
      expect(savedDoc).to.exist;
      expect(savedDoc.isConsumed).to.be.false;
      expect(savedDoc.status).to.equal("PENDING");
      expect(savedDoc.nonce).to.have.lengthOf(64); // 32 bytes hex
    });

    it("Should reject invalid or malformed Ethereum addresses", async () => {
      try {
        await createChallenge({
          uid: testUid,
          walletAddress: "0xInvalidAddressNotHex",
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(400);
        expect(err.code).to.equal("INVALID_WALLET_ADDRESS");
      }
    });

    it("Should reject challenge creation if wallet is already linked to another user account", async () => {
      // Pre-link wallet to otherUid using canonical lowercase doc ID
      dbState.walletMappings[testWallet.address.toLowerCase()] = {
        uid: otherUid,
        walletAddress: ethers.getAddress(testWallet.address),
        canonicalAddress: testWallet.address.toLowerCase(),
        linkedAt: new Date().toISOString(),
      };

      try {
        await createChallenge({
          uid: testUid,
          walletAddress: testWallet.address,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("WALLET_ALREADY_LINKED");
      }
    });

    it("Should reject challenge creation if caller already has a different linked wallet (prevent silent overwrite)", async () => {
      // User testUid already has otherWallet linked
      dbState.users[testUid].walletAddress = ethers.getAddress(otherWallet.address);

      try {
        await createChallenge({
          uid: testUid,
          walletAddress: testWallet.address,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("USER_WALLET_ALREADY_LINKED");
        expect(err.message).to.include("Overwriting an existing wallet association is prohibited");
      }
    });

    it("Should prevent casing manipulation bypass in duplicate-linking protection", async () => {
      // Pre-link otherWallet to otherUid
      dbState.walletMappings[otherWallet.address.toLowerCase()] = {
        uid: otherUid,
        walletAddress: ethers.getAddress(otherWallet.address),
        canonicalAddress: otherWallet.address.toLowerCase(),
        linkedAt: new Date().toISOString(),
      };

      // Attacker attempts to link the same wallet with all lowercase representation
      try {
        await createChallenge({
          uid: testUid,
          walletAddress: otherWallet.address.toLowerCase(),
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("WALLET_ALREADY_LINKED");
      }
    });
  });

  describe("Challenge Verification & Atomic Linking (verifyAndLinkWallet)", () => {
    it("Should allow a user with no existing walletAddress to successfully link their first wallet", async () => {
      // Explicitly confirm user profile begins with no linked wallet
      expect(dbState.users[testUid].walletAddress).to.be.null;

      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      const result = await verifyAndLinkWallet({
        uid: testUid,
        challengeId: challenge.challengeId,
        signature,
        firestore: mockFirestore,
      });

      expect(result.walletAddress).to.equal(ethers.getAddress(testWallet.address));
      expect(dbState.users[testUid].walletAddress).to.equal(ethers.getAddress(testWallet.address));
      expect(dbState.walletMappings[testWallet.address.toLowerCase()].uid).to.equal(testUid);
    });

    it("Should allow verifying the same already-linked wallet but reject a different wallet", async () => {
      // User has testWallet linked
      dbState.users[testUid].walletAddress = ethers.getAddress(testWallet.address);
      dbState.walletMappings[testWallet.address.toLowerCase()] = {
        uid: testUid,
        walletAddress: ethers.getAddress(testWallet.address),
        canonicalAddress: testWallet.address.toLowerCase(),
        linkedAt: new Date().toISOString(),
      };

      // Challenge for the same wallet is permitted
      const sameWalletChallenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });
      const sameSig = await testWallet.signMessage(sameWalletChallenge.message);
      const sameResult = await verifyAndLinkWallet({
        uid: testUid,
        challengeId: sameWalletChallenge.challengeId,
        signature: sameSig,
        firestore: mockFirestore,
      });
      expect(sameResult.walletAddress).to.equal(ethers.getAddress(testWallet.address));

      // Attempting to link a DIFFERENT wallet (otherWallet) is rejected
      try {
        await createChallenge({
          uid: testUid,
          walletAddress: otherWallet.address,
          firestore: mockFirestore,
        });
        expect.fail("Should have rejected different wallet challenge");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("USER_WALLET_ALREADY_LINKED");
      }
    });

    it("Should successfully verify a genuine cryptographic signature and link the wallet to the user", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      // Participant signs the challenge message with their local private key
      const signature = await testWallet.signMessage(challenge.message);

      const result = await verifyAndLinkWallet({
        uid: testUid,
        challengeId: challenge.challengeId,
        signature,
        firestore: mockFirestore,
      });

      expect(result.walletAddress).to.equal(ethers.getAddress(testWallet.address));
      expect(result.linkedAt).to.be.a("string");

      // Verify Firestore state was atomically committed
      const user = dbState.users[testUid];
      expect(user.walletAddress).to.equal(ethers.getAddress(testWallet.address));

      // Assert document ID uses canonical lowercase representation
      const mapping = dbState.walletMappings[testWallet.address.toLowerCase()];
      expect(mapping).to.exist;
      expect(mapping.uid).to.equal(testUid);
      expect(mapping.canonicalAddress).to.equal(testWallet.address.toLowerCase());
      expect(mapping.walletAddress).to.equal(ethers.getAddress(testWallet.address));

      const updatedChallenge = dbState.walletLinkChallenges[challenge.challengeId];
      expect(updatedChallenge.isConsumed).to.be.true;
      expect(updatedChallenge.status).to.equal("CONSUMED");
    });

    it("Should reject signature signed by a different wallet address (impersonation attempt)", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      // Attacker signs the message with their own wallet
      const invalidSignature = await otherWallet.signMessage(challenge.message);

      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature: invalidSignature,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(403);
        expect(err.code).to.equal("WALLET_SIGNATURE_MISMATCH");
        expect(err.message).to.include("Signer mismatch");
      }

      // Wallet must NOT have been linked
      expect(dbState.users[testUid].walletAddress).to.be.null;
    });

    it("Should reject challenge verification when the challenge has expired", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      // Manually backdate expiry to simulate expired challenge
      dbState.walletLinkChallenges[challenge.challengeId].expiresAt = new Date(
        Date.now() - 1000
      ).toISOString();

      const signature = await testWallet.signMessage(challenge.message);

      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(400);
        expect(err.code).to.equal("CHALLENGE_EXPIRED");
      }
    });

    it("Should reject replaying an already consumed challenge", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      // First verification succeeds
      await verifyAndLinkWallet({
        uid: testUid,
        challengeId: challenge.challengeId,
        signature,
        firestore: mockFirestore,
      });

      // Second verification attempt with same challenge (replay attack)
      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        });
        expect.fail("Replay should have been rejected");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("CHALLENGE_ALREADY_CONSUMED");
      }
    });

    it("Should reject challenge verification if the challenge belongs to another user account", async () => {
      const challenge = await createChallenge({
        uid: otherUid, // Issued to otherUid
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      // Attempting to submit as testUid
      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(403);
        expect(err.code).to.equal("CHALLENGE_UID_MISMATCH");
      }
    });

    it("Should reject wallet linking if the wallet was linked to another user concurrently", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      // Simulate concurrent linking of the same wallet to otherUid
      dbState.walletMappings[testWallet.address.toLowerCase()] = {
        uid: otherUid,
        walletAddress: ethers.getAddress(testWallet.address),
        canonicalAddress: testWallet.address.toLowerCase(),
        linkedAt: new Date().toISOString(),
      };

      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("WALLET_ALREADY_LINKED");
      }
    });

    it("Should reject challenge verification if caller already has a different linked wallet (prevent silent overwrite)", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      // User account was linked to otherWallet after challenge was issued
      dbState.users[testUid].walletAddress = ethers.getAddress(otherWallet.address);

      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("USER_WALLET_ALREADY_LINKED");
        expect(err.message).to.include("Overwriting an existing wallet association is prohibited");
      }
    });

    it("Should reject malformed or invalid signature formats", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      try {
        await verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature: "0xNotValidHexSignature",
          firestore: mockFirestore,
        });
        expect.fail("Should have thrown error");
      } catch (err) {
        expect(err.statusCode).to.equal(400);
        expect(err.code).to.equal("INVALID_SIGNATURE_FORMAT");
      }
    });

    it("Should prevent concurrent race conditions from consuming the same challenge twice", async () => {
      const challenge = await createChallenge({
        uid: testUid,
        walletAddress: testWallet.address,
        firestore: mockFirestore,
      });

      const signature = await testWallet.signMessage(challenge.message);

      // Fire two concurrent verification requests in parallel
      const results = await Promise.allSettled([
        verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        }),
        verifyAndLinkWallet({
          uid: testUid,
          challengeId: challenge.challengeId,
          signature,
          firestore: mockFirestore,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one must succeed, and the other must be rejected
      expect(fulfilled).to.have.lengthOf(1);
      expect(rejected).to.have.lengthOf(1);
      expect(rejected[0].reason.code).to.equal("CHALLENGE_ALREADY_CONSUMED");
    });
  });
});
