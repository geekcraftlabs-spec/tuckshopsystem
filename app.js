// app.js - GHS Tuckshop Backend

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ghs_tuckshop';
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ MongoDB connected successfully!'))
.catch(err => console.error('MongoDB connection error:', err));

// === COUNTER FOR DAILY 3-DIGIT CODE ===
const counterSchema = new mongoose.Schema({
  date: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// === ORDER SCHEMA ===
const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, unique: true },
  shortCode: { type: String, required: true },
  pickupDate: { type: Date, required: true },
  name: { type: String, required: true },
  surname: { type: String, required: true },
  contact: { type: String, required: true },
  items: [{
    name: String,
    qty: Number,
    price: Number
  }],
  total: { type: Number, required: true },
  isCollected: { type: Boolean, default: false },
  collectedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// === DAILY STOCK SCHEMA ===
const dailyStockSchema = new mongoose.Schema({
  date: { type: String, required: true },
  itemName: { type: String, required: true },
  limit: { type: Number, required: true },
  orderedQty: { type: Number, default: 0 }
});
const DailyStock = mongoose.model('DailyStock', dailyStockSchema);

// === GENERATE DATE-PREFIXED SHORT CODE ===
async function getNextShortCode(pickupDate) {
  const date = new Date(pickupDate);
  const day = date.getDate().toString().padStart(2, '0');
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

  let counter = await Counter.findOne({ date: dateStr });

  if (!counter) {
    counter = new Counter({ date: dateStr, seq: 1 });
  } else {
    counter.seq += 1;
  }
  await counter.save();

  const seq = counter.seq.toString().padStart(3, '0');
  const shortCode = `${day}-${seq}`;
  const fullOrderNumber = `${dateStr}-${seq}`;

  return { fullOrderNumber, shortCode };
}

// Nodemailer Setup - Using Brevo SMTP (Updated)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp-relay.brevo.com',
  port: process.env.EMAIL_PORT || 587,
  secure: false, // false for port 587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// YOCO Test Secret Key
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY || 'sk_test_9321b248L1zMAZr396f4b95b6cef';

// === DEBUG: Test route ===
app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Server is working!' });
});

// === DEBUG: Get all orders ===
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ createdAt: -1 }).limit(10);
    res.json({ success: true, orders });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// === CREATE YOCO CHECKOUT SESSION ===
