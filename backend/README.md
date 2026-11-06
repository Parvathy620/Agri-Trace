# AgriTrace Backend API

> **Node.js & Express REST API for AgriTrace Supply Chain Traceability**

---

## 📌 Overview

The AgriTrace Backend provides the off-chain orchestration, metadata management, non-custodial transaction relaying, and verification services bridging the Flutter mobile client with Firebase and the on-chain Ethereum smart contract (`AgriTrace.sol`).

---

## 📂 Project Structure

```text
backend/
├── src/
│   ├── config/
│   │   ├── env.js              # Joi-validated environment configuration
│   │   ├── firebase.js         # Firebase Admin SDK singleton (Emulator + Cloud)
│   │   ├── blockchain.js       # ethers.js v6 JsonRpcProvider & Contract binding
│   │   ├── cors.js             # CORS configuration & origin allowlist management
│   │   └── constants.js        # Role enums, contract bytes32 roles, challenge constants
│   ├── contracts/
│   │   └── AgriTrace.json      # Exported AgriTrace smart contract ABI
│   ├── middleware/
│   │   ├── auth.middleware.js  # Firebase ID token validation and user profile binding
│   │   ├── role.middleware.js  # Firestore business role and on-chain preflight authorization
│   │   └── error.middleware.js # Centralized error, CORS, & 404 handler
│   ├── controllers/
│   │   └── auth.controller.js  # Wallet challenge issuance, signature verification, /me
│   ├── routes/
│   │   └── auth.routes.js      # Auth and wallet-linking route definitions
│   ├── services/
│   │   ├── wallet.service.js   # Nonce generation, message construction, atomic linking
│   │   ├── metadata.service.js # Batch metadata canonicalization, hashing, & integrity verification
│   │   └── hashing.service.js  # Facade & export alias for hashing services
│   ├── validators/
│   │   └── metadata.validator.js # Schema validation for the 7 anchored batch fields
│   ├── utils/
│   │   ├── canonicalizer.js    # NFC normalization, lexical quantity, UTC date, alphabetical sorting
│   │   ├── canonicalize.js     # Architecture alias re-exporting canonicalizer.js
│   │   └── hash.util.js        # Ethereum Keccak-256 (ethers.js v6) hashing functions
│   ├── app.js                  # Express app configuration & middleware pipeline
│   └── server.js               # HTTP server startup & graceful shutdown
├── tests/
│   ├── metadata.test.js        # Golden Vector, determinism, validation, & integrity tests
│   ├── auth.test.js            # Authentication middleware and profile binding tests
│   ├── wallet.test.js          # Cryptographic wallet challenge and atomic linking tests
│   ├── role.test.js            # Role authorization and on-chain preflight tests
│   ├── env.test.js             # Environment schema validation tests
│   ├── health.test.js          # Health-check endpoint tests (dev & prod)
│   ├── cors.test.js            # CORS allowlist & authorization tests
│   └── error.test.js           # Error handling & 404 tests
├── .env.example                # Template for environment variables
├── .gitignore                  # Ignored dependencies, secrets, and caches
├── package.json                # Dependencies and scripts
└── README.md                   # Backend documentation
```

---

## ⚙️ Configuration & Environment Variables

Copy `.env.example` to `.env` for local development:
```bash
cp .env.example .env
```

| Variable | Description | Default / Example |
|---|---|---|
| `NODE_ENV` | Environment (`development`, `test`, `production`) | `development` |
| `PORT` | HTTP port | `5000` |
| `FIREBASE_PROJECT_ID` | Firebase project identifier | `agritrace-local` |
| `FIRESTORE_EMULATOR_HOST` | Host for local Firestore emulator | `localhost:8080` |
| `FIREBASE_AUTH_EMULATOR_HOST` | Host for local Firebase Auth emulator | `localhost:9099` |
| `BLOCKCHAIN_RPC_URL` | JSON-RPC provider endpoint | `http://127.0.0.1:8545` |
| `CHAIN_ID` | EVM Chain ID | `31337` (Hardhat) |
| `AGRITRACE_CONTRACT_ADDRESS` | Deployed AgriTrace contract address | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| `CONFIRMATION_BLOCKS` | Required base block confirmations | Dev: `2` / Prod: `12` |
| `FALLBACK_FINALITY_BLOCKS` | Fallback confirmation depth for non-PoS dev nodes | Dev: `5` / Prod: `64` |
| `ALLOW_FALLBACK_FINALITY` | Whether fallback finality is permitted when Casper FFG 'finalized' tag is unsupported | Dev/Test: `true` / Prod: `false` (Strict PoS) |
| `CORS_ORIGIN` | Comma-separated permitted browser origins | Dev: `localhost:3000,localhost:8080` / Prod: Required |

