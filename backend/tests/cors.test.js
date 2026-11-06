const { expect } = require("chai");
const request = require("supertest");
const { createApp } = require("../src/app");
const { env } = require("../src/config/env");
const { getAllowedOrigins, createCorsOptions } = require("../src/config/cors");

describe("CORS Allowlist and Origin Authorization", () => {
  describe("Unit: getAllowedOrigins and createCorsOptions", () => {
    it("Should parse comma-separated origin strings into an array of trimmed origins", () => {
      const origins = getAllowedOrigins(
        "http://localhost:3000, https://agritrace.io , http://127.0.0.1:8080"
      );
      expect(origins).to.deep.equal([
        "http://localhost:3000",
        "https://agritrace.io",
        "http://127.0.0.1:8080",
      ]);
    });

    it("Should safely return empty array for empty, undefined, or null input", () => {
      expect(getAllowedOrigins("")).to.deep.equal([]);
      expect(getAllowedOrigins(undefined)).to.deep.equal([]);
      expect(getAllowedOrigins(null)).to.deep.equal([]);
    });
  });

  describe("Integration: Configured Origin Handling", () => {
    let corsApp;

    before(() => {
      corsApp = createApp({
        ...env,
        CORS_ORIGIN: "http://localhost:3000,https://app.agritrace.io",
      });
    });

    it("Should permit requests from configured origin and return matching Access-Control-Allow-Origin", async () => {
      const res = await request(corsApp)
        .get("/api/v1/health")
        .set("Origin", "http://localhost:3000");

      expect(res.status).to.equal(200);
      expect(res.headers["access-control-allow-origin"]).to.equal("http://localhost:3000");
      expect(res.headers["access-control-allow-credentials"]).to.equal("true");
    });

    it("Should permit requests from secondary configured origin in multi-origin list", async () => {
      const res = await request(corsApp)
        .get("/api/v1/health")
        .set("Origin", "https://app.agritrace.io");

      expect(res.status).to.equal(200);
      expect(res.headers["access-control-allow-origin"]).to.equal("https://app.agritrace.io");
      expect(res.headers["access-control-allow-credentials"]).to.equal("true");
    });

    it("Should properly respond to preflight OPTIONS request for configured origin", async () => {
      const res = await request(corsApp)
        .options("/api/v1/health")
        .set("Origin", "http://localhost:3000")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "Content-Type,Authorization");

      expect(res.status).to.be.oneOf([200, 204]);
      expect(res.headers["access-control-allow-origin"]).to.equal("http://localhost:3000");
      expect(res.headers["access-control-allow-credentials"]).to.equal("true");
    });

    it("Should reject unauthorized origins with HTTP 403 Forbidden and structured CORS error", async () => {
      const res = await request(corsApp)
        .get("/api/v1/health")
        .set("Origin", "http://malicious-attacker.com");

      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("CORS_ORIGIN_FORBIDDEN");
      expect(res.body.error.message).to.include("not authorized by CORS policy");
      // Must NOT echo back the unauthorized origin header
      expect(res.headers["access-control-allow-origin"]).to.be.undefined;
    });

    it("Should reject unauthorized origin during preflight OPTIONS request", async () => {
      const res = await request(corsApp)
        .options("/api/v1/health")
        .set("Origin", "http://malicious-attacker.com")
        .set("Access-Control-Request-Method", "POST");

      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("CORS_ORIGIN_FORBIDDEN");
      expect(res.headers["access-control-allow-origin"]).to.be.undefined;
    });

    it("Should permit non-browser requests without Origin header (Flutter mobile apps, curl, server-to-server)", async () => {
      const res = await request(corsApp).get("/api/v1/health");

      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
    });
  });

  describe("Integration: Safe Handling of Missing / Empty CORS Configuration", () => {
    let unconfiguredCorsApp;

    before(() => {
      unconfiguredCorsApp = createApp({
        ...env,
        CORS_ORIGIN: "", // Empty CORS origin
      });
    });

    it("Should permit non-origin mobile/backend requests when CORS_ORIGIN is empty", async () => {
      const res = await request(unconfiguredCorsApp).get("/api/v1/health");

      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
    });

    it("Should safely reject all browser cross-origin requests when CORS_ORIGIN is empty", async () => {
      const res = await request(unconfiguredCorsApp)
        .get("/api/v1/health")
        .set("Origin", "http://localhost:3000");

      expect(res.status).to.equal(403);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("CORS_ORIGIN_FORBIDDEN");
      expect(res.headers["access-control-allow-origin"]).to.be.undefined;
    });
  });
});

