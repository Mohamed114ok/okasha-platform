require('dotenv').config();
'use strict';

/*
 * =========================================================
 * منصة أ/ أحمد عكاشة - اللغة العربية
 * Backend - جاهز للرفع على Vercel
 * =========================================================
 */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { put } = require('@vercel/blob');

const app = express();

/* =========================================================
   1) Environment Variables
   ========================================================= */

const PORT = Number(process.env.PORT || 5000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGO_URI = process.env.MONGO_URI || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'أحمد عكاشة';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

/* =========================================================
   2) Basic configuration validation
   ========================================================= */

if (!MONGO_URI) console.warn('⚠️ MONGO_URI غير موجود في Environment Variables');
if (!JWT_SECRET) console.warn('⚠️ JWT_SECRET غير موجود في Environment Variables');
if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn('⚠️ BLOB_READ_WRITE_TOKEN غير موجود. لن تتمكن من رفع ملفات PDF.');

/* =========================================================
   3) Security / Middleware
   ========================================================= */

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

const allowedOrigins = FRONTEND_URL
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS: Origin غير مسموح به'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

/* =========================================================
   4) Rate Limiting
   ========================================================= */

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'طلبات كثيرة جدًا، حاول مرة أخرى بعد قليل' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'محاولات كثيرة، حاول مرة أخرى بعد قليل' }
});

app.use('/api', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

/* =========================================================
   5) MongoDB Connection (Serverless Ready)
   ========================================================= */

let cached = global.__okashaMongo;

if (!cached) {
  cached = global.__okashaMongo = { conn: null, promise: null };
}

async function connectDB() {
  if (!MONGO_URI) throw new Error('MONGO_URI is missing');
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
      .then((mongooseInstance) => {
        console.log('✅ تم الاتصال بـ MongoDB Atlas');
        return mongooseInstance;
      })
      .catch((error) => {
        cached.promise = null;
        throw error;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

/* =========================================================
   6) Schemas & Models
   ========================================================= */

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  phone: { type: String, required: true, trim: true, maxlength: 30 },
  parentPhone: { type: String, trim: true, maxlength: 30 },
  stage: { type: String, trim: true, maxlength: 50 },
  grade: { type: String, trim: true, maxlength: 100 },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, minlength: 3, maxlength: 40, match: /^[a-z0-9._-]+$/ },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'student'], default: 'student' },
  status: { type: String, enum: ['pending', 'approved'], default: 'pending' }
}, { timestamps: true });

const lessonSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  stage: { type: String, trim: true, maxlength: 50 },
  grade: { type: String, trim: true, maxlength: 100 },
  content: { type: String, trim: true, maxlength: 10000 },
  videoUrl: { type: String, trim: true, maxlength: 1000 },
  pdfUrl: { type: String, trim: true, maxlength: 2000 },
  driveUrl: { type: String, trim: true, maxlength: 1000 }
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true, trim: true, maxlength: 2000 },
  options: {
    type: [String],
    required: true,
    validate: { validator: (arr) => Array.isArray(arr) && arr.length === 4, message: 'يجب أن يحتوي السؤال على 4 اختيارات' }
  },
  correctAnswerIndex: { type: Number, required: true, min: 0, max: 3 }
}, { _id: true });

const examSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  stage: { type: String, trim: true, maxlength: 50 },
  grade: { type: String, trim: true, maxlength: 100 },
  questions: {
    type: [questionSchema],
    required: true,
    validate: { validator: (arr) => Array.isArray(arr) && arr.length >= 1 && arr.length <= 200, message: 'عدد الأسئلة يجب أن يكون بين 1 و200' }
  }
}, { timestamps: true });

const resultSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  studentName: { type: String, required: true },
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  examTitle: { type: String, required: true },
  score: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 1 },
  percentage: { type: Number, required: true, min: 0, max: 100 },
  grade: { type: String }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Lesson = mongoose.models.Lesson || mongoose.model('Lesson', lessonSchema);
const Exam = mongoose.models.Exam || mongoose.model('Exam', examSchema);
const Result = mongoose.models.Result || mongoose.model('Result', resultSchema);

/* =========================================================
   7) Helpers & Middlewares
   ========================================================= */

