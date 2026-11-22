const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const db = require('./db');
const settings = require('./lib/settings');
const bidding = require('./lib/bidding');
const worker = require('./lib/worker');
const seed = require('./seed');
const mw = require('./middleware');

const PROD = process.env.NODE_ENV === 'production';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (PROD && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');

  await db.init();
  await seed.run();
  await settings.load();

  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of the app
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
        connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        formAction: ["'self'"],
        upgradeInsecureRequests: PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '1h' : 0 }));
  app.use('/vendor/quill', express.static(path.join(__dirname, '..', 'node_modules', 'quill', 'dist'), { maxAge: PROD ? '7d' : 0 }));
  app.get('/healthz', (req, res) => res.send('ok'));

  // Razorpay signs the raw request body, so the webhook must see it unparsed.
  app.use('/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '100kb' }));

  const sessionMw = session({
    store: new PgStore({ pool: db.pool, createTableIfMissing: true }),
    name: 'ka.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 60 * 60 * 1000 },
  });
  app.use(sessionMw);

  // The webhook is authenticated by its signature, not by a session, so it sits before CSRF.
  app.use(require('./routes/webhook'));

  app.use(mw.flash, mw.context, mw.pages, mw.csrf);

  app.use(require('./routes/media'));
  app.use('/admin', require('./routes/admin'));

  // Maintenance mode closes the public site; admins are unaffected.
  app.use((req, res, next) => {
    if (!settings.bool('maintenance_mode')) return next();
    res.status(503).render('error', { title: 'Back soon', message: settings.get('maintenance_message') });
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/account'));
  app.use(require('./routes/site'));

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'This page does not exist or has been moved.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      req.flash && req.flash('error', 'That file is larger than 8 MB. Upload a smaller file.');
      return res.redirect(req.get('referer') || '/');
    }
    console.error(err);
    if ((req.get('accept') || '').includes('json')) return res.status(500).json({ error: 'Something went wrong. Try again.' });
    res.status(500).render('error', { title: 'Something went wrong', message: 'The request could not be completed. Try again in a moment.' });
  });

  const server = http.createServer(app);
  const io = new Server(server);
  io.engine.use(sessionMw);
  io.on('connection', (socket) => {
    const sess = socket.request.session || {};
    if (sess.userId) socket.join('user:' + sess.userId);
    socket.on('watch', (auctionId) => {
      const id = parseInt(auctionId, 10);
      if (Number.isFinite(id)) socket.join('auction:' + id);
    });
  });
  bidding.attach(io);
  worker.start();

  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Kasturi Auction listening on :${port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
