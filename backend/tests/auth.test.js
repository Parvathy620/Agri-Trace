const { expect } = require("chai");
const request = require("supertest");
const express = require("express");
const { createAuthMiddleware } = require("../src/middleware/auth.middleware");
const { createAuthRouter } = require("../src/routes/auth.routes");
const { errorHandler } = require("../src/middleware/error.middleware");

describe("Firebase Authentication Middleware & User Profile Binding", () => {
  let mockAuth;
  let mockFirestore;
  let app;
  let usersDb;

  beforeEach(() => {
    usersDb = {
      user_farmer_1: {
        uid: "user_farmer_1",
        email: "farmer@agritrace.org",
        displayName: "Ramesh Farmer",
        role: "FARMER",
        walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        organization: { name: "Sahyadri FPC" },
        isActive: true,
        createdAt: "2026-11-01T08:00:00.000Z",
      },
      user_inactive: {
        uid: "user_inactive",
        email: "disabled@agritrace.org",
        role: "FARMER",
        isActive: false,
      },
    };

    mockAuth = {
      verifyIdToken: async (token, checkRevoked) => {
        if (token === "valid_token_farmer") {
          return { uid: "user_farmer_1", email: "farmer@agritrace.org" };
        }
        if (token === "valid_token_inactive") {
          return { uid: "user_inactive", email: "disabled@agritrace.org" };
        }
        if (token === "valid_token_unregistered") {
          return { uid: "user_no_profile", email: "newuser@agritrace.org" };
        }
        if (token === "revoked_token") {
          const err = new Error("The Firebase ID token has been revoked.");
          err.code = "auth/id-token-revoked";
          throw err;
        }
        if (token === "expired_token") {
          const err = new Error("The Firebase ID token has expired.");
          err.code = "auth/id-token-expired";
          throw err;
        }
        const err = new Error("Firebase ID token verification failed.");
        err.code = "auth/invalid-id-token";
        throw err;
      },
    };

    mockFirestore = {
      collection: (name) => {
        if (name === "users") {
          return {
            doc: (uid) => ({
              get: async () => {
                const user = usersDb[uid];
                return {
                  exists: Boolean(user),
                  data: () => user,
                };
              },
            }),
          };
        }
        throw new Error(`Unexpected collection: ${name}`);
      },
    };

    const authMiddleware = createAuthMiddleware({
      auth: mockAuth,
      firestore: mockFirestore,
    });

    app = express();
    app.use(express.json());

    // Mount test auth router
    const testRouter = createAuthRouter({
      authenticate: authMiddleware,
    });
    app.use("/api/v1/auth", testRouter);

    // Protected echo route for authentication verification
    app.get("/api/v1/protected-test", authMiddleware, (req, res) => {
      res.status(200).json({
        success: true,
        user: req.user,
      });
    });

    app.use(errorHandler);
  });

  it("Should reject requests missing the Authorization header with 401 AUTH_HEADER_MISSING", async () => {
    const res = await request(app).get("/api/v1/protected-test");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_HEADER_MISSING");
  });

  it("Should reject requests with malformed Authorization header (no Bearer scheme) with 401 AUTH_TOKEN_MALFORMED", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Basic some-base64-credentials");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_TOKEN_MALFORMED");
  });

  it("Should reject requests with empty Bearer token with 401 AUTH_TOKEN_MALFORMED", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer ");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_TOKEN_MALFORMED");
  });

  it("Should reject invalid Firebase ID tokens with 401 AUTH_TOKEN_INVALID", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer invalid_gibberish_token");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_TOKEN_INVALID");
  });

  it("Should reject expired Firebase ID tokens with 401 AUTH_TOKEN_INVALID", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer expired_token");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_TOKEN_INVALID");
  });

  it("Should reject revoked Firebase ID tokens with 401 AUTH_TOKEN_REVOKED", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer revoked_token");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("AUTH_TOKEN_REVOKED");
    expect(res.body.error.message).to.include("revoked");
  });

  it("Should reject authenticated tokens where user profile does not exist in Firestore with 401 USER_PROFILE_NOT_FOUND", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer valid_token_unregistered");

    expect(res.status).to.equal(401);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("USER_PROFILE_NOT_FOUND");
  });

  it("Should reject inactive or disabled user profiles with 403 ACCOUNT_INACTIVE", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer valid_token_inactive");

    expect(res.status).to.equal(403);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("ACCOUNT_INACTIVE");
  });

  it("Should authenticate valid user and attach verified profile to request object", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer valid_token_farmer");

    expect(res.status).to.equal(200);
    expect(res.body.success).to.be.true;
    expect(res.body.user).to.deep.include({
      uid: "user_farmer_1",
      email: "farmer@agritrace.org",
      role: "FARMER",
      walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      isActive: true,
    });
  });

  it("Should return sanitized user profile from GET /api/v1/auth/me without leaking private secrets", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer valid_token_farmer");

    expect(res.status).to.equal(200);
    expect(res.body.success).to.be.true;

    const data = res.body.data;
    expect(data.uid).to.equal("user_farmer_1");
    expect(data.email).to.equal("farmer@agritrace.org");
    expect(data.displayName).to.equal("Ramesh Farmer");
    expect(data.role).to.equal("FARMER");
    expect(data.walletAddress).to.equal("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(data.organization).to.deep.equal({ name: "Sahyadri FPC" });
    expect(data.isActive).to.be.true;

    // Must not leak passwords or internal hashes
    expect(data).to.not.have.property("password");
    expect(data).to.not.have.property("privateKey");
    expect(data).to.not.have.property("secret");
  });

  it("Should never trust client-supplied uid or role in request body to spoof identity", async () => {
    const res = await request(app)
      .get("/api/v1/protected-test")
      .set("Authorization", "Bearer valid_token_farmer")
      .send({ uid: "spoofed_admin", role: "ADMIN" });

    expect(res.status).to.equal(200);
    // Verified user must remain the token's authenticated farmer
    expect(res.body.user.uid).to.equal("user_farmer_1");
    expect(res.body.user.role).to.equal("FARMER");
  });

  describe("Wallet Endpoint Authentication Safeguards", () => {
    it("Should require valid authentication for POST /api/v1/auth/wallet/challenge", async () => {
      const res = await request(app)
        .post("/api/v1/auth/wallet/challenge")
        .send({ walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });

      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal("AUTH_HEADER_MISSING");
    });

    it("Should require valid authentication for POST /api/v1/auth/wallet/verify", async () => {
      const res = await request(app)
        .post("/api/v1/auth/wallet/verify")
        .send({ challengeId: "some-id", signature: "0x1234" });

      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal("AUTH_HEADER_MISSING");
    });
  });
});
