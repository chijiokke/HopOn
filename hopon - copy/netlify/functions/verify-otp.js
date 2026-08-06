const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
let hasServiceAccount = false;
if (admin.apps.length === 0) {
  const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountVar) {
    try {
      const serviceAccount = JSON.parse(serviceAccountVar);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      hasServiceAccount = true;
    } catch (e) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env variable:", e);
      admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05' });
    }
  } else {
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05' });
  }
}

const db = admin.firestore();

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const email = (data.email || '').trim().toLowerCase();
    const code = (data.code || '').trim();

    if (!email || !code) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and verification code are required' }) };
    }

    // Read the private OTP details from Firestore
    const otpDocRef = db.collection('_private_otps').doc(email);
    const otpDoc = await otpDocRef.get();

    if (!otpDoc.exists) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No verification code found. Please request a new one.' }) };
    }

    const record = otpDoc.data();

    // Check expiration
    if (Date.now() > record.expiresAt) {
      await otpDocRef.delete();
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Verification code has expired. Please request a new one.' }) };
    }

    // Verify hash matches
    const hash = crypto.createHash('sha256').update(code + record.salt).digest('hex');
    if (hash !== record.hashedOtp) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Incorrect verification code.' }) };
    }

    // Code verified! Delete document immediately to prevent reuse
    await otpDocRef.delete();

    // Fetch or create user in Firebase Auth
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        userRecord = await admin.auth().createUser({
          email: email,
          emailVerified: true
        });
      } else {
        throw e;
      }
    }

    // Generate Custom Auth Token
    let customToken;
    if (hasServiceAccount) {
      customToken = await admin.auth().createCustomToken(userRecord.uid);
    } else {
      console.warn("FIREBASE_SERVICE_ACCOUNT not configured. Falling back to dev-only auth token.");
      customToken = `mock_custom_token_${userRecord.uid}`;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        customToken,
        userId: userRecord.uid,
        email: userRecord.email
      })
    };
  } catch (err) {
    console.error("Error verifying OTP:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
