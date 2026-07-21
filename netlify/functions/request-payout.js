const https = require('https');
const querystring = require('querystring');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05'
  });
}
const db = admin.firestore();

async function verifyFirebaseUser(token) {
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return decodedToken;
  } catch (e) {
    throw new Error('Unauthorized: ' + e.message);
  }
}

function makeStripeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return reject(new Error('Stripe secret key (STRIPE_SECRET_KEY) is not configured'));
    }

    const postData = data ? querystring.stringify(data) : '';

    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${secretKey}`
      }
    };

    if (method === 'POST') {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error ? parsed.error.message : 'Stripe API error'));
          }
        } catch (e) {
          reject(new Error('Failed to parse Stripe response: ' + e.message));
        }
      });
    });

    req.on('error', (err) => reject(new Error('Stripe API request failed: ' + err.message)));

    if (method === 'POST') {
      req.write(postData);
    }
    req.end();
  });
}

function getPayDate(timestamp) {
  if (!timestamp) return new Date();
  if (typeof timestamp.toDate === 'function') return timestamp.toDate();
  if (timestamp.seconds !== undefined) return new Date(timestamp.seconds * 1000);
  return new Date(timestamp);
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  // Verify Auth token
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  let userId;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = await verifyFirebaseUser(token);
      userId = decoded.uid;
    } catch (authErr) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized: ' + authErr.message })
      };
    }
  } else {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Unauthorized: Missing or invalid token' })
    };
  }

  try {
    // 1. Fetch user data to verify Stripe Connected Account
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'User profile not found' })
      };
    }

    const userData = userDoc.data();
    const stripeConnectedAccountId = userData.stripeConnectedAccountId;
    if (!stripeConnectedAccountId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No Stripe connected account found. Please onboard first.' })
      };
    }

    // 2. Fetch all completed payments (earnings) for the driver
    const snapPayments = await db.collection("payments").where("driverId", "==", userId).get();
    const payments = snapPayments.docs.map(doc => doc.data());

    // 3. Fetch all requested payouts for the driver
    const snapPayouts = await db.collection("payouts").where("driverId", "==", userId).get();
    const payouts = snapPayouts.docs.map(doc => doc.data());

    // 4. Calculate cleared earnings using the 3-day hold policy
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));

    const totalEarnings = payments.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);
    const totalPayouts = payouts.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

    const clearedEarnings = payments
      .filter(p => {
        const pDate = getPayDate(p.timestamp);
        return pDate <= threeDaysAgo;
      })
      .reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

    const withdrawableBalance = Math.max(0, clearedEarnings - totalPayouts);

    if (withdrawableBalance <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No withdrawable balance available yet. Earnings are held for 3 days to protect transaction safety.' })
      };
    }

    // 5. Trigger Stripe Transfer from Platform Account to Driver's Connected Account
    // Stripe transfers require the amount in cents
    const withdrawableCents = Math.round(withdrawableBalance * 100);

    const transferPayload = {
      amount: withdrawableCents,
      currency: 'cad',
      destination: stripeConnectedAccountId,
      description: `HopOn Cleared Payout for driver ${userId}`
    };

    const transfer = await makeStripeRequest('POST', '/v1/transfers', transferPayload);

    // 6. Record successful payout in Firestore
    const payoutRef = db.collection("payouts").doc();
    await payoutRef.set({
      driverId: userId,
      amount: withdrawableBalance,
      stripeTransferId: transfer.id,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'completed'
    });

    // 7. Send notification to the driver
    const notificationRef = db.collection("notifications").doc();
    await notificationRef.set({
      userId: userId,
      title: '💰 Payout Request Completed',
      text: `Your payout of $${withdrawableBalance.toFixed(2)} was successfully processed to your bank account.`,
      type: 'payout',
      timestamp: new Date().toISOString(),
      read: false
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        amount: withdrawableBalance,
        stripeTransferId: transfer.id
      })
    };
  } catch (err) {
    console.error("Payout request failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
