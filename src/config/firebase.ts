import admin from 'firebase-admin';
import dotenv from 'dotenv';
dotenv.config();

let firebaseAdmin: any = null;

if (!admin.apps.length) {
  const saString = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saString) {
    try {
      const serviceAccount = JSON.parse(saString);
      firebaseAdmin = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: 'nikhila-odisha-pandara-samaja.firebasestorage.app'
      });
      console.log('✅ Firebase Admin: Loaded from FIREBASE_SERVICE_ACCOUNT env var');
    } catch (err) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', err);
    }
  }

  if (!firebaseAdmin) {
    console.warn('⚠️ Firebase Admin: Service account not set. Authenticated routes might fail.');
  }
} else {
  firebaseAdmin = admin.app();
}

export const auth: admin.auth.Auth = admin.auth();
export const messaging: admin.messaging.Messaging = admin.messaging();
export default firebaseAdmin;
