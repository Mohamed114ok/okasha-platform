const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jwt-simple');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();

// ==================== 1. الإعدادات والوسائط (Middlewares) ====================

// السماح بالطلبات من أي مصدر (CORS)
app.use(cors());

// معالجة بيانات JSON و Form Data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// تعطيل قيود CSP لمنع حظر السكريبتات المباشرة والأزرار في الصفحة
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// معالجة طلب أيقونة المفضلة favicon لمنع خطأ 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// إتاحة قراءة الملفات الثابتة من مجلد public الموجود داخل backend
const publicDirectoryPath = path.join(__dirname, 'public');
app.use(express.static(publicDirectoryPath));

// إعداد التخزين المؤقت في الذاكرة لتوافق رفع الملفات مع Vercel
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 ميجابايت كحد أقصى
});

// المفتاح السري وتأكيد الاتصال بقاعدة البيانات
const JWT_SECRET = process.env.JWT_SECRET || 'okasha_secret_key_2026';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/okasha_platform';

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بقاعدة البيانات بنجاح'))
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// ==================== 2. نماذج قاعدة البيانات (Schemas & Models) ====================

// نموذج المستخدمين (طالب / معلم)
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  parentPhone: { type: String },
  stage: { type: String, required: true },
  grade: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['student', 'admin'], default: 'student' },
  status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);

// نموذج الدروس
const lessonSchema = new mongoose.Schema({
  title: { type: String, required: true },
  stage: { type: String },
  grade: { type: String },
  content: { type: String },
  videoUrl: { type: String },
  driveUrl: { type: String },
  pdfUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const Lesson = mongoose.model('Lesson', lessonSchema);

// نموذج الامتحانات
const examSchema = new mongoose.Schema({
  title: { type: String, required: true },
  stage: { type: String },
  grade: { type: String },
  questions: [
    {
      questionText: { type: String, required: true },
      options: [{ type: String, required: true }],
      correctAnswerIndex: { type: Number, required: true },
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

const Exam = mongoose.model('Exam', examSchema);

// نموذج نتائج الامتحانات
const resultSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  studentName: { type: String, required: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  examTitle: { type: String, required: true },
  score: { type: Number, required: true },
  total: { type: Number, required: true },
  percentage: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Result = mongoose.model('Result', resultSchema);

// ==================== 3. وسائط التوثيق (Auth Middlewares) ====================

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'يرجى تسجيل الدخول أولاً' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.decode(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'المستخدم غير موجود' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'رمز التوثيق غير صالح' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'غير مصرح لك بالوصول لهذه الصفحة' });
  }
};

// ==================== 4. المسارات البرمجية (API Routes) ====================

// تسجيل طالب جديد
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, parentPhone, stage, grade, username, password } = req.body;
    
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'اسم المستخدم مستخدم بالفعل' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      phone,
      parentPhone,
      stage,
      grade,
      username,
      password: hashedPassword,
      role: 'student',
      status: 'pending',
    });

    await newUser.save();
    res.status(201).json({ message: 'تم تقديم طلب الانضمام بنجاح وبانتظار موافقة المعلم' });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ في التسجيل', error: err.message });
  }
});

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (user.role === 'student' && user.status !== 'approved') {
      return res.status(403).json({ message: 'حسابك ما زال بانتظار موافقة المعلم' });
    }

    const token = jwt.encode({ id: user._id, role: user.role }, JWT_SECRET);
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        grade: user.grade,
        stage: user.stage,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الدخول', error: err.message });
  }
});

// الحصول على بيانات المستخدم الحالي
app.get('/api/me', authenticate, (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      username: req.user.username,
      role: req.user.role,
      grade: req.user.grade,
      stage: req.user.stage,
    },
  });
});

// جلب قائمة الدروس
app.get('/api/lessons', authenticate, async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { grade: req.user.grade, stage: req.user.stage };
    const lessons = await Lesson.find(query).sort({ createdAt: -1 });
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب الدروس' });
  }
});

// جلب قائمة الامتحانات
app.get('/api/exams', authenticate, async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { grade: req.user.grade, stage: req.user.stage };
    const exams = await Exam.find(query).select('-questions.correctAnswerIndex').sort({ createdAt: -1 });
    res.json(exams);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب الامتحانات' });
  }
});

// جلب امتحان محدد مع الأسئلة
app.get('/api/exams/:id', authenticate, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id).select('-questions.correctAnswerIndex');
    if (!exam) return res.status(404).json({ message: 'الامتحان غير موجود' });
    res.json(exam);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب تفاصيل الامتحان' });
  }
});

