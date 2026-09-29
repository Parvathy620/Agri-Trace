# AgriTrace

> **Blockchain-Based Supply Chain Transparency for Agricultural Produce**

---

## 📌 Development Status

> **Status: Under Development (Phase 1: Environment & Architecture Setup)**  
> This project is an individual academic and practical prototype being built incrementally. Features, smart contracts, backend services, and mobile interfaces are currently being staged according to strict architectural guidelines.

---

## 📖 Project Overview

**AgriTrace** is a decentralized traceability prototype designed to bring end-to-end transparency, accountability, and tamper-resistant provenance tracking to agricultural supply chains. 

By registering agricultural produce as discrete, identifiable batches and recording critical lifecycle events on an Ethereum-compatible blockchain, AgriTrace bridges the trust gap between grassroots farmers and end consumers. Consumers can scan a QR code on retail packaging to view an immutable, auditable timeline of the product's journey from harvest to store shelves.

---

## ❗ Problem Statement

Agricultural supply chains involve diverse, fragmented stakeholders:
- Farmers (cultivation and harvest)
- Quality inspectors / Collection centers (sorting, grading, testing)
- Transporters (cold chain / logistics monitoring)
- Warehouses and processing facilities (storage and packaging)
- Retailers (distribution and consumer sale)

Current agricultural supply chains face significant challenges:
1. **Lack of Transparency**: Consumers have minimal visibility into origin, harvest dates, chemical usage, or storage conditions.
2. **Data Tampering & Counterfeiting**: Centralized databases are susceptible to alteration, mislabeling, and fraud.
3. **Traceability Gaps**: In cases of food contamination or quality issues, tracing contaminated batches back to the source is slow, costly, and error-prone.

---

## 💡 Proposed Solution

AgriTrace introduces a hybrid architecture combining a high-performance cloud backend with an immutable blockchain ledger:

- **Batch-Level Lifecycle Tracking**: Each produce lot is registered at harvest as a distinct batch with associated metadata (origin farm, crop variety, harvest date).
- **Immutable Milestone Auditing**: As batches transition through the supply chain (inspection, handover, transport, storage, retail), state transitions and verification hashes are recorded on-chain via smart contracts.
- **Consumer Verification via QR Code**: End consumers can scan a batch QR code using a mobile device to immediately view verified milestones and confirm on-chain authenticity without requiring Web3 expertise.

---

## 🛠 Planned Technology Stack

### Mobile Frontend
- **Framework**: Flutter
- **Language**: Dart
- **Key Capabilities**: Cross-platform mobile client, role-based dashboards, camera-based QR code scanning, product timeline visualization.

### Backend API
- **Runtime**: Node.js
- **Framework**: Express.js
- **Web3 Integration**: `ethers.js`
- **Responsibilities**: Business logic, API routing, metadata management, batch QR code generation, and blockchain transaction relaying.

### Database & Authentication
- **Authentication**: Firebase Authentication (Role-based access control)
- **Database**: Firebase Cloud Firestore (Off-chain metadata, fast indexing, real-time stage updates)

### Blockchain & Smart Contracts
- **Contract Language**: Solidity
- **Development & Testing Framework**: Hardhat
- **Network**: Ethereum-compatible local/testnet (e.g., Hardhat Network / Sepolia)
- **Security & Integrity**: Non-custodial verification, role-based access modifiers, tamper-resistant event emission.

---

## 👥 Planned User Roles

| Role | Primary Responsibilities |
|---|---|
| **Farmer** | Registers new produce batches, inputs initial crop metadata, harvest timestamps, and generates initial batch ID. |
| **Quality Inspector / Collection Center** | Inspects batch parameters, verifies grading standards, and signs quality clearance. |
| **Transporter** | Acknowledges batch pickup, records transit status, and updates location/timestamp handovers. |
| **Warehouse / Processor** | Logs receipt of goods, storage conditions, and processing/packaging details. |
| **Retailer** | Receives shelf-ready batches, verifies lot state, and displays consumer-ready QR codes. |
| **Consumer** | Scans product QR codes to view provenance timeline and independently verify on-chain records. |

---

## 📂 Repository Structure

```text
agritrace/
├── mobile/          # Flutter mobile application
├── backend/         # Node.js & Express REST API
├── blockchain/      # Hardhat project, Solidity smart contracts & tests
├── docs/            # Architecture diagrams, specifications & design docs
├── screenshots/     # Application screenshots, test reports, and verification proofs
├── README.md        # Project overview and documentation
└── .gitignore       # Root Git ignore definitions
```

---

## ⚖ License

This project is developed for educational, academic, and research demonstration purposes.
