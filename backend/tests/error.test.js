const { expect } = require("chai");
const request = require("supertest");
const app = require("../src/app");

describe("Express Error Handling & 404 Routing", () => {
  it("Should return 404 with standardized error envelope for unknown routes", async () => {
    const res = await request(app).get("/api/v1/non-existent-route");

    expect(res.status).to.equal(404);
    expect(res.body).to.deep.include({
      success: false,
    });
    expect(res.body.error).to.be.an("object");
    expect(res.body.error.code).to.equal("NOT_FOUND");
    expect(res.body.error.message).to.include("Endpoint not found: GET /api/v1/non-existent-route");
  });

  it("Should return 400 with INVALID_JSON code for malformed JSON bodies", async () => {
    const res = await request(app)
      .post("/api/v1/health")
      .set("Content-Type", "application/json")
      .send('{"malformed": "json'); // intentionally truncated JSON

    expect(res.status).to.equal(400);
    expect(res.body.success).to.be.false;
    expect(res.body.error.code).to.equal("INVALID_JSON");
    expect(res.body.error.message).to.equal("Malformed JSON payload");
  });
});