function cleanString(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function validObjectId(id) { return mongoose.isValidObjectId(id); }
function validPhone(value) { return /^[0-9+\s()-]{7,30}$/.test(value); }

function validUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

function publicUser(user) {
  return { _id: String(user._id), name: user.name, username: user.username, phone: user.phone, role: user.role, stage: user.stage, grade: user.grade, status: user.status };
}

function auth(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ message: 'إعدادات الأمان غير مكتملة' });
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'غير مصرح بالدخول' });
  const token = header.slice(7).trim();
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { issuer: 'okasha-platform', audience: 'okasha-users' });
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'رمز الدخول غير صالح أو منتهي' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'هذه العملية متاحة للمعلم فقط' });
  next();
}

let adminInitPromise = null;
async function createInitialAdmin() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  const username = ADMIN_USERNAME.trim().toLowerCase();
  const existingAdmin = await User.findOne({ role: 'admin' });
  if (existingAdmin) return;
  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await User.create({
    name: ADMIN_NAME, phone: ADMIN_PHONE || '0000000000', stage: 'عام', grade: 'عام',
    username, password: hashedPassword, role: 'admin', status: 'approved'
  });
  console.log(`✅ تم إنشاء حساب المعلم: ${username}`);
}

async function ensureDatabase(req, res, next) {
  try {
    await connectDB();
    if (!adminInitPromise) adminInitPromise = createInitialAdmin().catch(e => { adminInitPromise = null; throw e; });
    await adminInitPromise;
    next();
  } catch (error) {
    console.error('DB Error:', error);
    res.status(503).json({ message: 'تعذر الاتصال بقاعدة البيانات حاليًا' });
  }
}

app.use('/api', ensureDatabase);

/* =========================================================
   8) File Uploads
   ========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    if (!isPdf) return cb(new Error('يسمح برفع ملفات PDF فقط'));
    cb(null, true);
  }
});

async function uploadPdfToBlob(file) {
  if (!file) return '';
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('خدمة رفع الملفات غير مهيأة على السيرفر.');
  
  const safeName = `lessons/${Date.now()}-${crypto.randomUUID()}.pdf`;
  const blob = await put(safeName, file.buffer, {
    access: 'public',
    contentType: 'application/pdf',
    addRandomSuffix: false
  });
  return blob.url;
}

/* =========================================================
   9) API Routes
   ========================================================= */

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, message: 'الخادم يعمل بنجاح' });
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, parentPhone, stage, grade, username, password } = req.body;
    const cleanUsername = cleanString(username, 40).toLowerCase();
    
    if (!name || !phone || !stage || !grade || !cleanUsername || !password) {
      return res.status(400).json({ message: 'البيانات غير مكتملة' });
    }
    if (!validPhone(phone)) return res.status(400).json({ message: 'رقم الهاتف غير صحيح' });
    if (password.length < 8) return res.status(400).json({ message: 'كلمة المرور قصيرة جداً' });

    const existingUser = await User.findOne({ username: cleanUsername });
    if (existingUser) return res.status(409).json({ message: 'اسم المستخدم مسجل بالفعل' });

    const hashedPassword = await bcrypt.hash(password, 12);
    await User.create({
      name: cleanString(name, 100), phone, parentPhone: cleanString(parentPhone, 30),
      stage, grade, username: cleanUsername, password: hashedPassword, role: 'student', status: 'pending'
    });
    res.status(201).json({ message: 'تم إرسال طلب الانضمام بنجاح، بانتظار موافقة المعلم' });
  } catch (error) {
    res.status(500).json({ message: 'خطأ أثناء التسجيل' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = cleanString(req.body.username, 40).toLowerCase();
    const password = req.body.password;
    
    const user = await User.findOne({ username }).select('+password');
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'البيانات غير صحيحة' });
    }
    if (user.role === 'student' && user.status !== 'approved') {
      return res.status(403).json({ message: 'حسابك قيد المراجعة' });
    }

    const token = jwt.sign(
      { id: String(user._id), role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d', issuer: 'okasha-platform', audience: 'okasha-users' }
    );
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'خطأ في تسجيل الدخول' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });
    res.json({ user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'حدث خطأ' });
  }
});

// -- Lessons --
app.get('/api/lessons', auth, async (req, res) => {
  try {
    const filter = req.user.role === 'student' ? { grade: req.user.grade } : {};
    const lessons = await Lesson.find(filter).sort({ createdAt: -1 }).lean();
    res.json(lessons);
  } catch (error) {
    res.status(500).json({ message: 'خطأ في جلب الدروس' });
  }
});

