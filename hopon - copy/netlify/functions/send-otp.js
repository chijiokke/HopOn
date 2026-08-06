const https = require('https');
const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (admin.apps.length === 0) {
  const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountVar) {
    try {
      const serviceAccount = JSON.parse(serviceAccountVar);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (e) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env variable:", e);
      admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05' });
    }
  } else {
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05' });
  }
}

const db = admin.firestore();

// ── Rate Limiting (Upstash Redis + Fallback Memory) ──
const ipCache = new Map();
const LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS = 5; // max 5 OTP requests per minute per IP

async function isRateLimited(ip) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const key = `ratelimit:otp:${ip}`;
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
            resolve(JSON.parse(body).result);
          } catch (e) { reject(e); }
        } else {
          reject(new Error(`Upstash status ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Resend API Delivery Helper ──
function sendResendEmail(apiKey, to, subject, code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      from: 'HopOn <onboarding@resend.dev>',
      to: [to],
      subject: subject,
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 8px; max-width: 500px;">
          <h2 style="color: #6366f1;">🚗 Welcome to HopOn!</h2>
          <p>Use the following 6-digit security code to verify your login or account signup:</p>
          <div style="font-size: 24px; font-weight: bold; background: #f3f4f6; color: #1f2937; padding: 12px; text-align: center; border-radius: 4px; letter-spacing: 4px; margin: 20px 0;">
            ${code}
          </div>
          <p style="color: #6b7280; font-size: 13px;">This security code is active for 10 minutes. If you did not request this code, please ignore this email.</p>
        </div>
      `
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Resend error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

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

  // Apply Rate Limiter
  const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || event.headers['x-forwarded-for'] || '127.0.0.1';
  try {
    const limited = await isRateLimited(clientIp);
    if (limited) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too Many Requests. Try again later.' }) };
    }
  } catch (err) {
    console.error("Rate limiter check failed:", err);
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const email = (data.email || '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email is required' }) };
    }

    // Generate 6-digit code and secure salt
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const salt = crypto.randomBytes(16).toString('hex');
    const hashedOtp = crypto.createHash('sha256').update(code + salt).digest('hex');

    // Save hashed verification details in private Firestore document
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    await db.collection('_private_otps').doc(email).set({
      hashedOtp,
      salt,
      expiresAt
    });

    console.log(`[SECURE FIREBASE BACKEND] Generated code for ${email}: ${code}`);

    // Send email using Resend if API key is present
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      await sendResendEmail(resendApiKey, email, 'Your HopOn Verification Code', code);
    } else {
      console.warn("RESEND_API_KEY not configured. Falling back to local logging.");
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'Verification code sent successfully' })
    };
  } catch (err) {
    console.error("Error generating/sending OTP:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
