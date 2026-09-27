require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const wishlistRoutes = require('./routes/wishlist');
const carsRoutes = require('./routes/cars');
const adminRoutes = require('./routes/admin');
const advisorRoutes = require('./routes/advisor');
const chatbotRoutes = require('./routes/chatbot');
const { router: pushRoutes } = require('./routes/push');
const aiFillRoutes = require('./routes/ai-fill');
const settingsRoutes = require('./routes/settings');
const dealersRouter = require('./routes/dealers');
const mediaRoutes = require('./routes/media');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/cars', carsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/advisor', advisorRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/admin', aiFillRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', dealersRouter);
app.use('/api/media', mediaRoutes);

app.listen(PORT, () => {
  console.log(`VINDEX backend running at http://localhost:${PORT}`);
});