> **Production Finality & Fallback Policy**:
> - In `production` (`NODE_ENV=production`), `ALLOW_FALLBACK_FINALITY` defaults to `false`. The backend strictly enforces post-Merge Ethereum Casper FFG cryptographic finality checkpoints (`provider.getBlock("finalized")`). Fallback to confirmation depth is disallowed unless an operator explicitly decisions and configures `ALLOW_FALLBACK_FINALITY=true`.
> - In `development` / `test`, `ALLOW_FALLBACK_FINALITY` defaults to `true` to permit testing against local Hardhat/Anvil nodes which do not support the `finalized` block tag.
> - Invalid configuration values for `ALLOW_FALLBACK_FINALITY` immediately fail startup validation rather than silently enabling fallback.

> **Production CORS Note**: In production, `CORS_ORIGIN` must be explicitly defined (e.g., `https://app.agritrace.io,https://admin.agritrace.io`). Wildcard `*` and automatic localhost inheritance are strictly rejected.

---

## 🔐 Authentication & Wallet Linking Endpoints

All wallet-linking endpoints require a valid Firebase ID token in the `Authorization: Bearer <token>` header.

### 1. Request Wallet Link Challenge
```http
POST /api/v1/auth/wallet/challenge
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "walletAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```
**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "challengeId": "123e4567-e89b-12d3-a456-426614174000",
    "walletAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "message": "AgriTrace Wallet Link Verification\nDomain: agritrace.io\n...",
    "expiresAt": "2026-11-05T12:05:00.000Z"
  }
}
```

### 2. Verify Wallet Signature & Link
```http
POST /api/v1/auth/wallet/verify
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "challengeId": "123e4567-e89b-12d3-a456-426614174000",
  "signature": "0x..."
}
```
**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Wallet linked successfully",
  "data": {
    "walletAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "linkedAt": "2026-11-05T12:01:00.000Z"
  }
}
```