app.post('/api/admin/lessons', auth, adminOnly, upload.single('pdfFile'), async (req, res) => {
  try {
    const { title, stage, grade, content, videoUrl, driveUrl } = req.body;
    let pdfUrl = '';
    if (req.file) {
      pdfUrl = await uploadPdfToBlob(req.file);
    }
    
    const lesson = await Lesson.create({ title, stage, grade, content, videoUrl, driveUrl, pdfUrl });
    res.status(201).json({ message: 'تم النشر بنجاح', data: lesson });
  } catch (error) {
    res.status(500).json({ message: error.message || 'خطأ في النشر' });
  }
});

app.delete('/api/admin/lessons/:id', auth, adminOnly, async (req, res) => {
  await Lesson.findByIdAndDelete(req.params.id);
  res.json({ message: 'تم الحذف' });
});

// -- Exams --
app.get('/api/exams', auth, async (req, res) => {
  try {
    const filter = req.user.role === 'student' ? { grade: req.user.grade } : {};
    const exams = await Exam.find(filter).sort({ createdAt: -1 }).select('-questions.correctAnswerIndex').lean();
    res.json(exams);
  } catch (error) {
    res.status(500).json({ message: 'خطأ في جلب الامتحانات' });
  }
});

app.get('/api/exams/:id', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id).select('-questions.correctAnswerIndex').lean();
    if (!exam) return res.status(404).json({ message: 'غير موجود' });
    res.json(exam);
  } catch (error) {
    res.status(500).json({ message: 'خطأ' });
  }
});

app.post('/api/exams/:id/submit', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: 'الامتحان غير موجود' });
    
    let score = 0;
    const answers = req.body.answers || [];
    exam.questions.forEach((q, idx) => {
      if (answers[idx] === q.correctAnswerIndex) score++;
    });
    
    const total = exam.questions.length;
    const percentage = Math.round((score / total) * 100);
    
    const result = await Result.create({
      student: req.user.id, studentName: req.user.name, exam: exam._id, examTitle: exam.title, score, total, percentage
    });
    res.status(201).json({ score, totalScore: total, percentage, data: result });
  } catch (error) {
    res.status(500).json({ message: 'خطأ أثناء التسليم' });
  }
});

app.post('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    await Exam.create(req.body);
    res.status(201).json({ message: 'تم إنشاء الامتحان' });
  } catch (error) {
    res.status(400).json({ message: 'تأكد من إدخال جميع بيانات الأسئلة بشكل صحيح' });
  }
});

app.delete('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  await Exam.findByIdAndDelete(req.params.id);
  res.json({ message: 'تم الحذف' });
});

// -- Admin Dashboard --
app.get('/api/admin/pending-students', auth, adminOnly, async (req, res) => {
  const students = await User.find({ status: 'pending', role: 'student' }).select('-password').sort({ createdAt: -1 });
  res.json(students.map(publicUser));
});

app.get('/api/admin/approved-students', auth, adminOnly, async (req, res) => {
  const students = await User.find({ status: 'approved', role: 'student' }).select('-password').sort({ createdAt: -1 });
  res.json(students.map(publicUser));
});

app.post('/api/admin/approve-student/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndUpdate(req.params.id, { status: 'approved' });
  res.json({ message: 'تم القبول' });
});

app.delete('/api/admin/reject-student/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'تم الرفض' });
});

app.delete('/api/admin/students/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'تم الحذف' });
});

app.get('/api/admin/results', auth, adminOnly, async (req, res) => {
  const results = await Result.find().sort({ createdAt: -1 }).limit(200);
  res.json(results);
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  const [approvedStudentsCount, pendingStudentsCount, lessonsCount, examsCount] = await Promise.all([
    User.countDocuments({ status: 'approved', role: 'student' }),
    User.countDocuments({ status: 'pending', role: 'student' }),
    Lesson.countDocuments(),
    Exam.countDocuments()
  ]);
  res.json({ approvedStudentsCount, pendingStudentsCount, lessonsCount, examsCount });
});

/* =========================================================
   10) Export for Vercel / Run Locally
   ========================================================= */

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

module.exports = app;