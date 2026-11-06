/**
 * Lightweight structured logger for AgriTrace backend services.
 * Formats log entries with ISO timestamp, level, message, and metadata object.
 * Silences info/debug output during automated tests unless DEBUG_TESTS=true is set.
 */

const isTest =
  (process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => typeof arg === "string" && arg.includes("mocha"))) &&
  !process.env.DEBUG_TESTS;

function formatEntry(level, message, meta = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

const logger = {
  info(message, meta) {
    if (!isTest) {
      console.log(formatEntry("INFO", message, meta));
    }
  },
  warn(message, meta) {
    if (!isTest) {
      console.warn(formatEntry("WARN", message, meta));
    }
  },
  error(message, meta) {
    if (!isTest) {
      console.error(formatEntry("ERROR", message, meta));
    }
  },
  debug(message, meta) {
    if (!isTest) {
      console.debug(formatEntry("DEBUG", message, meta));
    }
  },
};

module.exports = logger;
