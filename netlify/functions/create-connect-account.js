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
    let stripeAccountId = userData.stripeConnectedAccountId;

    // 1. Create a new Express Connect Account if they don't have one
    if (!stripeAccountId) {
      const accountParams = {
        type: 'express',
        'capabilities[card_payments][requested]': 'true',
        'capabilities[transfers][requested]': 'true',
        business_type: 'individual',
        'individual[email]': userData.email || '',
        'individual[first_name]': userData.firstName || '',
        'individual[last_name]': userData.lastName || ''
      };

      const account = await makeStripeRequest('POST', '/v1/accounts', accountParams);
      stripeAccountId = account.id;

      // Save the account ID to the user document
      await userRef.update({ stripeConnectedAccountId: stripeAccountId });
    }

    // 2. Determine base redirect URL
    const scheme = event.headers['x-forwarded-proto'] || 'http';
    const host = event.headers['host'] || 'localhost:8888';
    const baseUrl = `${scheme}://${host}`;

    // 3. Create a Stripe Onboarding Account Link
    const linkParams = {
      account: stripeAccountId,
      refresh_url: `${baseUrl}/index.html?payouts_reauth=true`,
      return_url: `${baseUrl}/index.html?payouts_success=true`,
      type: 'account_onboarding'
    };

    const accountLink = await makeStripeRequest('POST', '/v1/account_links', linkParams);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: accountLink.url,
        stripeConnectedAccountId: stripeAccountId
      })
    };
  } catch (err) {
    console.error("Error creating Connect account onboarding:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
