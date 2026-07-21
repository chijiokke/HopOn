const https = require('https');
const querystring = require('querystring');

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
        'Authorization': `Bearer ${secretKey}`,
        'Stripe-Version': '2023-10-16'
      }
    };

    if (method === 'POST' && postData) {
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

    if (method === 'POST' && postData) {
      req.write(postData);
    }
    req.end();
  });
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  try {
    const body = JSON.parse(event.body || '{}');
    const userId = body.userId || '';

    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'userId is required' })
      };
    }

    // Create a Stripe Identity VerificationSession
    // - type: document  → verifies a government-issued ID (driver's licence)
    // - options.document.require_matching_selfie: true → person must take a live selfie to match the ID
    const session = await makeStripeRequest('POST', '/v1/identity/verification_sessions', {
      'type': 'document',
      'options[document][allowed_types][0]': 'driving_license',
      'options[document][allowed_types][1]': 'id_card',
      'options[document][allowed_types][2]': 'passport',
      'options[document][require_matching_selfie]': 'true',
      'metadata[userId]': userId,
      // Return URL after verification (hosted flow)
      'return_url': `${process.env.APP_URL || 'https://yourapp.netlify.app'}/?identity_return=1`
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        clientSecret: session.client_secret,
        url: session.url  // Stripe-hosted verification page URL
      })
    };
  } catch (err) {
    console.error('Error creating Identity session:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
