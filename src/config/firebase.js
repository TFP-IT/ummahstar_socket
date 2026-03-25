const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const {SERVICE_ACCOUNT_PATTERN} = require('./constants');

function resolveServiceAccountPath(baseDir) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return path.resolve(baseDir, process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }

  const localMatch = fs
    .readdirSync(baseDir)
    .find(fileName => SERVICE_ACCOUNT_PATTERN.test(fileName));

  return localMatch ? path.join(baseDir, localMatch) : null;
}

function initializeFirebase(baseDir) {
  const serviceAccountPath = resolveServiceAccountPath(baseDir);

  if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
    console.warn(
      'Firebase Admin credential file not found. Push notifications are disabled.',
    );
    return {
      admin,
      firebaseReady: false,
    };
  }

  if (!admin.apps.length) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  console.log(
    `Firebase Admin initialized with ${path.basename(serviceAccountPath)}`,
  );

  return {
    admin,
    firebaseReady: true,
  };
}

module.exports = {
  initializeFirebase,
  resolveServiceAccountPath,
};
