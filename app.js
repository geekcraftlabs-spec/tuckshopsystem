// ============================================================
// app.js – Tuckshop Backend (Express + MongoDB)
// SSO JWT validation, serverless-ready for Vercel
// WITH AUTO-HEADER INJECTION – No manual HTML editing needed
// ============================================================

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const fs = require('fs');

// ─── Yoco import (with fallback) ────────────────────────────
let Yoco;
try {
  Yoco = require('@yoco/sdk');
} catch (e) {
  console.warn('⚠️ Yoco SDK not found – using mock for development.');
  Yoco = class YocoMock {
    constructor() {}
    async createTransaction() {
      return { redirectUrl: '/mock-payment-success' };
    }
  };
}

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://sandtonschoolgroup.vercel.app',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── HEADER INJECTION MIDDLEWARE ─────────────────────────────
// This loads header.html once and injects it into every HTML response
// No need to manually edit any HTML files!
let headerHtml = '';
try {
  headerHtml = fs.readFileSync(path.join(__dirname, 'header.html'), 'utf8');
  console.log('✅ Header loaded successfully');
} catch (err) {
  console.warn('⚠️ header.html not found – serving pages without header.');
}

app.use((req, res, next) => {
  // Only process GET requests for HTML pages
  if (req.method !== 'GET') return next();
  if (!req.path.endsWith('.html') && req.path !== '/') return next();

  // Determine the file path
  let filePath = req.path === '/' ? '/index.html' : req.path;
  filePath = path.join(__dirname, 'public', filePath);

  // Check if file exists
  if (!fs.existsSync(filePath)) return next();

  // Read and inject header
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return next();

    let modified = data;
    if (headerHtml) {
      // Find the first <body> tag (case-insensitive)
      const bodyTagMatch = modified.match(/<body[^>]*>/i);
      if (bodyTagMatch) {
        const bodyTag = bodyTagMatch[0];
        // Insert headerHtml right after the body tag
        modified = modified.replace(bodyTag, bodyTag + '\n' + headerHtml);
      } else {
        // If no <body> tag, prepend header
        modified = headerHtml + modified;
      }
    }

    res.send(modified);
  });
});

// ─── Static files (AFTER injection middleware) ──────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB Connection (cached for serverless) ──────────────
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });
    cachedDb = conn;
    console.log('✅ MongoDB connected');
    return conn;
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    throw err;
  }
}

// ─── Order Schema ────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  studentId: { type: String },
  shortCode: { type: String, required: true, unique: true },
  name: String,
  surname: String,
  contact: String,
  pickupDate: Date,
  items: [{
    name: String,
    qty: Number,
    price: Number,
  }],
  total: Number,
  isCollected: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  paymentMethod: { type: String, default: 'yoco' },
  yocoTransactionId: String,
});
const Order = mongoose.model('Order', orderSchema);

// ─── JWT Middleware ──────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized – no token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ─── Staff role middleware ───────────────────────────────────
const requireStaff = (req, res, next) => {
  if (req.user.role !== 'staff' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden – staff only' });
  }
  next();
};

// ─── Helper: generate short code ────────────────────────────
function generateShortCode() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${day}-${rand}`;
}

// ─── YOCO instance ────────────────────────────────────────────
const yoco = new Yoco({
  secretKey: process.env.YOCO_SECRET_KEY,
  publicKey: process.env.YOCO_PUBLIC_KEY,
});

// ─── ROUTES ──────────────────────────────────────────────────

// 1. Create checkout (protected)
app.post('/create-checkout', verifyToken, async (req, res) => {
  try {
    await connectToDatabase();
    const orderData = req.body;
    orderData.userId = req.user.userId;
    if (req.user.studentId) orderData.studentId = req.user.studentId;

    const shortCode = generateShortCode();
    orderData.shortCode = shortCode;

    const subtotal = orderData.items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const total = subtotal + 3;
    orderData.total = total;

    const amountInCents = Math.round(total * 100);
    const transaction = await yoco.createTransaction({
      amount: amountInCents,
      currency: 'ZAR',
      metadata: { shortCode, userId: req.user.userId },
    });

    res.json({
      success: true,
      checkoutUrl: transaction.redirectUrl,
      pendingOrder: { ...orderData, _id: transaction.id },
    });
  } catch (err) {
    console.error('Create checkout error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Process payment (called from order-success page, protected)
app.post('/process-payment', verifyToken, async (req, res) => {
  try {
    await connectToDatabase();
    const { token, amount, orderData } = req.body;
    const newOrder = new Order({
      ...orderData,
      userId: req.user.userId,
      paymentMethod: 'yoco',
    });
    await newOrder.save();
    res.json({ success: true, order: newOrder });
  } catch (err) {
    console.error('Process payment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Staff dashboard – get totals for a date (protected + staff only)
app.get('/dashboard', verifyToken, requireStaff, async (req, res) => {
  try {
    await connectToDatabase();
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Date required' });
    const start = new Date(date);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);

    const orders = await Order.find({
      pickupDate: { $gte: start, $lt: end },
      isCollected: false,
    });

    const totals = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        totals[item.name] = (totals[item.name] || 0) + item.qty;
      });
    });
    res.json({ success: true, totals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Lookup order by short code (protected + staff only)
app.get('/orders/lookup/:code', verifyToken, requireStaff, async (req, res) => {
  try {
    await connectToDatabase();
    const code = req.params.code;
    const order = await Order.findOne({ shortCode: code });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Mark order as collected (protected + staff only)
app.post('/orders/mark-collected', verifyToken, requireStaff, async (req, res) => {
  try {
    await connectToDatabase();
    const { shortCode } = req.body;
    const order = await Order.findOneAndUpdate(
      { shortCode },
      { isCollected: true },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Export for Vercel (serverless) ──────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Tuckshop server running on port ${PORT}`);
  });
}

module.exports = app;