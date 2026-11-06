const { expect } = require("chai");
const request = require("supertest");
const app = require("../src/app");
const { createApp } = require("../src/app");
const { env } = require("../src/config/env");

describe("API Health Endpoint (GET /api/v1/health)", () => {
  describe("Development / Test Diagnostic Response", () => {
    it("Should return 200 OK with healthy status and detailed diagnostics", async () => {
      const res = await request(app).get("/api/v1/health");

      expect(res.status).to.equal(200);
      expect(res.body).to.be.an("object");
      expect(res.body.success).to.be.true;

      const data = res.body.data;
      expect(data.status).to.equal("healthy");
      expect(data.timestamp).to.be.a("string");
      expect(data.uptimeSeconds).to.be.a("number");
      expect(data.environment).to.be.oneOf(["development", "test"]);
      expect(data.version).to.equal("1.0.0");

      // Verify service statuses report 'configured' (not 'connected' without live probe)
      expect(data.services).to.be.an("object");
      expect(data.services.firebase.status).to.equal("configured");
      expect(data.services.firebase.projectId).to.be.oneOf(["agritrace-test", "agritrace-local"]);
      expect(data.services.firebase.emulatorMode).to.be.true;
      expect(data.services.blockchain).to.deep.include({
        status: "configured",
        chainId: 31337,
        contractConfigured: true,
        rpcConfigured: true,
      });
    });

    it("Should not expose sensitive credentials, private keys, or passwords in dev response", async () => {
      const res = await request(app).get("/api/v1/health");
      const rawBody = JSON.stringify(res.body).toLowerCase();

      expect(rawBody).to.not.include("privatekey");
      expect(rawBody).to.not.include("private_key");
      expect(rawBody).to.not.include("secret");
      expect(rawBody).to.not.include("password");
      expect(rawBody).to.not.include("token");
    });
  });

  describe("Production General Service Health (Zero Infrastructure Leak)", () => {
    let prodApp;

    before(() => {
      prodApp = createApp({
        ...env,
        NODE_ENV: "production",
        CORS_ORIGIN: "https://app.agritrace.io",
      });
    });

    it("Should return 200 OK with general status and without internal infrastructure details", async () => {
      const res = await request(prodApp).get("/api/v1/health");

      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;

      const data = res.body.data;
      expect(data.status).to.equal("healthy");
      expect(data.timestamp).to.be.a("string");
      expect(data.uptimeSeconds).to.be.a("number");
      expect(data.version).to.equal("1.0.0");

      // Services only expose high-level configured status
      expect(data.services.firebase).to.deep.equal({
        status: "configured",
      });
      expect(data.services.blockchain).to.deep.equal({
        status: "configured",
      });

      // Strictly assert internal infrastructure details are NOT exposed
      expect(data).to.not.have.property("environment");
      expect(data.services.firebase).to.not.have.property("projectId");
      expect(data.services.firebase).to.not.have.property("emulatorMode");
      expect(data.services.firebase).to.not.have.property("emulators");
      expect(data.services.blockchain).to.not.have.property("chainId");
      expect(data.services.blockchain).to.not.have.property("rpcUrl");
      expect(data.services.blockchain).to.not.have.property("contractAddress");
      expect(data.services.blockchain).to.not.have.property("contractConfigured");
      expect(data.services.blockchain).to.not.have.property("rpcConfigured");
    });
  });

  describe("Service Degradation Handling (Distinguishing 'unavailable')", () => {
    it("Should return 503 with degraded status when a required service is unconfigured", async () => {
      const degradedApp = createApp({
        ...env,
        AGRITRACE_CONTRACT_ADDRESS: "", // Missing contract address
      });

      const res = await request(degradedApp).get("/api/v1/health");

      expect(res.status).to.equal(503);
      expect(res.body.success).to.be.false;
      expect(res.body.data.status).to.equal("degraded");
      expect(res.body.data.services.blockchain.status).to.equal("unavailable");
      expect(res.body.data.services.firebase.status).to.equal("configured");
    });
  });

  describe("Root Endpoint", () => {
    it("Should return welcome message at root GET /", async () => {
      const res = await request(app).get("/");
      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.message).to.include("AgriTrace REST API is running");
    });
  });
});
