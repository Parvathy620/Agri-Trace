const { ethers } = require("ethers");
const { env } = require("./env");
const contractArtifact = require("../contracts/AgriTrace.json");

/**
 * Initializes the ethers.js v6 JsonRpcProvider.
 * Operates purely non-custodially: zero server-side private keys are held.
 * @returns {ethers.JsonRpcProvider}
 */
function createProvider() {
  return new ethers.JsonRpcProvider(env.BLOCKCHAIN_RPC_URL, {
    chainId: env.CHAIN_ID,
    name: env.CHAIN_ID === 31337 ? "hardhat" : "network",
  });
}

const provider = createProvider();

// Expose contract ABI and configured address
const abi = contractArtifact.abi;
const contractAddress = env.AGRITRACE_CONTRACT_ADDRESS;

// Read-only contract interface bound to the provider
const contract = new ethers.Contract(contractAddress, abi, provider);

/**
 * Validates connection to the EVM RPC node and asserts that the remote chainId
 * exactly matches the configured CHAIN_ID.
 * @returns {Promise<{ isConnected: boolean, chainId: number, blockNumber: number }>}
 * @throws {Error} If chain ID does not match or provider is unreachable.
 */
async function validateNetwork() {
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);

  if (actualChainId !== env.CHAIN_ID) {
    throw new Error(
      `Chain ID mismatch: configured CHAIN_ID is ${env.CHAIN_ID}, but RPC network returned ${actualChainId}`
    );
  }

  const blockNumber = await provider.getBlockNumber();
  return {
    isConnected: true,
    chainId: actualChainId,
    blockNumber,
  };
}

module.exports = {
  provider,
  contract,
  contractAddress,
  abi,
  createProvider,
  validateNetwork,
};

