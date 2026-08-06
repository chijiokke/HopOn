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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    
    const setupIntent = await makeStripeRequest('POST', '/v1/setup_intents', {
      'payment_method_types[]': 'card'
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: setupIntent.client_secret,
        id: setupIntent.id
      })
    };
  } catch (err) {
    console.error("Error creating SetupIntent:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
