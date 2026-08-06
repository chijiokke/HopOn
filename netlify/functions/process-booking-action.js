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
  let callerId;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = await verifyFirebaseUser(token);
      callerId = decoded.uid;
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
    const { action, bookingId } = JSON.parse(event.body || '{}');
    if (!action || !bookingId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Action and bookingId are required' })
      };
    }

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Booking not found' })
      };
    }

    const booking = bookingDoc.data();

    if (action === 'decline') {
      // Verify caller is the driver of the booking
      if (booking.driverId !== callerId) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Forbidden: Only the driver can decline a request' })
        };
      }

      if (booking.status !== 'Pending' && booking.status !== 'Pending Approval') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Booking is not in a pending state' })
        };
      }

      // Trigger Stripe Refund if payment intent exists
      if (booking.stripePaymentIntentId) {
        await makeStripeRequest('POST', '/v1/refunds', {
          payment_intent: booking.stripePaymentIntentId
        });

        // Mark payment receipt as refunded
        const paymentRef = db.collection("payments").doc(booking.stripePaymentIntentId);
        const paymentDoc = await paymentRef.get();
        if (paymentDoc.exists) {
          await paymentRef.update({ status: 'refunded' });
        }
      }

      // Update booking status
      await bookingRef.update({ status: 'Declined' });

      // Add system message to chat
      const chatRoomId = [booking.passengerId, booking.driverId].sort().join('_');
      const sysText = "❌ Ride Request Declined.";
      await db.collection("chats").doc(chatRoomId).collection("messages").add({
        senderId: callerId,
        text: sysText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      await db.collection("chats").doc(chatRoomId).set({
        lastMessage: sysText,
        lastTimestamp: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Notify passenger
      const notifRef = db.collection("notifications").doc();
      await notifRef.set({
        userId: booking.passengerId,
        title: '📅 Booking Declined',
        text: `Your booking request with ${booking.driverName} was declined.`,
        type: 'booking',
        timestamp: new Date().toISOString(),
        read: false
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, status: 'Declined' })
      };

    } else if (action === 'cancel') {
      // Verify caller is either passenger or driver
      if (booking.passengerId !== callerId && booking.driverId !== callerId) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Forbidden: You are not a party to this booking' })
        };
      }

      if (booking.status === 'Cancelled' || booking.status === 'Completed') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Trip is already cancelled or completed' })
        };
      }

      const isPassenger = booking.passengerId === callerId;
      let refundAmount = parseFloat(booking.price.replace('$', '')) || 0;

      // 1. Stripe Refund
      if (booking.stripePaymentIntentId) {
        const refundPayload = {
          payment_intent: booking.stripePaymentIntentId
        };
        // If passenger cancelled, do a partial refund of only the driver's portion (base fare).
        // The 18% platform fee remains captured on our platform Stripe balance.
        if (isPassenger) {
          refundAmount = parseFloat((refundAmount / 1.18).toFixed(2));
          refundPayload.amount = Math.round(refundAmount * 100);
        }
        await makeStripeRequest('POST', '/v1/refunds', refundPayload);

        const paymentRef = db.collection("payments").doc(booking.stripePaymentIntentId);
        const paymentDoc = await paymentRef.get();
        if (paymentDoc.exists) {
          await paymentRef.update({ status: 'refunded', price: -refundAmount });
        }
      } else if (booking.paymentMethod === 'wallet') {
        // 2. Wallet Refund (re-credit passenger)
        const passengerRef = db.collection("users").doc(booking.passengerId);
        await db.runTransaction(async (transaction) => {
          const passSnap = await transaction.get(passengerRef);
          if (passSnap.exists) {
            const currentBal = parseFloat(passSnap.data().hoponCashBalance || 0);
            transaction.update(passengerRef, { hoponCashBalance: currentBal + refundAmount });
          }
        });
      }

      // If approved ride is cancelled, restore driver's seat availability
      if (booking.status === 'Upcoming' || booking.status === 'In Progress') {
        const rideRef = db.collection("rides").doc(booking.rideId);
        const seatsToRestore = booking.seatsBooked || 1;
        await db.runTransaction(async (transaction) => {
          const rideSnap = await transaction.get(rideRef);
          if (rideSnap.exists) {
            const currentSeats = rideSnap.data().seats || 0;
            transaction.update(rideRef, { seats: currentSeats + seatsToRestore });
          }
        });
      }

      // Update booking status
      await bookingRef.update({ status: 'Cancelled' });

      // Add cancellation notifications
      const passengerNotifRef = db.collection("notifications").doc();
      await passengerNotifRef.set({
        userId: booking.passengerId,
        title: '❌ Ride Booking Cancelled',
        text: `Your booking with ${booking.driverName} has been cancelled. Refunded $${refundAmount.toFixed(2)} (base fare).`,
        type: 'booking',
        timestamp: new Date().toISOString(),
        read: false
      });

      const driverNotifRef = db.collection("notifications").doc();
      await driverNotifRef.set({
        userId: booking.driverId,
        title: '❌ Ride Booking Cancelled',
        text: `Your ride has been cancelled by passenger ${booking.passengerName}.`,
        type: 'booking',
        timestamp: new Date().toISOString(),
        read: false
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, status: 'Cancelled' })
      };
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action specified' })
      };
    }

  } catch (err) {
    console.error("Error processing booking action:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