// تسليم إجابات الامتحان وحساب الدرجة
app.post('/api/exams/:id/submit', authenticate, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: 'الامتحان غير موجود' });

    const { answers } = req.body;
    let score = 0;
    const total = exam.questions.length;

    exam.questions.forEach((q, index) => {
      if (answers[index] === q.correctAnswerIndex) {
        score++;
      }
    });

    const percentage = Math.round((score / total) * 100);
    const isPassed = percentage >= 50;

    const newResult = new Result({
      studentId: req.user._id,
      studentName: req.user.name,
      examId: exam._id,
      examTitle: exam.title,
      score,
      total,
      percentage,
    });
    await newResult.save();

    res.json({
      score,
      totalScore: total,
      percentage,
      isPassed,
      message: isPassed ? 'مبروك! لقد اجتزت الامتحان بنجاح 🌟' : 'حاول مرة أخرى في المرة القادمة 👍',
    });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في تقديم الإجابات' });
  }
});

// ==================== 5. لوحة المعلم (Admin Routes) ====================

// الطلاب المعلقون
app.get('/api/admin/pending-students', authenticate, requireAdmin, async (req, res) => {
  try {
    const students = await User.find({ role: 'student', status: 'pending' }).sort({ createdAt: -1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب قائمة الطلاب' });
  }
});

// الطلاب المقبولون
app.get('/api/admin/approved-students', authenticate, requireAdmin, async (req, res) => {
  try {
    const students = await User.find({ role: 'student', status: 'approved' }).sort({ createdAt: -1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب قائمة الطلاب' });
  }
});

// الإحصائيات
app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const approvedStudentsCount = await User.countDocuments({ role: 'student', status: 'approved' });
    const pendingStudentsCount = await User.countDocuments({ role: 'student', status: 'pending' });
    const lessonsCount = await Lesson.countDocuments();
    const examsCount = await Exam.countDocuments();

    res.json({
      approvedStudentsCount,
      pendingStudentsCount,
      lessonsCount,
      examsCount,
    });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب الإحصائيات' });
  }
});

// جميع النتائج
app.get('/api/admin/results', authenticate, requireAdmin, async (req, res) => {
  try {
    const results = await Result.find().sort({ createdAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ message: 'خطأ في جلب النتائج' });
  }
});

// قبول طالب
app.post('/api/admin/approve-student/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { status: 'approved' });
    res.json({ message: 'تم قبول الطالب بنجاح' });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في قبول الطالب' });
  }
});

// حذف طالب
app.delete('/api/admin/students/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'تم حذف الطالب بنجاح' });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في حذف الطالب' });
  }
});

// إضافة درس جديد
app.post('/api/admin/lessons', authenticate, requireAdmin, upload.single('pdfFile'), async (req, res) => {
  try {
    const { title, stage, grade, content, videoUrl, driveUrl } = req.body;
    let pdfUrl = driveUrl || '';

    // إذا تم أرفاق ملف PDF كـ Buffer
    if (req.file) {
      const base64Pdf = req.file.buffer.toString('base64');
      pdfUrl = `data:${req.file.mimetype};base64,${base64Pdf}`;
    }

    const newLesson = new Lesson({
      title,
      stage,
      grade,
      content,
      videoUrl,
      driveUrl,
      pdfUrl,
    });

    await newLesson.save();
    res.status(201).json({ message: 'تم نشر الدرس بنجاح', lesson: newLesson });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ في إضافة الدرس', error: err.message });
  }
});

// إضافة امتحان جديد
app.post('/api/admin/exams', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, stage, grade, questions } = req.body;

    const newExam = new Exam({
      title,
      stage,
      grade,
      questions,
    });

    await newExam.save();
    res.status(201).json({ message: 'تم إنشاء الامتحان بنجاح', exam: newExam });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ في إنشاء الامتحان', error: err.message });
  }
});

// ==================== 6. توجيه جميع الطلبات نحو index.html ====================

app.get('*', (req, res) => {
  // عدم تحويل مسارات API
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'المسار البرمجي غير موجود' });
  }
  res.sendFile(path.join(publicDirectoryPath, 'index.html'));
});

// ==================== 7. تشغيل الخادم والتصدير لـ Vercel ====================

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على المنفذ: http://localhost:${PORT}`);
  });
}

module.exports = app;
