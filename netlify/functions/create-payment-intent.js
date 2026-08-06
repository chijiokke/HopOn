const https = require('https');
const querystring = require('querystring');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05'
  });
}

async function verifyFirebaseUser(token) {
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return decodedToken;
  } catch (e) {
    throw new Error('Unauthorized: ' + e.message);
  }
}

// ── Rate Limiting logic ──
const ipCache = new Map();
const LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 10; // max 10 requests per minute per IP

async function isRateLimited(ip) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const key = `ratelimit:stripe:${ip}`;
      const result = await makeUpstashRedisRequest(redisUrl, redisToken, 'INCR', key);
      const count = parseInt(result);
      if (count === 1) {
        await makeUpstashRedisRequest(redisUrl, redisToken, 'EXPIRE', key, '60');
      }
      return count > MAX_REQUESTS;
    } catch (e) {
      console.warn("Upstash Redis rate limiter failed, falling back to memory:", e);
    }
  }

  // Fallback memory rate limiter
  const now = Date.now();
  if (!ipCache.has(ip)) {
    ipCache.set(ip, { count: 1, resetTime: now + LIMIT_WINDOW });
    return false;
  }

  const record = ipCache.get(ip);
  if (now > record.resetTime) {
    ipCache.set(ip, { count: 1, resetTime: now + LIMIT_WINDOW });
    return false;
  }

  record.count += 1;
  return record.count > MAX_REQUESTS;
}

function makeUpstashRedisRequest(url, token, command, ...args) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify([command, ...args]);
    const cleanUrl = url.replace('https://', '').replace('http://', '');
    const options = {
      hostname: cleanUrl,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.result);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Upstash returned status ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
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

  // Apply Rate Limiting
  const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || event.headers['x-forwarded-for'] || '127.0.0.1';
  try {
    const limited = await isRateLimited(clientIp);
    if (limited) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Too Many Requests: Rate limit exceeded. Please try again later.' })
      };
    }
  } catch (rateErr) {
    console.error("Rate limiter check failed:", rateErr);
  }

  // Verify JWT token using Firebase Auth
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      await verifyFirebaseUser(token);
    } catch (authErr) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized: ' + authErr.message })
      };
    }
  } else {
    if (process.env.NODE_ENV === 'production' || process.env.FIREBASE_PROJECT_ID) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized: Missing or invalid token format' })
      };
    } else {
      console.warn("create-payment-intent: Proceeding without auth token (dev mode fallback)");
    }
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const amount = data.amount;
    const currency = data.currency || 'cad';

    if (!amount || isNaN(amount)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Valid amount in cents is required' })
      };
    }

    const stripePayload = {
      amount: Math.round(amount),
      currency: currency,
      'payment_method_types[]': 'card'
    };

    // Attach metadata so that Stripe webhook has access to checkout details
    const metadataFields = [
      'checkoutType',
      'passengerId',
      'passengerName',
      'driverId',
      'driverName',
      'cargoId',
      'rideId',
      'route',
      'price',
      'method',
      'promoCode'
    ];

    metadataFields.forEach(field => {
      if (data[field] !== undefined && data[field] !== null) {
        stripePayload[`metadata[${field}]`] = String(data[field]);
      }
    });

    const paymentIntent = await makeStripeRequest('POST', '/v1/payment_intents', stripePayload);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        id: paymentIntent.id
      })
    };
  } catch (err) {
    console.error("Error creating PaymentIntent:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