### 3. Get Authenticated User Profile
```http
GET /api/v1/auth/me
Authorization: Bearer <idToken>
```
**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "uid": "usr_farmer_8832a7b1",
    "email": "farmer.ramesh@agritrace.org",
    "displayName": "Ramesh Kumar",
    "role": "FARMER",
    "walletAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "organization": { "name": "Sahyadri FPC" },
    "isActive": true,
    "createdAt": "2026-11-01T08:00:00.000Z"
  }
}
```

---

## 🌾 Metadata Canonicalization, Hashing & Golden Vectors

AgriTrace guarantees cryptographic parity across Node.js, Flutter (Dart), and Solidity smart contracts via strict deterministic canonicalization rules and Ethereum Keccak-256 hashing.

### The 7 Anchored Metadata Fields

Only the 7 immutable anchored fields are included in `metadataHash`:

| # | Field | Type | Normalization & Canonical Rule | Golden Vector Value |
|:---:|---|---|---|---|
| 1 | `category` | `string` | Unicode NFC normalized; trimmed of whitespace | `"Fresh Produce"` |
| 2 | `cropVariety` | `string` | Unicode NFC normalized; trimmed of whitespace | `"Roma Tomato"` |
| 3 | `harvestDate` | `string` | Strict ISO 8601 UTC format `YYYY-MM-DDTHH:mm:ssZ` (no ms, literal `Z`) | `"2026-11-01T10:00:00Z"` |
| 4 | `humanBatchId` | `string` | Uppercase ASCII matching `^BATCH-[A-Z0-9-]+$` | `"BATCH-2026-TOMATO-001"` |
| 5 | `origin` | `string` | Unicode NFC normalized; trimmed of whitespace | `"Green Valley Farm"` |
| 6 | `quantity` | `number` | Strictly positive ($> 0$), max 3 decimal places without rounding, trailing zeros stripped, max $10^9$ | `1500` |
| 7 | `unit` | `string` | Lowercase; trimmed of whitespace (`kg`, `ton`, etc.) | `"kg"` |

### Exact Quantity Canonicalization Rules
1. **Lexical Pre-Validation**: Input is validated before numeric conversion.
2. **Scientific Notation Prohibited**: Any quantity matching `/[eE]/` is rejected (HTTP 422).
3. **Pattern Enforcement**: Must match `/^(0|[1-9]\d*)(\.\d+)?$/`. Leading zeros, negative numbers, and non-numeric inputs are rejected.
4. **Precision Check**: Fractional part $\le 3$ decimal digits. Silent rounding is forbidden.
5. **Bounds**: $0.001 \le \text{quantity} \le 1,000,000,000$.
6. **Trailing Zero Normalization**: Trailing fractional zeros are stripped; if the decimal part becomes empty, the value is normalized as an integer.

### Verified Golden Vector

- **Input Payload**:
  ```json
  {
    "category": "Fresh Produce",
    "cropVariety": "Roma Tomato",
    "harvestDate": "2026-11-01T10:00:00Z",
    "humanBatchId": "BATCH-2026-TOMATO-001",
    "origin": "Green Valley Farm",
    "quantity": 1500,
    "unit": "kg"
  }
  ```
- **Canonical JSON String** (alphabetical keys, compact):
  ```json
  {"category":"Fresh Produce","cropVariety":"Roma Tomato","harvestDate":"2026-11-01T10:00:00Z","humanBatchId":"BATCH-2026-TOMATO-001","origin":"Green Valley Farm","quantity":1500,"unit":"kg"}
  ```
- **Canonical JSON Length**: **189** UTF-8 bytes
- **Human Batch ID UTF-8 Length**: **21** UTF-8 bytes
- **Derived `batchId` (`ethers.keccak256`)**:
  ```text
  0x7078459f06a313998aff5f7192ae0fa5e58cf9823f4422a8073561b04462125e
  ```
- **Derived `metadataHash` (`ethers.keccak256`)**:
  ```text
  0xbec1c34ae775c4e85a9d48774328d093061dadc4422fffb483384410e74e658e
  ```

Matches bitwise with the on-chain test fixture in `blockchain/test/AgriTrace.js`.

### Metadata Integrity Verification

```javascript
const { verifyMetadataIntegrity } = require("./src/services/metadata.service");

const result = verifyMetadataIntegrity(rawMetadata, expectedMetadataHash);
// Returns: { isValid: boolean, calculatedHash: string, expectedHash: string, reason: string|null }
```

---

## 🚀 Running the Server

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Running Tests
```bash
npm test
```

---

## 🔍 Health Diagnostics Endpoint

The health endpoint provides service readiness status while safeguarding sensitive infrastructure:
```http
GET /api/v1/health
```

### Development Response
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-11-05T12:00:00.000Z",
    "uptimeSeconds": 42,
    "environment": "development",
    "version": "1.0.0",
    "services": {
      "firebase": {
        "status": "configured",
        "projectId": "agritrace-local",
        "emulatorMode": true,
        "emulators": {
          "firestore": "localhost:8080",
          "auth": "localhost:9099",
          "storage": "localhost:9199"
        }
      },
      "blockchain": {
        "status": "configured",
        "chainId": 31337,
        "contractConfigured": true,
        "rpcConfigured": true
      }
    }
  }
}
```

### Production Response
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-11-05T12:00:00.000Z",
    "uptimeSeconds": 1542,
    "version": "1.0.0",
    "services": {
      "firebase": {
        "status": "configured"
      },
      "blockchain": {
        "status": "configured"
      }
    }
  }
}
```
