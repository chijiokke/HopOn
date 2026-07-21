const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'hopon-50e05'
  });
}
const db = admin.firestore();

// Helper function to verify Stripe Webhook signature
function verifyStripeSignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader || !webhookSecret) {
    return false;
  }

  // Parse stripe-signature header
  const parts = signatureHeader.split(',');
  let timestamp = '';
  const signatures = [];

  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key === 't') {
      timestamp = val;
    } else if (key === 'v1') {
      signatures.push(val);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  // Check timestamp age (within 5 minutes) to protect against replay attacks
  const tolerance = 300; 
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > tolerance) {
    return false;
  }

  // Compute HMAC signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const computedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload)
    .digest('hex');

  // Securely compare signature hashes
  for (const sig of signatures) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(computedSignature, 'hex'))) {
        return true;
      }
    } catch (e) {
      // Catch buffer length mismatch errors
    }
  }

  return false;
}

async function processSuccessfulPayment(paymentIntentId, metadata) {
  const paymentRef = db.collection("payments").doc(paymentIntentId);

  // Firestore transaction to process payments idempotently
  await db.runTransaction(async (transaction) => {
    const paymentSnap = await transaction.get(paymentRef);
    if (paymentSnap.exists) {
      console.log(`Payment intent ${paymentIntentId} has already been processed.`);
      return;
    }

    const {
      checkoutType,
      passengerId,
      passengerName,
      driverId,
      driverName,
      cargoId,
      rideId,
      route,
      price,
      method,
      promoCode
    } = metadata;

    const parsedPrice = parseFloat(price) || 0;

    // 1. Create a payment receipt
    const paymentData = {
      passengerId,
      passengerName,
      driverId,
      driverName,
      route,
      price: parsedPrice,
      method,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'completed',
      stripePaymentIntentId: paymentIntentId
    };

    if (checkoutType === 'cargo') {
      paymentData.cargoId = cargoId;
    } else if (checkoutType === 'ride') {
      paymentData.rideId = rideId;
    }

    transaction.set(paymentRef, paymentData);

    // 2. Perform DB modifications based on payment type
    if (checkoutType === 'cargo') {
      // Update Cargo Status
      const cargoRef = db.collection("cargo").doc(cargoId);
      transaction.update(cargoRef, { status: "Paid" });

      // Notify Driver/Carrier
      const carrierMsg = `Shipper paid for cargo "${route}". You can now proceed to pick up the package!`;
      const notificationRef = db.collection("notifications").doc();
      transaction.set(notificationRef, {
        userId: driverId,
        title: '💳 Cargo Shipment Paid',
        text: carrierMsg,
        type: 'cargo',
        timestamp: new Date().toISOString(),
        read: false
      });

    } else if (checkoutType === 'ride') {
      // Retrieve original ride details if available
      let from = route.split(' ')[0] || 'Downtown';
      let to = route.split(' ')[1] || 'University';
      let date = 'Jun 19, 2026';
      let time = '10:30 AM';

      const rideRef = db.collection("rides").doc(rideId);
      const rideSnap = await transaction.get(rideRef);
      if (rideSnap.exists) {
        const rideData = rideSnap.data();
        from = rideData.from || from;
        to = rideData.to || to;
        date = rideData.date || date;
        time = rideData.time || time;
      }

      // Create Booking document (initial status is Pending approval by driver)
      const bookingRef = db.collection("bookings").doc();
      transaction.set(bookingRef, {
        rideId,
        passengerId,
        passengerName,
        driverId,
        driverName,
        from,
        to,
        date,
        time,
        price: `$${parsedPrice.toFixed(2)}`,
        status: 'Pending',
        stripePaymentIntentId: paymentIntentId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Mark the Promo Code as used
      if (promoCode) {
        const userRef = db.collection('users').doc(passengerId);
        transaction.update(userRef, {
          promoCode: '',
          promoDiscount: 0,
          promoDiscountAmount: 0
        });
      }

      // Send Passenger Confirmation Notification
      const notifRef1 = db.collection("notifications").doc();
      transaction.set(notifRef1, {
        userId: passengerId,
        title: '📅 Ride Request Sent',
        text: `Your booking request with ${driverName} from ${from} to ${to} has been sent!`,
        type: 'booking',
        timestamp: new Date().toISOString(),
        read: false
      });

      // Send Driver Booking Notification
      const notifRef2 = db.collection("notifications").doc();
      transaction.set(notifRef2, {
        userId: driverId,
        title: '📅 New Ride Request',
        text: `New booking request from ${passengerName} for ${from} → ${to}.`,
        type: 'booking',
        timestamp: new Date().toISOString(),
        read: false
      });
    }
  });

  // Post-transactional side-effects
  const { checkoutType, passengerId, passengerName, driverId, driverName, route, promoCode } = metadata;

  if (checkoutType === 'ride') {
    // Mark promo discount code state as Used
    if (promoCode) {
      try {
        const discSnap = await db.collection("users").doc(passengerId).collection("discounts")
          .where("code", "==", promoCode)
          .get();
        if (!discSnap.empty) {
          const batch = db.batch();
          discSnap.forEach(doc => {
            batch.update(doc.ref, { status: "Used", expiryText: "Used" });
          });
          await batch.commit();
        }
      } catch (e) {
        console.error("Error updating promo code status in subcollection:", e);
      }
    }

    // Auto-create Chat room in Firestore and write pending request message
    try {
      const chatRoomId = [passengerId, driverId].sort().join('_');
      const from = route.split(' ')[0] || 'Downtown';
      const to = route.split(' ')[1] || 'University';
      const welcomeText = `Hello! I have requested a ride from ${from} to ${to}. Waiting for approval...`;

      await db.collection("chats").doc(chatRoomId).set({
        participants: [passengerId, driverId],
        names: {
          [passengerId]: passengerName,
          [driverId]: driverName
        },
        avatars: {
          [passengerId]: '👨‍🎓',
          [driverId]: driverName.charAt(0)
        },
        lastMessage: welcomeText,
        lastTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        unread: {
          [passengerId]: 0,
          [driverId]: 1
        }
      }, { merge: true });

      await db.collection("chats").doc(chatRoomId).collection("messages").add({
        senderId: passengerId,
        text: welcomeText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (chatErr) {
      console.error("Error creating chat channel in webhook:", chatErr);
    }
  }
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
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

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  // Verify signature if webhook secret is configured
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signatureHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
      console.error("Webhook Signature verification failed.");
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid webhook signature' })
      };
    }
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.error("STRIPE_WEBHOOK_SECRET is not configured in production. Rejecting request.");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Webhook secret is not configured' })
      };
    } else {
      console.warn("STRIPE_WEBHOOK_SECRET is not configured. Bypassing signature verification (development mode).");
    }
  }

  try {
    const stripeEvent = JSON.parse(rawBody);
    console.log(`Received Stripe Webhook: ${stripeEvent.type}`);

    if (stripeEvent.type === 'payment_intent.succeeded') {
      const paymentIntent = stripeEvent.data.object;
      const metadata = paymentIntent.metadata || {};

      if (metadata.checkoutType) {
        await processSuccessfulPayment(paymentIntent.id, metadata);
        console.log(`Successfully processed checkout payment for: ${metadata.checkoutType}`);
      } else {
        console.log("No custom checkoutType metadata found; ignoring event.");
      }
    } else if (stripeEvent.type === 'account.updated') {
      const account = stripeEvent.data.object;
      if (account.payouts_enabled && account.external_accounts && account.external_accounts.data.length > 0) {
        const bank = account.external_accounts.data[0];
        const driverSnap = await db.collection("users")
          .where("stripeConnectedAccountId", "==", account.id)
          .limit(1)
          .get();
        if (!driverSnap.empty) {
          const driverDoc = driverSnap.docs[0];
          await driverDoc.ref.update({
            bank_info: {
              bankName: bank.bank_name || 'Connected Bank Account',
              accountMasked: bank.last4 || '••••',
              routingMasked: bank.routing_number ? bank.routing_number.slice(-3) : '•••'
            }
          });
          console.log(`Updated bank info for driver: ${driverDoc.id}`);
        }
      }

    // ── Stripe Identity: Verification Approved ──
    } else if (stripeEvent.type === 'identity.verification_session.verified') {
      const session = stripeEvent.data.object;
      const userId = session.metadata && session.metadata.userId;
      if (userId) {
        // Extract verified name and DOB from Stripe (if available)
        const verifiedOutputs = session.last_verification_report || {};
        const verifiedName = (verifiedOutputs.document && verifiedOutputs.document.name)
          ? `${verifiedOutputs.document.name.first_name || ''} ${verifiedOutputs.document.name.last_name || ''}`.trim()
          : null;

        await db.collection('users').doc(userId).update({
          isDriverVerified: true,
          driverVerificationStatus: 'verified',
          driverVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          stripeIdentitySessionId: session.id,
          ...(verifiedName && { stripeVerifiedName: verifiedName })
        });

        // Send in-app notification to driver
        await db.collection('notifications').add({
          userId,
          title: '🛡️ Identity Verified!',
          text: 'Your driver identity has been verified by Stripe. You can now accept rides!',
          type: 'verification',
          timestamp: new Date().toISOString(),
          read: false
        });

        console.log(`Driver identity verified via Stripe Identity for user: ${userId}`);
      }

    // ── Stripe Identity: Verification Failed / Requires Input ──
    } else if (stripeEvent.type === 'identity.verification_session.requires_input') {
      const session = stripeEvent.data.object;
      const userId = session.metadata && session.metadata.userId;
      if (userId) {
        const lastError = session.last_error || {};
        const reason = lastError.reason || 'unknown';
        const reasonMessages = {
          'document_unverified_other': 'We could not verify your document. Please try again with a clearer photo.',
          'document_expired': 'Your ID appears to be expired. Please use a valid, non-expired document.',
          'document_type_not_supported': 'That document type is not supported. Please use a driver\'s licence, passport, or government ID.',
          'selfie_document_missing_photo': 'The selfie did not match the ID photo. Please try again in good lighting.',
          'selfie_face_mismatch': 'The selfie did not match the ID photo. Please ensure your face is clearly visible.',
          'id_number_unverified_other': 'We could not verify your ID number. Please ensure all details are correct.',
          'consent_declined': 'Verification was cancelled. Please try again when ready.',
          'under_supported_age': 'You must be 18 or older to drive on HopOn.'
        };
        const friendlyReason = reasonMessages[reason] || 'Verification could not be completed. Please try again.';

        await db.collection('users').doc(userId).update({
          isDriverVerified: false,
          driverVerificationStatus: 'failed',
          driverVerificationFailReason: friendlyReason,
          stripeIdentitySessionId: session.id
        });

        // Notify driver of failure with reason
        await db.collection('notifications').add({
          userId,
          title: '❌ Verification Failed',
          text: friendlyReason,
          type: 'verification',
          timestamp: new Date().toISOString(),
          read: false
        });

        console.log(`Driver identity verification FAILED for user: ${userId} — reason: ${reason}`);
      }
    } // end event type handler

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true })
    };
  } catch (err) {
    console.error("Error processing Stripe webhook:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
