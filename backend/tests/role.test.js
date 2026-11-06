const { expect } = require("chai");
const request = require("supertest");
const express = require("express");
const { ethers } = require("ethers");
const {
  requireRole,
  requireOnChainRole,
  ROLES,
  CONTRACT_ROLES,
} = require("../src/middleware/role.middleware");
const { errorHandler } = require("../src/middleware/error.middleware");

describe("Role-Based Authorization & On-Chain Preflight Middleware", () => {
  let app;
  let mockContract;
  const farmerWallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const unprivilegedWallet = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  beforeEach(() => {
    mockContract = {
      hasRole: async (roleBytes, account) => {
        // Mock on-chain permissions
        if (
          roleBytes === CONTRACT_ROLES.FARMER &&
          account.toLowerCase() === farmerWallet.toLowerCase()
        ) {
          return true;
        }
        if (
          roleBytes === CONTRACT_ROLES.ADMIN &&
          account.toLowerCase() === farmerWallet.toLowerCase()
        ) {
          return true;
        }
        return false;
      },
    };

    app = express();
    app.use(express.json());

    // Middleware injecting simulated authenticated user for testing
    let currentUser = null;
    app.use((req, res, next) => {
      req.user = currentUser;
      next();
    });

    app.set("setCurrentUser", (user) => {
      currentUser = user;
    });

    // Test routes enforcing Firestore application roles
    app.get("/api/v1/farmer-only", requireRole(ROLES.FARMER), (req, res) => {
      res.status(200).json({ success: true, message: "Welcome Farmer" });
    });

    app.get("/api/v1/inspector-only", requireRole(ROLES.INSPECTOR), (req, res) => {
      res.status(200).json({ success: true, message: "Welcome Inspector" });
    });

    app.get(
      "/api/v1/farmer-or-admin",
      requireRole([ROLES.FARMER, ROLES.ADMIN]),
      (req, res) => {
        res.status(200).json({ success: true, message: "Welcome Farmer or Admin" });
      }
    );

    // Test route enforcing on-chain smart contract role preflight
    app.get(
      "/api/v1/on-chain-farmer-preflight",
      requireRole(ROLES.FARMER),
      (req, res, next) => {
        requireOnChainRole(ROLES.FARMER, { contract: mockContract })(req, res, next);
      },
      (req, res) => {
        res.status(200).json({ success: true, message: "On-chain role confirmed" });
      }
    );

    app.use(errorHandler);
  });

  describe("Solidity Role Identifier Verification", () => {
    it("Should compute role identifiers matching the AgriTrace.sol smart contract constants", () => {
      expect(CONTRACT_ROLES.FARMER).to.equal(ethers.id("FARMER_ROLE"));
      expect(CONTRACT_ROLES.INSPECTOR).to.equal(ethers.id("INSPECTOR_ROLE"));
      expect(CONTRACT_ROLES.TRANSPORTER).to.equal(ethers.id("TRANSPORTER_ROLE"));
      expect(CONTRACT_ROLES.WAREHOUSE).to.equal(ethers.id("WAREHOUSE_ROLE"));
      expect(CONTRACT_ROLES.RETAILER).to.equal(ethers.id("RETAILER_ROLE"));
      expect(CONTRACT_ROLES.ADMIN).to.equal(ethers.ZeroHash); // OpenZeppelin DEFAULT_ADMIN_ROLE (0x00...00)
    });
  });

  describe("Firestore Business Role Authorization (requireRole)", () => {
    it("Should allow access when user profile possesses the required role", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_1",
        role: ROLES.FARMER,
        isActive: true,
      });

      const res = await request(app).get("/api/v1/farmer-only");
      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
    });

    it("Should reject access when user profile does not have an assigned role", async () => {
      app.get("setCurrentUser")({
        uid: "usr_no_role",
        role: null,
        isActive: true,
      });

      const res = await request(app).get("/api/v1/farmer-only");
      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("ROLE_UNAUTHORIZED");
    });

    it("Should reject access with 403 ROLE_FORBIDDEN when user has an incorrect role", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_1",
        role: ROLES.FARMER,
        isActive: true,
      });

      // Farmer attempts to access Inspector-only endpoint
      const res = await request(app).get("/api/v1/inspector-only");
      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("ROLE_FORBIDDEN");
      expect(res.body.error.message).to.include("Requires one of [INSPECTOR]");
    });

    it("Should reject access when user account is inactive", async () => {
      app.get("setCurrentUser")({
        uid: "usr_disabled",
        role: ROLES.FARMER,
        isActive: false,
      });

      const res = await request(app).get("/api/v1/farmer-only");
      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("ACCOUNT_INACTIVE");
    });

    it("Should prevent privilege escalation when user submits privileged role in request body", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_1",
        role: ROLES.FARMER,
        isActive: true,
      });

      // User attempts to inject role: "INSPECTOR" or "ADMIN" in request body
      const res = await request(app)
        .get("/api/v1/inspector-only")
        .send({ role: "INSPECTOR" });

      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal("ROLE_FORBIDDEN");
    });

    it("Should support multi-role authorized endpoints", async () => {
      // Farmer access
      app.get("setCurrentUser")({
        uid: "usr_farmer_1",
        role: ROLES.FARMER,
        isActive: true,
      });
      const res1 = await request(app).get("/api/v1/farmer-or-admin");
      expect(res1.status).to.equal(200);

      // Admin access
      app.get("setCurrentUser")({
        uid: "usr_admin_1",
        role: ROLES.ADMIN,
        isActive: true,
      });
      const res2 = await request(app).get("/api/v1/farmer-or-admin");
      expect(res2.status).to.equal(200);

      // Transporter access (rejected)
      app.get("setCurrentUser")({
        uid: "usr_transporter_1",
        role: ROLES.TRANSPORTER,
        isActive: true,
      });
      const res3 = await request(app).get("/api/v1/farmer-or-admin");
      expect(res3.status).to.equal(403);
      expect(res3.body.error.code).to.equal("ROLE_FORBIDDEN");
    });
  });

  describe("On-Chain Role Preflight Middleware (requireOnChainRole)", () => {
    it("Should allow access when linked wallet possesses required on-chain role", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_1",
        role: ROLES.FARMER,
        walletAddress: farmerWallet,
        isActive: true,
      });

      const res = await request(app).get("/api/v1/on-chain-farmer-preflight");
      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.message).to.equal("On-chain role confirmed");
    });

    it("Should reject access with 403 WALLET_NOT_LINKED if user has no linked wallet", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_no_wallet",
        role: ROLES.FARMER,
        walletAddress: null,
        isActive: true,
      });

      const res = await request(app).get("/api/v1/on-chain-farmer-preflight");
      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("WALLET_NOT_LINKED");
    });

    it("Should reject access with 403 ON_CHAIN_ROLE_UNAUTHORIZED if wallet lacks on-chain role", async () => {
      app.get("setCurrentUser")({
        uid: "usr_farmer_unassigned",
        role: ROLES.FARMER,
        walletAddress: unprivilegedWallet,
        isActive: true,
      });

      const res = await request(app).get("/api/v1/on-chain-farmer-preflight");
      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("ON_CHAIN_ROLE_UNAUTHORIZED");
      expect(res.body.error.message).to.include("does not possess required on-chain role");
    });

    it("Should handle unavailable blockchain RPC by returning HTTP 503 without failing open", async () => {
      // Mock contract throwing an RPC network failure
      const failingContract = {
        hasRole: async () => {
          const rpcError = new Error("ECONNREFUSED 127.0.0.1:8545");
          rpcError.code = "SERVER_ERROR";
          throw rpcError;
        },
      };

      const customApp = express();
      customApp.use((req, res, next) => {
        req.user = {
          uid: "usr_farmer_1",
          role: ROLES.FARMER,
          walletAddress: farmerWallet,
          isActive: true,
        };
        next();
      });

      customApp.get(
        "/api/v1/rpc-fail-test",
        requireOnChainRole(ROLES.FARMER, { contract: failingContract }),
        (req, res) => res.status(200).json({ success: true })
      );

      const res = await request(customApp).get("/api/v1/rpc-fail-test");
      expect(res.status).to.equal(503);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("BLOCKCHAIN_UNAVAILABLE");
    });
  });
});

