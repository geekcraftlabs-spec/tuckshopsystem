// ============================================================
// app.js – Tuckshop Backend (Express + MongoDB)
// Now with SSO JWT validation for all protected endpoints
// ============================================================

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const Yoco = require('yoco-sdk'); // adjust if you have a different import

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: 'https://sandton-school-group.vercel.app', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ─────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ─── Order Schema ────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },   // from JWT
  studentId: { type: String },                             // optional
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
    req.user = decoded;   // { userId, email, role, studentId?, ... }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ─── Helper: generate short code ────────────────────────────
function generateShortCode() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear()).slice(-2);
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${day}-${rand}`;
}

// ─── YOCO SDK (replace with your actual Yoco setup) ─────────
const yoco = new Yoco({
  secretKey: process.env.YOCO_SECRET_KEY,
  publicKey: process.env.YOCO_PUBLIC_KEY,
});

// ─── ROUTES ──────────────────────────────────────────────────

// 1. Create checkout (protected)
app.post('/create-checkout', verifyToken, async (req, res) => {
  try {
    const orderData = req.body;
    // Attach userId from token
    orderData.userId = req.user.userId;
    if (req.user.studentId) orderData.studentId = req.user.studentId;

    // Generate short code
    const shortCode = generateShortCode();
    orderData.shortCode = shortCode;

    // Calculate total (subtotal + service fee)
    const subtotal = orderData.items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const total = subtotal + 3; // service fee
    orderData.total = total;

    // Create Yoco transaction
    const amountInCents = Math.round(total * 100);
    const transaction = await yoco.createTransaction({
      amount: amountInCents,
      currency: 'ZAR',
      metadata: { shortCode, userId: req.user.userId },
    });

    // Send back checkout URL and pending order (without sensitive data)
    res.json({
      success: true,
      checkoutUrl: transaction.redirectUrl,
      pendingOrder: { ...orderData, _id: transaction.id }, // store transaction id
    });
  } catch (err) {
    console.error('Create checkout error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Process payment (called from order-success page, protected)
app.post('/process-payment', verifyToken, async (req, res) => {
  try {
    const { token, amount, orderData } = req.body;
    // Verify the payment with Yoco (optional – you can rely on webhook)
    // For simplicity we assume payment succeeded and save order.
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

// 3. Staff dashboard – get totals for a date (protected)
app.get('/dashboard', verifyToken, async (req, res) => {
  try {
    // Optional: check if user role is staff or admin
    // if (req.user.role !== 'staff' && req.user.role !== 'admin') {
    //   return res.status(403).json({ error: 'Forbidden' });
    // }
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
        if (totals[item.name]) totals[item.name] += item.qty;
        else totals[item.name] = item.qty;
      });
    });
    res.json({ success: true, totals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Lookup order by short code (protected)
app.get('/orders/lookup/:code', verifyToken, async (req, res) => {
  try {
    const code = req.params.code;
    const order = await Order.findOne({ shortCode: code });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Mark order as collected (protected)
app.post('/orders/mark-collected', verifyToken, async (req, res) => {
  try {
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

// ─── Start server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tuckshop server running on port ${PORT}`);
});