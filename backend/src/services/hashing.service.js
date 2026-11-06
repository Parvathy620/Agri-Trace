/**
 * @file hashing.service.js
 * @description Export alias and facade for metadata canonicalization and hashing services,
 * matching architecture document references.
 */

const metadataService = require("./metadata.service");
const hashUtil = require("../utils/hash.util");
const canonicalizer = require("../utils/canonicalizer");

module.exports = {
  ...metadataService,
  ...hashUtil,
  ...canonicalizer,
};

