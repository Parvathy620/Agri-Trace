const admin = require("firebase-admin");
const { env } = require("./env");

/**
 * Initializes and returns the Firebase Admin SDK singleton application instance.
 * Supports both local Firebase Emulator Suite and production Cloud projects.
 * Avoids initializing the app multiple times across hot-reloads or test suites.
 */
function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const options = {
    projectId: env.FIREBASE_PROJECT_ID,
  };

  // If local emulators are configured, set process environment flags for the Admin SDK
  if (env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = env.FIRESTORE_EMULATOR_HOST;
  }
  if (env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = env.FIREBASE_AUTH_EMULATOR_HOST;
  }
  if (env.FIREBASE_STORAGE_EMULATOR_HOST) {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = env.FIREBASE_STORAGE_EMULATOR_HOST;
  }

  // In production, load service account credential from Google Application Default Credentials
  if (env.NODE_ENV === "production" && env.GOOGLE_APPLICATION_CREDENTIALS) {
    options.credential = admin.credential.applicationDefault();
  }

  return admin.initializeApp(options);
}

const app = initializeFirebase();
const auth = admin.auth(app);
const firestore = admin.firestore(app);
const storage = admin.storage(app);

module.exports = {
  admin,
  app,
  auth,
  firestore,
  storage,
  initializeFirebase,
};

