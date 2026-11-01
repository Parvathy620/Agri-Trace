// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title AgriTrace
 * @author AgriTrace Team
 * @notice Decentralized provenance and traceability smart contract for agricultural supply chains.
 * @dev Enforces strict role-based access control, cryptographic metadata anchoring, and sequential lifecycle state transitions.
 */
contract AgriTrace is AccessControl {
    // =========================================================================
    // Role Definitions
    // =========================================================================

    bytes32 public constant FARMER_ROLE = keccak256("FARMER_ROLE");
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");
    bytes32 public constant TRANSPORTER_ROLE = keccak256("TRANSPORTER_ROLE");
    bytes32 public constant WAREHOUSE_ROLE = keccak256("WAREHOUSE_ROLE");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");

    // =========================================================================
    // Enums & Structs
    // =========================================================================

    /**
     * @notice Discrete lifecycle states for agricultural batches.
     */
    enum BatchStatus {
        CREATED,          // 0: Registered by Farmer
        QUALITY_VERIFIED, // 1: Approved by Quality Inspector
        QUALITY_REJECTED, // 2: Terminal State: Failed inspection
        IN_TRANSIT,       // 3: In custody of Transporter
        AT_WAREHOUSE,     // 4: Held by Warehouse / Processor
        AT_RETAILER,      // 5: Stocked at Retailer
        DELIVERED         // 6: Terminal State: Handed over / sold to Consumer
    }

    /**
     * @notice On-chain minimal trust anchor for a produce batch.
     * @dev Stored fields optimize EVM slot packing and minimize on-chain footprint.
     */
    struct ProductBatch {
        bytes32 batchId;          // Keccak-256 hash of human-readable batch identifier
        address farmer;           // Originating farmer address (immutable provenance anchor)
        address currentCustodian; // Current physical custodian holding authorization
        BatchStatus status;       // Active lifecycle status
        uint256 createdAt;        // Block timestamp when registered
        bytes32 metadataHash;     // Keccak-256 hash of off-chain canonical metadata
    }

    /**
     * @notice Operational milestone logged during active batch custody.
     */
    struct Milestone {
        address actor;           // Address of custodian logging milestone
        string action;           // Operational action description (e.g., "Cold Storage Temp Check: 4C")
        bytes32 milestoneHash;   // Cryptographic hash of milestone data or telemetry
        uint256 timestamp;       // Block timestamp
    }

    /**
     * @notice Pending handover details for two-step custody transfers.
     */
    struct PendingCustodyTransfer {
        address newCustodian;    // Designated recipient
        BatchStatus targetStatus;// Target lifecycle state upon acceptance
        bytes32 handoverHash;    // Handover documentation or condition hash
        bool active;             // Whether pending transfer is active
    }

    // =========================================================================
    // State Storage
    // =========================================================================

    mapping(bytes32 => ProductBatch) private _batches;
    mapping(bytes32 => Milestone[]) private _milestones;
    mapping(bytes32 => PendingCustodyTransfer) public pendingCustodyTransfers;
    bytes32[] private _allBatchIds;

    // =========================================================================
    // Events
    // =========================================================================

    event BatchCreated(
        bytes32 indexed batchId,
        address indexed farmer,
        bytes32 metadataHash,
        uint256 timestamp
    );

    event QualityAuditCompleted(
        bytes32 indexed batchId,
        address indexed inspector,
        bool approved,
        bytes32 reportHash,
        uint256 timestamp
    );

    event CustodyTransferInitiated(
        bytes32 indexed batchId,
        address indexed currentCustodian,
        address indexed newCustodian,
        BatchStatus targetStatus,
        bytes32 handoverHash,
        uint256 timestamp
    );

    event CustodyTransferCancelled(
        bytes32 indexed batchId,
        address indexed custodian,
        uint256 timestamp
    );

    event CustodyTransferred(
        bytes32 indexed batchId,
        address indexed previousCustodian,
        address indexed newCustodian,
        BatchStatus newStatus,
        bytes32 handoverHash,
        uint256 timestamp
    );

    event CustodyAccepted(
        bytes32 indexed batchId,
        address indexed custodian,
        BatchStatus status,
        bytes32 acceptanceHash,
        uint256 timestamp
    );

    event BatchDelivered(
        bytes32 indexed batchId,
        address indexed retailer,
        uint256 timestamp
    );

    event MilestoneLogged(
        bytes32 indexed batchId,
        address indexed actor,
        string action,
        bytes32 milestoneHash,
        uint256 timestamp
    );

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Initializes contract granting DEFAULT_ADMIN_ROLE to deployer.
     */
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // =========================================================================
    // Core Lifecycle Functions
    // =========================================================================

    /**
     * @notice Registers a new produce batch on-chain.
     * @param batchId Keccak-256 hash of human-readable batch identifier.
     * @param metadataHash Keccak-256 hash of canonical off-chain metadata (Firestore).
     */
    function createBatch(bytes32 batchId, bytes32 metadataHash) external onlyRole(FARMER_ROLE) {
        require(batchId != bytes32(0), "Invalid batch ID");
        require(metadataHash != bytes32(0), "Invalid metadata hash");
        require(_batches[batchId].createdAt == 0, "Batch already exists");

        _batches[batchId] = ProductBatch({
            batchId: batchId,
            farmer: msg.sender,
            currentCustodian: msg.sender,
            status: BatchStatus.CREATED,
            createdAt: block.timestamp,
            metadataHash: metadataHash
        });

        _allBatchIds.push(batchId);

        emit BatchCreated(batchId, msg.sender, metadataHash, block.timestamp);
    }

    /**
     * @notice Conducts quality verification or rejection on a freshly registered batch.
     * @param batchId Target batch identifier.
     * @param approved True if batch passes quality inspection; false if rejected.
     * @param reportHash Cryptographic anchor of inspection report.
     */
    function verifyQuality(
        bytes32 batchId,
        bool approved,
        bytes32 reportHash
    ) external onlyRole(INSPECTOR_ROLE) {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(_batches[batchId].status == BatchStatus.CREATED, "Batch not awaiting inspection");
        require(reportHash != bytes32(0), "Invalid report hash");

        if (approved) {
            _batches[batchId].status = BatchStatus.QUALITY_VERIFIED;
        } else {
            _batches[batchId].status = BatchStatus.QUALITY_REJECTED;
        }

        emit QualityAuditCompleted(batchId, msg.sender, approved, reportHash, block.timestamp);
    }

    /**
     * @notice Directly transfers custody and transitions batch status to an authorized recipient.
     * @param batchId Target batch identifier.
     * @param newCustodian Address of authorized supply chain actor receiving custody.
     * @param targetStatus Sequential next status for the batch.
     * @param handoverHash Cryptographic anchor of transfer documentation / bill of lading.
     */
    function transferCustody(
        bytes32 batchId,
        address newCustodian,
        BatchStatus targetStatus,
        bytes32 handoverHash
    ) external {
        _validateCustodyTransition(batchId, newCustodian, targetStatus, handoverHash);

        address previousCustodian = _batches[batchId].currentCustodian;
        _batches[batchId].currentCustodian = newCustodian;
        _batches[batchId].status = targetStatus;

        if (pendingCustodyTransfers[batchId].active) {
            delete pendingCustodyTransfers[batchId];
        }

        emit CustodyTransferred(
            batchId,
            previousCustodian,
            newCustodian,
            targetStatus,
            handoverHash,
            block.timestamp
        );
    }

    /**
     * @notice Initiates a two-step custody transfer requiring explicit recipient acceptance.
     * @param batchId Target batch identifier.
     * @param newCustodian Address of authorized recipient.
     * @param targetStatus Target lifecycle status upon acceptance.
     * @param handoverHash Transfer documentation anchor.
     */
    function initiateCustodyTransfer(
        bytes32 batchId,
        address newCustodian,
        BatchStatus targetStatus,
        bytes32 handoverHash
    ) external {
        _validateCustodyTransition(batchId, newCustodian, targetStatus, handoverHash);

        pendingCustodyTransfers[batchId] = PendingCustodyTransfer({
            newCustodian: newCustodian,
            targetStatus: targetStatus,
            handoverHash: handoverHash,
            active: true
        });

        emit CustodyTransferInitiated(
            batchId,
            msg.sender,
            newCustodian,
            targetStatus,
            handoverHash,
            block.timestamp
        );
    }

    /**
     * @notice Cancels an active pending custody transfer.
     * @param batchId Target batch identifier.
     */
    function cancelCustodyTransfer(bytes32 batchId) external {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(msg.sender == _batches[batchId].currentCustodian, "Caller is not current custodian");
        require(pendingCustodyTransfers[batchId].active, "No active pending transfer");

        delete pendingCustodyTransfers[batchId];

        emit CustodyTransferCancelled(batchId, msg.sender, block.timestamp);
    }

    /**
     * @notice Accepts custody of a batch under an active pending transfer.
     * @param batchId Target batch identifier.
     * @param acceptanceHash Anchor of physical receipt verification / inspection.
     */
    function acceptCustody(bytes32 batchId, bytes32 acceptanceHash) external {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(
            _batches[batchId].status != BatchStatus.QUALITY_REJECTED &&
            _batches[batchId].status != BatchStatus.DELIVERED,
            "Cannot accept custody of terminated batch"
        );
        require(pendingCustodyTransfers[batchId].active, "No active pending transfer");
        require(acceptanceHash != bytes32(0), "Invalid acceptance hash");

        PendingCustodyTransfer memory pending = pendingCustodyTransfers[batchId];
        require(msg.sender == pending.newCustodian, "Caller is not designated custodian");

        if (pending.targetStatus == BatchStatus.IN_TRANSIT) {
            require(hasRole(TRANSPORTER_ROLE, msg.sender), "Recipient lacks TRANSPORTER_ROLE");
        } else if (pending.targetStatus == BatchStatus.AT_WAREHOUSE) {
            require(hasRole(WAREHOUSE_ROLE, msg.sender), "Recipient lacks WAREHOUSE_ROLE");
        } else if (pending.targetStatus == BatchStatus.AT_RETAILER) {
            require(hasRole(RETAILER_ROLE, msg.sender), "Recipient lacks RETAILER_ROLE");
        }

        address previousCustodian = _batches[batchId].currentCustodian;
        _batches[batchId].currentCustodian = msg.sender;
        _batches[batchId].status = pending.targetStatus;

        delete pendingCustodyTransfers[batchId];

        emit CustodyTransferred(
            batchId,
            previousCustodian,
            msg.sender,
            pending.targetStatus,
            pending.handoverHash,
            block.timestamp
        );

        emit CustodyAccepted(
            batchId,
            msg.sender,
            pending.targetStatus,
            acceptanceHash,
            block.timestamp
        );
    }

    /**
     * @notice Finalizes batch delivery and marks state as DELIVERED upon sale to consumer.
     * @param batchId Target batch identifier.
     */
    function completeDelivery(bytes32 batchId) external {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(msg.sender == _batches[batchId].currentCustodian, "Caller is not current custodian");
        require(hasRole(RETAILER_ROLE, msg.sender), "Caller lacks RETAILER_ROLE");
        require(_batches[batchId].status == BatchStatus.AT_RETAILER, "Batch not at retailer");

        _batches[batchId].status = BatchStatus.DELIVERED;

        emit BatchDelivered(batchId, msg.sender, block.timestamp);
    }

    /**
     * @notice Records an operational checkpoint or telemetry milestone during active custody.
     * @param batchId Target batch identifier.
     * @param action Operational milestone action string.
     * @param milestoneHash Cryptographic hash of milestone data.
     */
    function logMilestone(
        bytes32 batchId,
        string calldata action,
        bytes32 milestoneHash
    ) external {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(msg.sender == _batches[batchId].currentCustodian, "Caller is not current custodian");
        require(
            _batches[batchId].status != BatchStatus.QUALITY_REJECTED &&
            _batches[batchId].status != BatchStatus.DELIVERED,
            "Cannot log milestone on terminated batch"
        );
        require(bytes(action).length > 0, "Action description required");
        require(milestoneHash != bytes32(0), "Invalid milestone hash");

        _milestones[batchId].push(
            Milestone({
                actor: msg.sender,
                action: action,
                milestoneHash: milestoneHash,
                timestamp: block.timestamp
            })
        );

        emit MilestoneLogged(batchId, msg.sender, action, milestoneHash, block.timestamp);
    }

    // =========================================================================
    // View & Query Functions
    // =========================================================================

    /**
     * @notice Returns batch record for verification.
     * @param batchId Target batch identifier.
     */
    function getBatch(bytes32 batchId) external view returns (ProductBatch memory) {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        return _batches[batchId];
    }

    /**
     * @notice Checks whether a batch identifier has been registered.
     * @param batchId Target batch identifier.
     */
    function batchExists(bytes32 batchId) external view returns (bool) {
        return _batches[batchId].createdAt != 0;
    }

    /**
     * @notice Returns complete milestone history for a batch.
     * @param batchId Target batch identifier.
     */
    function getMilestones(bytes32 batchId) external view returns (Milestone[] memory) {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        return _milestones[batchId];
    }

    /**
     * @notice Returns count of milestones logged for a batch.
     * @param batchId Target batch identifier.
     */
    function getMilestoneCount(bytes32 batchId) external view returns (uint256) {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        return _milestones[batchId].length;
    }

    /**
     * @notice Returns an individual milestone by index.
     * @param batchId Target batch identifier.
     * @param index Milestone array index.
     */
    function getMilestone(bytes32 batchId, uint256 index) external view returns (Milestone memory) {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(index < _milestones[batchId].length, "Milestone index out of bounds");
        return _milestones[batchId][index];
    }

    /**
     * @notice Returns all registered batch IDs.
     */
    function getAllBatchIds() external view returns (bytes32[] memory) {
        return _allBatchIds;
    }

    /**
     * @notice Returns total number of registered batches.
     */
    function getBatchCount() external view returns (uint256) {
        return _allBatchIds.length;
    }

    // =========================================================================
    // Internal Validation Logic
    // =========================================================================

    /**
     * @dev Validates custody transfer conditions, sequence rules, and role constraints.
     */
    function _validateCustodyTransition(
        bytes32 batchId,
        address newCustodian,
        BatchStatus targetStatus,
        bytes32 handoverHash
    ) internal view {
        require(_batches[batchId].createdAt != 0, "Batch does not exist");
        require(msg.sender == _batches[batchId].currentCustodian, "Caller is not current custodian");
        require(newCustodian != address(0), "Invalid recipient address");
        require(newCustodian != msg.sender, "Cannot transfer custody to self");
        require(handoverHash != bytes32(0), "Invalid handover hash");

        BatchStatus currentStatus = _batches[batchId].status;

        if (currentStatus == BatchStatus.QUALITY_VERIFIED) {
            require(targetStatus == BatchStatus.IN_TRANSIT, "Invalid status transition: expected IN_TRANSIT");
            require(hasRole(TRANSPORTER_ROLE, newCustodian), "Recipient lacks TRANSPORTER_ROLE");
        } else if (currentStatus == BatchStatus.IN_TRANSIT) {
            require(targetStatus == BatchStatus.AT_WAREHOUSE, "Invalid status transition: expected AT_WAREHOUSE");
            require(hasRole(WAREHOUSE_ROLE, newCustodian), "Recipient lacks WAREHOUSE_ROLE");
        } else if (currentStatus == BatchStatus.AT_WAREHOUSE) {
            require(targetStatus == BatchStatus.AT_RETAILER, "Invalid status transition: expected AT_RETAILER");
            require(hasRole(RETAILER_ROLE, newCustodian), "Recipient lacks RETAILER_ROLE");
        } else {
            revert("Invalid custody transfer transition");
        }
    }
}
