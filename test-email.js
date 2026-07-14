// test-email.js - Run this to test if email works
require('dotenv').config();
const nodemailer = require('nodemailer');

async function testEmail() {
  console.log('📧 Testing email configuration...');
  console.log('EMAIL_USER:', process.env.EMAIL_USER);
  console.log('EMAIL_PASS exists:', !!process.env.EMAIL_PASS);
  
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
  });
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: 'geekcraftlabs@gmail.com', // Change to your email to test
    subject: 'Test Email from GHS Tuckshop',
    html: '<h2>Test Email</h2><p>If you received this, email is working!</p>'
  };
  
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully!');
    console.log('Message ID:', info.messageId);
  } catch (error) {
    console.error('❌ Email failed:', error.message);
    console.error('Full error:', error);
  }
}

testEmail();