const app = require("./app");
const { env } = require("./config/env");

const PORT = env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(` AgriTrace REST API running on port ${PORT}`);
  console.log(` Environment: ${env.NODE_ENV}`);
  console.log(` Chain ID: ${env.CHAIN_ID}`);
  console.log(` Contract Address: ${env.AGRITRACE_CONTRACT_ADDRESS}`);
  console.log(` Firebase Project: ${env.FIREBASE_PROJECT_ID}`);
  console.log(` Emulator Mode: ${Boolean(env.FIRESTORE_EMULATOR_HOST)}`);
  console.log(`========================================================`);
});

// Graceful Termination Handlers
function handleShutdown(signal) {
  console.log(`Received ${signal}. Shutting down HTTP server gracefully...`);
  server.close(() => {
    console.log("HTTP server closed. Process exiting cleanly.");
    process.exit(0);
  });

  // Force close if connections hang past 10 seconds
  setTimeout(() => {
    console.error("Forcefully terminating active server connections after timeout.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

module.exports = server;

