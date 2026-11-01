const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgriTrace Smart Contract", function () {
  let agriTrace;
  let admin, farmer, inspector, transporter, warehouse, retailer, unauthorized, consumer;

  let FARMER_ROLE;
  let INSPECTOR_ROLE;
  let TRANSPORTER_ROLE;
  let WAREHOUSE_ROLE;
  let RETAILER_ROLE;
  let DEFAULT_ADMIN_ROLE;

  const sampleBatchId = ethers.keccak256(ethers.toUtf8Bytes("BATCH-2026-TOMATO-001"));
  const sampleMetadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    category: "Fresh Produce",
    cropVariety: "Roma Tomato",
    harvestDate: "2026-11-01T10:00:00Z",
    humanBatchId: "BATCH-2026-TOMATO-001",
    origin: "Green Valley Farm",
    quantity: 1500,
    unit: "kg"
  })));
  const sampleReportHash = ethers.keccak256(ethers.toUtf8Bytes("QUALITY_REPORT_PASS_GRADE_A"));
  const sampleHandoverHash1 = ethers.keccak256(ethers.toUtf8Bytes("HANDOVER_FARMER_TO_TRANSPORTER_BOL_001"));
  const sampleHandoverHash2 = ethers.keccak256(ethers.toUtf8Bytes("HANDOVER_TRANSPORTER_TO_WAREHOUSE_BOL_002"));
  const sampleHandoverHash3 = ethers.keccak256(ethers.toUtf8Bytes("HANDOVER_WAREHOUSE_TO_RETAILER_BOL_003"));
  const sampleMilestoneHash = ethers.keccak256(ethers.toUtf8Bytes("COLD_CHAIN_LOG_4C_GPS_POINT_12"));
  const sampleAcceptanceHash = ethers.keccak256(ethers.toUtf8Bytes("PHYSICAL_INSPECTION_RECEIPT_CONFIRMED"));

  // BatchStatus Enum mapping
  const BatchStatus = {
    CREATED: 0,
    QUALITY_VERIFIED: 1,
    QUALITY_REJECTED: 2,
    IN_TRANSIT: 3,
    AT_WAREHOUSE: 4,
    AT_RETAILER: 5,
    DELIVERED: 6
  };

  beforeEach(async function () {
    [admin, farmer, inspector, transporter, warehouse, retailer, unauthorized, consumer] =
      await ethers.getSigners();

    const AgriTraceFactory = await ethers.getContractFactory("AgriTrace");
    agriTrace = await AgriTraceFactory.deploy();
    await agriTrace.waitForDeployment();

    FARMER_ROLE = await agriTrace.FARMER_ROLE();
    INSPECTOR_ROLE = await agriTrace.INSPECTOR_ROLE();
    TRANSPORTER_ROLE = await agriTrace.TRANSPORTER_ROLE();
    WAREHOUSE_ROLE = await agriTrace.WAREHOUSE_ROLE();
    RETAILER_ROLE = await agriTrace.RETAILER_ROLE();
    DEFAULT_ADMIN_ROLE = await agriTrace.DEFAULT_ADMIN_ROLE();

    // Assign roles to mock supply chain participants
    await agriTrace.connect(admin).grantRole(FARMER_ROLE, farmer.address);
    await agriTrace.connect(admin).grantRole(INSPECTOR_ROLE, inspector.address);
    await agriTrace.connect(admin).grantRole(TRANSPORTER_ROLE, transporter.address);
    await agriTrace.connect(admin).grantRole(WAREHOUSE_ROLE, warehouse.address);
    await agriTrace.connect(admin).grantRole(RETAILER_ROLE, retailer.address);
  });

  // =========================================================================
  // 1. Contract Deployment & Role Management
  // =========================================================================

  describe("Contract Deployment & Role Management", function () {
    it("Should deploy and grant DEFAULT_ADMIN_ROLE to deployer", async function () {
      expect(await agriTrace.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await agriTrace.hasRole(DEFAULT_ADMIN_ROLE, unauthorized.address)).to.be.false;
    });

    it("Should expose valid public constants for all roles", async function () {
      expect(FARMER_ROLE).to.equal(ethers.keccak256(ethers.toUtf8Bytes("FARMER_ROLE")));
      expect(INSPECTOR_ROLE).to.equal(ethers.keccak256(ethers.toUtf8Bytes("INSPECTOR_ROLE")));
      expect(TRANSPORTER_ROLE).to.equal(ethers.keccak256(ethers.toUtf8Bytes("TRANSPORTER_ROLE")));
      expect(WAREHOUSE_ROLE).to.equal(ethers.keccak256(ethers.toUtf8Bytes("WAREHOUSE_ROLE")));
      expect(RETAILER_ROLE).to.equal(ethers.keccak256(ethers.toUtf8Bytes("RETAILER_ROLE")));
    });

    it("Should allow admin to grant and revoke roles", async function () {
      const newFarmer = unauthorized;
      expect(await agriTrace.hasRole(FARMER_ROLE, newFarmer.address)).to.be.false;

      await agriTrace.connect(admin).grantRole(FARMER_ROLE, newFarmer.address);
      expect(await agriTrace.hasRole(FARMER_ROLE, newFarmer.address)).to.be.true;

      await agriTrace.connect(admin).revokeRole(FARMER_ROLE, newFarmer.address);
      expect(await agriTrace.hasRole(FARMER_ROLE, newFarmer.address)).to.be.false;
    });

    it("Should prevent non-admin from granting roles", async function () {
      await expect(
        agriTrace.connect(unauthorized).grantRole(FARMER_ROLE, unauthorized.address)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");
    });
  });

  // =========================================================================
  // 2. Batch Creation & Duplicate Batch Rejection
  // =========================================================================

  describe("Batch Creation", function () {
    it("Should allow an authorized farmer to create a batch and emit BatchCreated", async function () {
      const tx = await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "BatchCreated")
        .withArgs(sampleBatchId, farmer.address, sampleMetadataHash, block.timestamp);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.batchId).to.equal(sampleBatchId);
      expect(batch.farmer).to.equal(farmer.address);
      expect(batch.currentCustodian).to.equal(farmer.address);
      expect(batch.status).to.equal(BatchStatus.CREATED);
      expect(batch.createdAt).to.equal(block.timestamp);
      expect(batch.metadataHash).to.equal(sampleMetadataHash);

      expect(await agriTrace.batchExists(sampleBatchId)).to.be.true;
      expect(await agriTrace.getBatchCount()).to.equal(1);
      const allIds = await agriTrace.getAllBatchIds();
      expect(allIds[0]).to.equal(sampleBatchId);
    });

    it("Should reject batch creation by unauthorized account", async function () {
      await expect(
        agriTrace.connect(unauthorized).createBatch(sampleBatchId, sampleMetadataHash)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");
    });

    it("Should reject batch creation with invalid batchId", async function () {
      await expect(
        agriTrace.connect(farmer).createBatch(ethers.ZeroHash, sampleMetadataHash)
      ).to.be.revertedWith("Invalid batch ID");
    });

    it("Should reject batch creation with invalid metadataHash", async function () {
      await expect(
        agriTrace.connect(farmer).createBatch(sampleBatchId, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid metadata hash");
    });

    it("Should reject duplicate batch registration", async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);

      await expect(
        agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash)
      ).to.be.revertedWith("Batch already exists");
    });
  });

  // =========================================================================
  // 3. Quality Verification & Rejection
  // =========================================================================

  describe("Quality Verification and Rejection", function () {
    beforeEach(async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
    });

    it("Should allow inspector to approve quality and emit QualityAuditCompleted", async function () {
      const tx = await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "QualityAuditCompleted")
        .withArgs(sampleBatchId, inspector.address, true, sampleReportHash, block.timestamp);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.QUALITY_VERIFIED);
    });

    it("Should allow inspector to reject quality and set terminal state QUALITY_REJECTED", async function () {
      const tx = await agriTrace.connect(inspector).verifyQuality(sampleBatchId, false, sampleReportHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "QualityAuditCompleted")
        .withArgs(sampleBatchId, inspector.address, false, sampleReportHash, block.timestamp);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.QUALITY_REJECTED);
    });

    it("Should prevent non-inspector from verifying quality", async function () {
      await expect(
        agriTrace.connect(unauthorized).verifyQuality(sampleBatchId, true, sampleReportHash)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");
    });

    it("Should reject quality verification on non-existent batch", async function () {
      const nonExistentBatch = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT"));
      await expect(
        agriTrace.connect(inspector).verifyQuality(nonExistentBatch, true, sampleReportHash)
      ).to.be.revertedWith("Batch does not exist");
    });

    it("Should reject quality verification with zero reportHash", async function () {
      await expect(
        agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid report hash");
    });

    it("Should prevent re-verifying a batch that has already been verified", async function () {
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);

      await expect(
        agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash)
      ).to.be.revertedWith("Batch not awaiting inspection");
    });
  });

  // =========================================================================
  // 4. Custody Transfer & Acceptance
  // =========================================================================

  describe("Custody Transfer & Acceptance", function () {
    beforeEach(async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
    });

    it("Should directly transfer custody from farmer to transporter", async function () {
      const tx = await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "CustodyTransferred")
        .withArgs(
          sampleBatchId,
          farmer.address,
          transporter.address,
          BatchStatus.IN_TRANSIT,
          sampleHandoverHash1,
          block.timestamp
        );

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.currentCustodian).to.equal(transporter.address);
      expect(batch.status).to.equal(BatchStatus.IN_TRANSIT);
    });

    it("Should reject acceptCustody when no pending transfer exists (direct transfer does not require acceptance)", async function () {
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      await expect(
        agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("No active pending transfer");
    });

    it("Should support two-step custody transfer (initiate -> accept)", async function () {
      // 1. Farmer initiates custody transfer
      const initTx = await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      const initReceipt = await initTx.wait();
      const initBlock = await ethers.provider.getBlock(initReceipt.blockNumber);

      await expect(initTx)
        .to.emit(agriTrace, "CustodyTransferInitiated")
        .withArgs(
          sampleBatchId,
          farmer.address,
          transporter.address,
          BatchStatus.IN_TRANSIT,
          sampleHandoverHash1,
          initBlock.timestamp
        );

      const pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.newCustodian).to.equal(transporter.address);
      expect(pending.targetStatus).to.equal(BatchStatus.IN_TRANSIT);
      expect(pending.handoverHash).to.equal(sampleHandoverHash1);
      expect(pending.active).to.be.true;

      // 2. Unauthorized caller cannot accept
      await expect(
        agriTrace.connect(unauthorized).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Caller is not designated custodian");

      // 3. Designated transporter accepts custody
      const acceptTx = await agriTrace
        .connect(transporter)
        .acceptCustody(sampleBatchId, sampleAcceptanceHash);

      const acceptReceipt = await acceptTx.wait();
      const acceptBlock = await ethers.provider.getBlock(acceptReceipt.blockNumber);

      await expect(acceptTx)
        .to.emit(agriTrace, "CustodyTransferred")
        .withArgs(
          sampleBatchId,
          farmer.address,
          transporter.address,
          BatchStatus.IN_TRANSIT,
          sampleHandoverHash1,
          acceptBlock.timestamp
        );

      await expect(acceptTx)
        .to.emit(agriTrace, "CustodyAccepted")
        .withArgs(
          sampleBatchId,
          transporter.address,
          BatchStatus.IN_TRANSIT,
          sampleAcceptanceHash,
          acceptBlock.timestamp
        );

      // Verify batch state updated
      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.currentCustodian).to.equal(transporter.address);
      expect(batch.status).to.equal(BatchStatus.IN_TRANSIT);

      // Verify pending transfer is cleared
      const clearedPending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(clearedPending.active).to.be.false;
    });

    it("Should reject custody transfer by non-custodian", async function () {
      await expect(
        agriTrace
          .connect(unauthorized)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("Should reject custody transfer to address(0)", async function () {
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, ethers.ZeroAddress, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid recipient address");
    });

    it("Should reject custody transfer to self", async function () {
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, farmer.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Cannot transfer custody to self");
    });

    it("Should reject custody transfer to recipient lacking required role", async function () {
      // Transfer to warehouse directly when in QUALITY_VERIFIED (should go to transporter)
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, warehouse.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Recipient lacks TRANSPORTER_ROLE");
    });

    it("Should reject acceptCustody when no pending transfer exists", async function () {
      await expect(
        agriTrace.connect(unauthorized).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("No active pending transfer");
    });
  });

  // =========================================================================
  // 5. Lifecycle Transitions & State Constraints
  // =========================================================================

  describe("Lifecycle Transitions and Constraints", function () {
    it("Should reject custody transfer if batch is still in CREATED state", async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);

      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");
    });

    it("Should reject stage skipping (e.g., QUALITY_VERIFIED directly to AT_WAREHOUSE)", async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);

      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2)
      ).to.be.revertedWith("Invalid status transition: expected IN_TRANSIT");
    });

    it("Should prevent transferring a QUALITY_REJECTED batch", async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, false, sampleReportHash);

      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");
    });

    it("Should prevent transferring an already DELIVERED batch", async function () {
      // Fast-forward to DELIVERED
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
      await agriTrace.connect(farmer).transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);
      await agriTrace.connect(transporter).transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);
      await agriTrace.connect(warehouse).transferCustody(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);
      await agriTrace.connect(retailer).completeDelivery(sampleBatchId);

      await expect(
        agriTrace
          .connect(retailer)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");
    });
  });

  // =========================================================================
  // 6. Milestone Recording
  // =========================================================================

  describe("Milestone Recording", function () {
    beforeEach(async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);
    });

    it("Should allow current custodian to log milestone and emit MilestoneLogged", async function () {
      const action = "GPS Waypoint: Transit Hub Alpha, Temp: 4C";
      const tx = await agriTrace.connect(transporter).logMilestone(sampleBatchId, action, sampleMilestoneHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "MilestoneLogged")
        .withArgs(sampleBatchId, transporter.address, action, sampleMilestoneHash, block.timestamp);

      expect(await agriTrace.getMilestoneCount(sampleBatchId)).to.equal(1);
      const milestone = await agriTrace.getMilestone(sampleBatchId, 0);
      expect(milestone.actor).to.equal(transporter.address);
      expect(milestone.action).to.equal(action);
      expect(milestone.milestoneHash).to.equal(sampleMilestoneHash);
      expect(milestone.timestamp).to.equal(block.timestamp);

      const allMilestones = await agriTrace.getMilestones(sampleBatchId);
      expect(allMilestones.length).to.equal(1);
      expect(allMilestones[0].action).to.equal(action);
    });

    it("Should reject milestone logging by non-custodian", async function () {
      await expect(
        agriTrace
          .connect(farmer)
          .logMilestone(sampleBatchId, "Farmer attempting unauthorized log", sampleMilestoneHash)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("Should reject milestone logging with empty action", async function () {
      await expect(
        agriTrace.connect(transporter).logMilestone(sampleBatchId, "", sampleMilestoneHash)
      ).to.be.revertedWith("Action description required");
    });

    it("Should reject milestone logging with zero milestoneHash", async function () {
      await expect(
        agriTrace.connect(transporter).logMilestone(sampleBatchId, "Action", ethers.ZeroHash)
      ).to.be.revertedWith("Invalid milestone hash");
    });

    it("Should reject milestone logging on terminated batch (QUALITY_REJECTED)", async function () {
      const rejectedBatchId = ethers.keccak256(ethers.toUtf8Bytes("BATCH-REJECTED"));
      await agriTrace.connect(farmer).createBatch(rejectedBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(rejectedBatchId, false, sampleReportHash);

      await expect(
        agriTrace.connect(farmer).logMilestone(rejectedBatchId, "Action", sampleMilestoneHash)
      ).to.be.revertedWith("Cannot log milestone on terminated batch");
    });
  });

  // =========================================================================
  // 7. Delivery Completion
  // =========================================================================

  describe("Delivery Completion", function () {
    beforeEach(async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);
      await agriTrace
        .connect(transporter)
        .transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);
      await agriTrace
        .connect(warehouse)
        .transferCustody(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);
    });

    it("Should allow retailer to complete delivery and emit BatchDelivered", async function () {
      const tx = await agriTrace.connect(retailer).completeDelivery(sampleBatchId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "BatchDelivered")
        .withArgs(sampleBatchId, retailer.address, block.timestamp);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.DELIVERED);
    });

    it("Should prevent non-retailer from completing delivery", async function () {
      await expect(
        agriTrace.connect(unauthorized).completeDelivery(sampleBatchId)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("Should prevent completing delivery if batch is not in AT_RETAILER state", async function () {
      const earlyBatchId = ethers.keccak256(ethers.toUtf8Bytes("BATCH-EARLY"));
      await agriTrace.connect(farmer).createBatch(earlyBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(earlyBatchId, true, sampleReportHash);

      await expect(
        agriTrace.connect(retailer).completeDelivery(earlyBatchId)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("Should prevent completing delivery twice", async function () {
      await agriTrace.connect(retailer).completeDelivery(sampleBatchId);

      await expect(
        agriTrace.connect(retailer).completeDelivery(sampleBatchId)
      ).to.be.revertedWith("Batch not at retailer");
    });
  });

  // =========================================================================
  // 8. Batch History & Query Views
  // =========================================================================

  describe("Batch History & Query Views", function () {
    it("Should revert getBatch on non-existent batch", async function () {
      const nonExistentId = ethers.keccak256(ethers.toUtf8Bytes("DOES_NOT_EXIST"));
      await expect(agriTrace.getBatch(nonExistentId)).to.be.revertedWith("Batch does not exist");
      expect(await agriTrace.batchExists(nonExistentId)).to.be.false;
    });

    it("Should revert getMilestones on non-existent batch", async function () {
      const nonExistentId = ethers.keccak256(ethers.toUtf8Bytes("DOES_NOT_EXIST"));
      await expect(agriTrace.getMilestones(nonExistentId)).to.be.revertedWith("Batch does not exist");
      await expect(agriTrace.getMilestoneCount(nonExistentId)).to.be.revertedWith("Batch does not exist");
      await expect(agriTrace.getMilestone(nonExistentId, 0)).to.be.revertedWith("Batch does not exist");
    });

    it("Should revert getMilestone if index is out of bounds", async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await expect(
        agriTrace.getMilestone(sampleBatchId, 0)
      ).to.be.revertedWith("Milestone index out of bounds");
    });

    it("Should accurately track multiple batches across the system", async function () {
      const batch1 = ethers.keccak256(ethers.toUtf8Bytes("BATCH-001"));
      const batch2 = ethers.keccak256(ethers.toUtf8Bytes("BATCH-002"));

      await agriTrace.connect(farmer).createBatch(batch1, sampleMetadataHash);
      await agriTrace.connect(farmer).createBatch(batch2, sampleMetadataHash);

      expect(await agriTrace.getBatchCount()).to.equal(2);
      const allIds = await agriTrace.getAllBatchIds();
      expect(allIds).to.deep.equal([batch1, batch2]);
    });
  });

  // =========================================================================
  // 9. Full End-to-End Lifecycle Scenario
  // =========================================================================

  describe("Full End-to-End Supply Chain Lifecycle", function () {
    it("Should successfully trace produce through entire lifecycle: Farmer -> Inspector -> Transporter -> Warehouse -> Retailer -> Consumer", async function () {
      // 1. Farmer creates batch
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      let batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.CREATED);
      expect(batch.currentCustodian).to.equal(farmer.address);

      // Farmer logs harvest milestone
      await agriTrace
        .connect(farmer)
        .logMilestone(sampleBatchId, "Harvest completed and crated", sampleMilestoneHash);

      // 2. Inspector verifies quality
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
      batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.QUALITY_VERIFIED);

      // 3. Farmer transfers custody to Transporter (2-step transfer)
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      await agriTrace
        .connect(transporter)
        .acceptCustody(sampleBatchId, sampleAcceptanceHash);

      batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.IN_TRANSIT);
      expect(batch.currentCustodian).to.equal(transporter.address);

      // Transporter logs cold-chain telemetry milestone
      await agriTrace
        .connect(transporter)
        .logMilestone(sampleBatchId, "Refrigerated transport: Temp steady at 4C", sampleMilestoneHash);

      // 4. Transporter transfers custody to Warehouse (direct transfer)
      await agriTrace
        .connect(transporter)
        .transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);

      batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.AT_WAREHOUSE);
      expect(batch.currentCustodian).to.equal(warehouse.address);

      // Warehouse logs sorting & storage milestone
      await agriTrace
        .connect(warehouse)
        .logMilestone(sampleBatchId, "Intake into cold room 2B; humidity 85%", sampleMilestoneHash);

      // 5. Warehouse transfers custody to Retailer
      await agriTrace
        .connect(warehouse)
        .transferCustody(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);

      batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.AT_RETAILER);
      expect(batch.currentCustodian).to.equal(retailer.address);

      // Retailer logs shelf display milestone
      await agriTrace
        .connect(retailer)
        .logMilestone(sampleBatchId, "Shelved in fresh aisle, QR code placed on shelf tag", sampleMilestoneHash);

      // 6. Retailer completes delivery upon customer purchase
      await agriTrace.connect(retailer).completeDelivery(sampleBatchId);
      batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.status).to.equal(BatchStatus.DELIVERED);

      // 7. Verify consumer / auditor can inspect complete history (read-only, zero gas)
      const verifiedBatch = await agriTrace.connect(consumer).getBatch(sampleBatchId);
      expect(verifiedBatch.farmer).to.equal(farmer.address);
      expect(verifiedBatch.metadataHash).to.equal(sampleMetadataHash);
      expect(verifiedBatch.status).to.equal(BatchStatus.DELIVERED);

      const milestones = await agriTrace.connect(consumer).getMilestones(sampleBatchId);
      expect(milestones.length).to.equal(4);
      expect(milestones[0].action).to.equal("Harvest completed and crated");
      expect(milestones[1].action).to.equal("Refrigerated transport: Temp steady at 4C");
      expect(milestones[2].action).to.equal("Intake into cold room 2B; humidity 85%");
      expect(milestones[3].action).to.equal("Shelved in fresh aisle, QR code placed on shelf tag");
    });
  });

  // =========================================================================
  // 10. Security & Threat Model Verification (Step 2D)
  // =========================================================================

  describe("Security & Threat Model Verification", function () {
    let secondTransporter;

    beforeEach(async function () {
      secondTransporter = consumer; // reuse consumer signer as second transporter
      await agriTrace.connect(admin).grantRole(TRANSPORTER_ROLE, secondTransporter.address);
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
    });

    it("1. A recipient cannot accept another user's pending transfer", async function () {
      // Transfer initiated to transporter
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // secondTransporter attempts to accept the transfer intended for transporter
      await expect(
        agriTrace.connect(secondTransporter).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Caller is not designated custodian");
    });

    it("2. A previous custodian cannot modify a batch after transferring custody", async function () {
      // Farmer transfers custody to transporter
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Farmer attempts custody transfer, milestone logging, and delivery
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2)
      ).to.be.revertedWith("Caller is not current custodian");

      await expect(
        agriTrace
          .connect(farmer)
          .initiateCustodyTransfer(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2)
      ).to.be.revertedWith("Caller is not current custodian");

      await expect(
        agriTrace.connect(farmer).logMilestone(sampleBatchId, "Unauthorized log", sampleMilestoneHash)
      ).to.be.revertedWith("Caller is not current custodian");

      await expect(
        agriTrace.connect(farmer).completeDelivery(sampleBatchId)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("3. An admin cannot modify batch provenance", async function () {
      // Admin without FARMER_ROLE cannot create batches
      const adminBatch = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_BATCH"));
      await expect(
        agriTrace.connect(admin).createBatch(adminBatch, sampleMetadataHash)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");

      // Admin cannot transfer custody of active batches
      await expect(
        agriTrace
          .connect(admin)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Caller is not current custodian");

      // Admin cannot log milestones on batches
      await expect(
        agriTrace.connect(admin).logMilestone(sampleBatchId, "Admin milestone", sampleMilestoneHash)
      ).to.be.revertedWith("Caller is not current custodian");

      // Verification: Batch provenance remains untouched
      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.farmer).to.equal(farmer.address);
      expect(batch.currentCustodian).to.equal(farmer.address);
      expect(batch.metadataHash).to.equal(sampleMetadataHash);
    });

    it("4. A rejected batch cannot be transferred", async function () {
      const rejectedBatchId = ethers.keccak256(ethers.toUtf8Bytes("BATCH_REJECTED_TEST"));
      await agriTrace.connect(farmer).createBatch(rejectedBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(rejectedBatchId, false, sampleReportHash);

      // Attempt direct transfer
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(rejectedBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");

      // Attempt 2-step transfer initiation
      await expect(
        agriTrace
          .connect(farmer)
          .initiateCustodyTransfer(rejectedBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");
    });

    it("5. A delivered batch cannot be modified", async function () {
      // Fast-forward to DELIVERED
      await agriTrace.connect(farmer).transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);
      await agriTrace.connect(transporter).transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);
      await agriTrace.connect(warehouse).transferCustody(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);
      await agriTrace.connect(retailer).completeDelivery(sampleBatchId);

      // Attempt transfer
      await expect(
        agriTrace
          .connect(retailer)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1)
      ).to.be.revertedWith("Invalid custody transfer transition");

      // Attempt milestone logging
      await expect(
        agriTrace.connect(retailer).logMilestone(sampleBatchId, "Post-delivery log", sampleMilestoneHash)
      ).to.be.revertedWith("Cannot log milestone on terminated batch");

      // Attempt repeat delivery
      await expect(
        agriTrace.connect(retailer).completeDelivery(sampleBatchId)
      ).to.be.revertedWith("Batch not at retailer");
    });

    it("6. Milestone history cannot be deleted or rewritten", async function () {
      await agriTrace.connect(farmer).logMilestone(sampleBatchId, "Milestone 1", sampleMilestoneHash);
      await agriTrace.connect(farmer).logMilestone(sampleBatchId, "Milestone 2", sampleMilestoneHash);

      const count = await agriTrace.getMilestoneCount(sampleBatchId);
      expect(count).to.equal(2);

      const m1 = await agriTrace.getMilestone(sampleBatchId, 0);
      const m2 = await agriTrace.getMilestone(sampleBatchId, 1);
      expect(m1.action).to.equal("Milestone 1");
      expect(m2.action).to.equal("Milestone 2");

      // Contract exposes no delete or overwrite methods
      expect(agriTrace.deleteMilestone).to.be.undefined;
      expect(agriTrace.updateMilestone).to.be.undefined;
      expect(agriTrace.clearMilestones).to.be.undefined;
    });

    it("7. Revoked participants cannot perform future restricted operations", async function () {
      // Create new actor and grant role
      const tempActor = unauthorized;
      await agriTrace.connect(admin).grantRole(FARMER_ROLE, tempActor.address);
      const tempBatchId = ethers.keccak256(ethers.toUtf8Bytes("TEMP_BATCH_REVOKED"));
      await agriTrace.connect(tempActor).createBatch(tempBatchId, sampleMetadataHash);

      // Revoke FARMER_ROLE
      await agriTrace.connect(admin).revokeRole(FARMER_ROLE, tempActor.address);

      // Attempting createBatch after revocation reverts
      const secondBatchId = ethers.keccak256(ethers.toUtf8Bytes("SECOND_BATCH_REVOKED"));
      await expect(
        agriTrace.connect(tempActor).createBatch(secondBatchId, sampleMetadataHash)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");

      // Inspector revocation
      await agriTrace.connect(admin).revokeRole(INSPECTOR_ROLE, inspector.address);
      await expect(
        agriTrace.connect(inspector).verifyQuality(tempBatchId, true, sampleReportHash)
      ).to.be.revertedWithCustomError(agriTrace, "AccessControlUnauthorizedAccount");
    });

    it("8. A pending transfer cannot be accepted by an unauthorized account", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Unauthorized account attempting to accept
      await expect(
        agriTrace.connect(unauthorized).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Caller is not designated custodian");

      // Admin attempting to accept
      await expect(
        agriTrace.connect(admin).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Caller is not designated custodian");
    });
  });

  // =========================================================================
  // 11. Security Hardening & Custody Cancellation (Approved Improvements)
  // =========================================================================

  describe("Security Hardening & Custody Cancellation (Approved Improvements)", function () {
    beforeEach(async function () {
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
    });

    it("1. Current custodian successfully cancels an active pending transfer", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      let pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.active).to.be.true;

      const tx = await agriTrace.connect(farmer).cancelCustodyTransfer(sampleBatchId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "CustodyTransferCancelled")
        .withArgs(sampleBatchId, farmer.address, block.timestamp);

      pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.active).to.be.false;
    });

    it("2. Unauthorized user cannot cancel pending transfer", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Designated recipient cannot cancel
      await expect(
        agriTrace.connect(transporter).cancelCustodyTransfer(sampleBatchId)
      ).to.be.revertedWith("Caller is not current custodian");

      // Random user cannot cancel
      await expect(
        agriTrace.connect(unauthorized).cancelCustodyTransfer(sampleBatchId)
      ).to.be.revertedWith("Caller is not current custodian");

      // Admin cannot cancel
      await expect(
        agriTrace.connect(admin).cancelCustodyTransfer(sampleBatchId)
      ).to.be.revertedWith("Caller is not current custodian");
    });

    it("3. Cancellation fails when no transfer is pending or batch does not exist", async function () {
      // No transfer initiated yet
      await expect(
        agriTrace.connect(farmer).cancelCustodyTransfer(sampleBatchId)
      ).to.be.revertedWith("No active pending transfer");

      // Non-existent batch
      const nonExistentId = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT_BATCH"));
      await expect(
        agriTrace.connect(farmer).cancelCustodyTransfer(nonExistentId)
      ).to.be.revertedWith("Batch does not exist");
    });

    it("4. Cancelled recipient cannot accept custody", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Farmer cancels transfer
      await agriTrace.connect(farmer).cancelCustodyTransfer(sampleBatchId);

      // Transporter attempts to accept cancelled transfer
      await expect(
        agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("No active pending transfer");
    });

    it("5. Recipient with revoked role cannot accept custody", async function () {
      // 5a. Transporter role revocation
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Admin revokes TRANSPORTER_ROLE before acceptance
      await agriTrace.connect(admin).revokeRole(TRANSPORTER_ROLE, transporter.address);

      await expect(
        agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Recipient lacks TRANSPORTER_ROLE");

      // Restore role and accept for subsequent tests
      await agriTrace.connect(admin).grantRole(TRANSPORTER_ROLE, transporter.address);
      await agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash);

      // 5b. Warehouse role revocation
      await agriTrace
        .connect(transporter)
        .initiateCustodyTransfer(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);

      await agriTrace.connect(admin).revokeRole(WAREHOUSE_ROLE, warehouse.address);
      await expect(
        agriTrace.connect(warehouse).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Recipient lacks WAREHOUSE_ROLE");

      await agriTrace.connect(admin).grantRole(WAREHOUSE_ROLE, warehouse.address);
      await agriTrace.connect(warehouse).acceptCustody(sampleBatchId, sampleAcceptanceHash);

      // 5c. Retailer role revocation
      await agriTrace
        .connect(warehouse)
        .initiateCustodyTransfer(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);

      await agriTrace.connect(admin).revokeRole(RETAILER_ROLE, retailer.address);
      await expect(
        agriTrace.connect(retailer).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Recipient lacks RETAILER_ROLE");
    });

    it("6. Valid recipient successfully accepts custody", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      const tx = await agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(agriTrace, "CustodyTransferred")
        .withArgs(sampleBatchId, farmer.address, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1, block.timestamp);

      await expect(tx)
        .to.emit(agriTrace, "CustodyAccepted")
        .withArgs(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleAcceptanceHash, block.timestamp);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.currentCustodian).to.equal(transporter.address);
      expect(batch.status).to.equal(BatchStatus.IN_TRANSIT);
    });

    it("7. Zero handover hash is rejected in both transfer methods", async function () {
      // 7a. Direct transfer rejection
      await expect(
        agriTrace
          .connect(farmer)
          .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid handover hash");

      // 7b. Two-step transfer initiation rejection
      await expect(
        agriTrace
          .connect(farmer)
          .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid handover hash");
    });

    it("8. Zero acceptance hash is rejected in acceptCustody", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      await expect(
        agriTrace.connect(transporter).acceptCustody(sampleBatchId, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid acceptance hash");
    });

    it("9. Acceptance is rejected for delivered batches", async function () {
      // Fast-forward to DELIVERED
      await agriTrace.connect(farmer).transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);
      await agriTrace.connect(transporter).transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);
      await agriTrace.connect(warehouse).transferCustody(sampleBatchId, retailer.address, BatchStatus.AT_RETAILER, sampleHandoverHash3);
      await agriTrace.connect(retailer).completeDelivery(sampleBatchId);

      // Attempt acceptCustody on delivered batch
      await expect(
        agriTrace.connect(retailer).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("Cannot accept custody of terminated batch");
    });

    it("10. Acceptance is rejected for quality-rejected batches", async function () {
      const rejectedBatch = ethers.keccak256(ethers.toUtf8Bytes("QUALITY_REJECTED_BATCH_ACC_TEST"));
      await agriTrace.connect(farmer).createBatch(rejectedBatch, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(rejectedBatch, false, sampleReportHash);

      // Attempt acceptCustody on rejected batch
      await expect(
        agriTrace.connect(farmer).acceptCustody(rejectedBatch, sampleAcceptanceHash)
      ).to.be.revertedWith("Cannot accept custody of terminated batch");
    });
  });

  // =========================================================================
  // 12. Additional Coverage & Edge Case Verification (Step 2E Improvements)
  // =========================================================================

  describe("Additional Edge Case Verification", function () {
    let secondTransporter;

    beforeEach(async function () {
      secondTransporter = consumer;
      await agriTrace.connect(admin).grantRole(TRANSPORTER_ROLE, secondTransporter.address);
      await agriTrace.connect(farmer).createBatch(sampleBatchId, sampleMetadataHash);
      await agriTrace.connect(inspector).verifyQuality(sampleBatchId, true, sampleReportHash);
    });

    it("1. Direct transfer overwriting an active pending transfer", async function () {
      // Initiate transfer to Transporter A
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      let pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.active).to.be.true;
      expect(pending.newCustodian).to.equal(transporter.address);

      // Directly transfer custody to Transporter B
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, secondTransporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Verify pending transfer is cleared
      pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.active).to.be.false;

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.currentCustodian).to.equal(secondTransporter.address);
      expect(batch.status).to.equal(BatchStatus.IN_TRANSIT);

      // Verify Transporter A cannot accept custody
      await expect(
        agriTrace.connect(transporter).acceptCustody(sampleBatchId, sampleAcceptanceHash)
      ).to.be.revertedWith("No active pending transfer");
    });

    it("2. Explicit state verification after cancellation", async function () {
      await agriTrace
        .connect(farmer)
        .initiateCustodyTransfer(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      await agriTrace.connect(farmer).cancelCustodyTransfer(sampleBatchId);

      const batch = await agriTrace.getBatch(sampleBatchId);
      expect(batch.currentCustodian).to.equal(farmer.address);
      expect(batch.status).to.equal(BatchStatus.QUALITY_VERIFIED);

      const pending = await agriTrace.pendingCustodyTransfers(sampleBatchId);
      expect(pending.active).to.be.false;
    });

    it("3. Direct transfer recipient role validation for warehouse and retailer", async function () {
      // Direct transfer to transporter
      await agriTrace
        .connect(farmer)
        .transferCustody(sampleBatchId, transporter.address, BatchStatus.IN_TRANSIT, sampleHandoverHash1);

      // Transporter attempts transfer to invalid warehouse (unauthorized lacks WAREHOUSE_ROLE)
      await expect(
        agriTrace
          .connect(transporter)
          .transferCustody(sampleBatchId, unauthorized.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2)
      ).to.be.revertedWith("Recipient lacks WAREHOUSE_ROLE");

      // Valid transfer to warehouse
      await agriTrace
        .connect(transporter)
        .transferCustody(sampleBatchId, warehouse.address, BatchStatus.AT_WAREHOUSE, sampleHandoverHash2);

      // Warehouse attempts transfer to invalid retailer (unauthorized lacks RETAILER_ROLE)
      await expect(
        agriTrace
          .connect(warehouse)
          .transferCustody(sampleBatchId, unauthorized.address, BatchStatus.AT_RETAILER, sampleHandoverHash3)
      ).to.be.revertedWith("Recipient lacks RETAILER_ROLE");
    });

    it("4. Milestone out-of-bounds on populated array", async function () {
      await agriTrace.connect(farmer).logMilestone(sampleBatchId, "Milestone 1", sampleMilestoneHash);
      await agriTrace.connect(farmer).logMilestone(sampleBatchId, "Milestone 2", sampleMilestoneHash);

      expect(await agriTrace.getMilestoneCount(sampleBatchId)).to.equal(2);

      await expect(
        agriTrace.getMilestone(sampleBatchId, 5)
      ).to.be.revertedWith("Milestone index out of bounds");
    });
  });
});
