const admin = require('firebase-admin');
const logger = require('./logger');

let firebaseApp = null;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  // A real project id is the only hard requirement for verifying Google/Firebase
  // ID tokens — verifyIdToken validates against Google's public certs, no service
  // account needed. Service-account creds are only required for SENDING things
  // (FCM, custom tokens), so they're optional here.
  if (!projectId || projectId.includes('your-project')) {
    logger.warn('[Firebase] No valid FIREBASE_PROJECT_ID — Google sign-in disabled');
    return null;
  }

  // Use a full service-account credential only when one is actually present and
  // looks real; otherwise initialise with just the project id (enough for
  // verifyIdToken). This lets Google sign-in work without a service-account key.
  const hasCert = privateKey && clientEmail && privateKey.includes('BEGIN PRIVATE KEY');
  try {
    firebaseApp = admin.initializeApp(
      hasCert
        ? { projectId, credential: admin.credential.cert({ projectId, privateKey: privateKey.replace(/\\n/g, '\n'), clientEmail }) }
        : { projectId },
    );
    logger.info(`[Firebase] Initialised (${hasCert ? 'service account' : 'projectId only — verify only'})`);
  } catch (err) {
    logger.warn('[Firebase] Failed to initialize:', { message: err.message });
    return null;
  }

  return firebaseApp;
}

module.exports = { getFirebaseApp, admin };