app.post('/create-checkout', async (req, res) => {
  console.log('📦 /create-checkout called');
  
  try {
    const { pickupDate, name, surname, contact, items, total } = req.body;

    if (!pickupDate || !name || !surname || !contact || !items?.length) {
      console.log('❌ Missing fields');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const amount = Math.round(total * 100);
    const { fullOrderNumber, shortCode } = await getNextShortCode(pickupDate);
    
    console.log(`✅ Generated order number: ${fullOrderNumber}, shortCode: ${shortCode}`);

    const lineItems = items.map(item => ({
      displayName: item.name,
      quantity: item.qty,
      pricingDetails: { price: Math.round(item.price * 100) }
    }));

    const checkoutResponse = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount,
        currency: 'ZAR',
        lineItems,
        successUrl: `${BASE_URL}/order-success.html?code=${shortCode}`,
        cancelUrl: `${BASE_URL}/cart.html`,
        metadata: { pickupDate }
      })
    });

    const checkoutData = await checkoutResponse.json();

    if (checkoutResponse.ok && checkoutData.redirectUrl) {
      const pendingOrder = {
        orderNumber: fullOrderNumber,
        shortCode: shortCode,
        pickupDate: pickupDate,
        name: name,
        surname: surname,
        contact: contact,
        items: items,
        total: total
      };
      
      console.log(`✅ YOCO session created for order: ${shortCode}`);
      
      res.json({ 
        success: true, 
        checkoutUrl: checkoutData.redirectUrl,
        pendingOrder: pendingOrder
      });
    } else {
      console.log('❌ YOCO error:', checkoutData);
      res.status(400).json({ success: false, error: checkoutData.message || 'YOCO error' });
    }
  } catch (error) {
    console.error('❌ Checkout creation error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// === PROCESS PAYMENT AND SAVE ORDER ===
app.post('/process-payment', async (req, res) => {
  console.log('💰 /process-payment called');
  
  try {
    const { token, amount, orderData } = req.body;

    // Handle redirect from success page (dummy token)
    if (token === 'redirect_success') {
      console.log("📝 Redirect success - saving order without YOCO verification");
      
      const existingOrder = await Order.findOne({ orderNumber: orderData.orderNumber });
      if (existingOrder) {
        return res.json({ success: true, shortCode: existingOrder.shortCode });
      }

      const newOrder = new Order({
        orderNumber: orderData.orderNumber,
        shortCode: orderData.shortCode,
        pickupDate: new Date(orderData.pickupDate),
        name: orderData.name,
        surname: orderData.surname,
        contact: orderData.contact,
        items: orderData.items,
        total: orderData.total
      });

      await newOrder.save();
      console.log(`✅ Order SAVED via redirect: ${orderData.shortCode}`);
      
      // SEND EMAIL WITH BREVO
      console.log(`📧 Attempting to send email to: ${orderData.contact}`);
      console.log(`📧 EMAIL_HOST: ${process.env.EMAIL_HOST}`);
      console.log(`📧 EMAIL_USER: ${process.env.EMAIL_USER}`);
      
      const mailOptions = {
        from: `"GHS Tuckshop" <${process.env.EMAIL_USER}>`,
        to: orderData.contact,
        subject: `GHS Tuckshop - Order Confirmed (${orderData.shortCode})`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; }
              .header { background: #800000; color: white; padding: 15px; text-align: center; border-radius: 10px 10px 0 0; }
              .order-code { font-size: 24px; font-weight: bold; color: #800000; text-align: center; margin: 20px 0; }
              .items { margin: 20px 0; }
              .total { font-size: 18px; font-weight: bold; text-align: right; border-top: 2px solid #ddd; padding-top: 10px; }
              .footer { text-align: center; font-size: 12px; color: #666; margin-top: 20px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h2>✅ Order Confirmed!</h2>
              </div>
              <p>Dear ${orderData.name} ${orderData.surname},</p>
              <p>Thank you for using the GHS Online Tuckshop!</p>
              
              <div class="order-code">
                Your Order Code: <strong>${orderData.shortCode}</strong>
              </div>
              
              <p><strong>Pickup Date:</strong> ${new Date(orderData.pickupDate).toDateString()}</p>
              
              <div class="items">
                <h3>Items Ordered:</h3>
                <ul>
                  ${orderData.items.map(item => `<li>${item.qty}x ${item.name} @ R${item.price}</li>`).join('')}
                </ul>
              </div>
              
              <div class="total">
                Total: R${orderData.total.toFixed(2)} (incl. R3 service fee)
              </div>
              
              <p>Collect at the tuckshop. See you soon! 🚀</p>
              
              <div class="footer">
                <p>Glenvista High School Tuckshop</p>
              </div>
            </div>
          </body>
          </html>
        `
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent successfully!`);
        console.log(`📧 Message ID: ${info.messageId}`);
        console.log(`📧 Sent to: ${orderData.contact}`);
      } catch (emailErr) {
        console.error(`❌ Email failed: ${emailErr.code || emailErr.responseCode || 'unknown'} - ${emailErr.message}`);
        console.error(`📧 Full error details:`, JSON.stringify(emailErr, null, 2));
      }
      
      return res.json({ success: true, shortCode: orderData.shortCode });
    }

    // Normal YOCO payment flow
    if (!token || !amount || !orderData) {
      console.log('❌ Missing payment data');
      return res.status(400).json({ success: false, error: 'Missing payment data' });
    }

    // Verify payment with YOCO
    const verifyResponse = await fetch('https://payments.yoco.com/api/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        token,
        amount,
        currency: 'ZAR',
        metadata: { orderId: orderData.orderNumber }
      })
    });

    const chargeResult = await verifyResponse.json();

    if (!verifyResponse.ok) {
      console.error('❌ YOCO charge failed:', chargeResult);
      return res.status(400).json({ success: false, error: chargeResult.message || 'Payment failed' });
    }

    console.log(`✅ YOCO payment verified for order: ${orderData.orderNumber}`);

    // Check if order already exists
    const existingOrder = await Order.findOne({ orderNumber: orderData.orderNumber });
    if (existingOrder) {
      console.log(`⚠️ Order already exists: ${orderData.shortCode}`);
      return res.json({ success: true, shortCode: existingOrder.shortCode });
    }

    // Save order to database
    const newOrder = new Order({
      orderNumber: orderData.orderNumber,
      shortCode: orderData.shortCode,
      pickupDate: new Date(orderData.pickupDate),
      name: orderData.name,
      surname: orderData.surname,
      contact: orderData.contact,
      items: orderData.items,
      total: orderData.total
    });

    await newOrder.save();
    console.log(`✅ Order SAVED after payment: ${orderData.shortCode}`);

    // Send email confirmation
    const mailOptions = {
      from: `"GHS Tuckshop" <${process.env.EMAIL_USER}>`,
      to: orderData.contact,
      subject: `GHS Tuckshop - Order Confirmed (${orderData.shortCode})`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; }
            .header { background: #800000; color: white; padding: 15px; text-align: center; border-radius: 10px 10px 0 0; }
            .order-code { font-size: 24px; font-weight: bold; color: #800000; text-align: center; margin: 20px 0; }
            .items { margin: 20px 0; }
            .total { font-size: 18px; font-weight: bold; text-align: right; border-top: 2px solid #ddd; padding-top: 10px; }
            .footer { text-align: center; font-size: 12px; color: #666; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>✅ Order Confirmed!</h2>
            </div>
            <p>Dear ${orderData.name} ${orderData.surname},</p>
            <p>Thank you for using the GHS Online Tuckshop!</p>
            
            <div class="order-code">
              Your Order Code: <strong>${orderData.shortCode}</strong>
            </div>
            
            <p><strong>Pickup Date:</strong> ${new Date(orderData.pickupDate).toDateString()}</p>
            
            <div class="items">
              <h3>Items Ordered:</h3>
              <ul>
                ${orderData.items.map(item => `<li>${item.qty}x ${item.name} @ R${item.price}</li>`).join('')}
              </ul>
            </div>
            
            <div class="total">
              Total: R${orderData.total.toFixed(2)} (incl. R3 service fee)
            </div>
            
            <p>Collect at the tuckshop. See you soon! 🚀</p>
            
            <div class="footer">
              <p>Glenvista High School Tuckshop</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully! Message ID: ${info.messageId}`);
    } catch (emailErr) {
      console.error(`❌ Email send failed: ${emailErr.message}`);
    }

    res.json({ success: true, shortCode: orderData.shortCode });

  } catch (error) {
    console.error('❌ Process payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === STAFF DASHBOARD: Totals for a date ===
app.get('/dashboard', async (req, res) => {
  try {
    let dateParam = req.query.date;
    let startDate, endDate;

    if (dateParam) {
      const d = new Date(dateParam);
      startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
    } else {
      const today = new Date();
      startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
    }

    const orders = await Order.find({
      pickupDate: { $gte: startDate, $lt: endDate }
    });

    if (orders.length === 0) {
      return res.json({ success: true, totals: {}, message: 'No orders found for this date' });
    }

    const totals = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        totals[item.name] = (totals[item.name] || 0) + (item.qty || 0);
      });
    });

    res.json({ success: true, totals });
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load totals' });
  }
});

// === STAFF: Lookup by code ===
app.get('/orders/lookup/:code', async (req, res) => {
  try {
    const code = req.params.code.trim();
    const order = await Order.findOne({ shortCode: code });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// === STAFF: Mark as collected ===
app.post('/orders/mark-collected', async (req, res) => {
  try {
    const { shortCode } = req.body;
    const order = await Order.findOne({ shortCode });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.isCollected) return res.json({ success: false, error: 'Already collected' });

    order.isCollected = true;
    order.collectedAt = new Date();
    await order.save();

    res.json({ success: true, message: 'Marked as collected' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Test API at: http://localhost:${PORT}/api/test`);
  console.log(`📋 View orders at: http://localhost:${PORT}/api/orders`);
});