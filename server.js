const express = require('express');
const cors = require('cors');
const pool = require('./db');

// TEST DATABASE CONNECTION ON BOOT
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('CRITICAL: Failed to connect to the database on startup!');
    console.error('Detailed Error:', err.message);
  } else {
    console.log('SUCCESS: Connected to Neon Database at', res.rows[0].now);
  }
});

const path = require('path'); 
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type.'), false);
};

const upload = multer({ storage: storage, fileFilter: fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// ==========================================
// AUTHENTICATION
// ==========================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));

app.post('/api/signup', async (req, res) => {
  const { name, email, password, role, rollNumber, year, section } = req.body;
  try {
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
    const userRole = role.toLowerCase().trim();
    const finalRoll = (userRole === 'student' && rollNumber) ? rollNumber.trim() : null;
    const finalYear = (userRole === 'student' && year) ? year.trim() : null;
    const finalSection = (userRole === 'student' && section) ? section.trim() : null;

    if (userRole === 'student' && (!finalRoll || !finalYear || !finalSection)) return res.status(400).json({ error: 'Students need roll number, year, section.' });

    const userCheck = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
    if (userCheck.rows.length > 0) return res.status(400).json({ error: 'User exists' });

    const insertQuery = `INSERT INTO users (name, email, password, role, roll_number, academic_year, section) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, role;`;
    const result = await pool.query(insertQuery, [name.trim(), email.trim(), password, userRole, finalRoll, finalYear, finalSection]);
    res.status(201).json({ user: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Server error', details: error.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const user = await pool.query('SELECT * FROM users WHERE email = $1 AND password = $2', [req.body.email.trim(), req.body.password]);
    if (user.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials' });
    res.json(user.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Database Error' }); }
});

// ==========================================
// TEACHER ROUTES
// ==========================================
app.get('/api/dashboard/teacher', async (req, res) => {
    try {
        const { year, section } = req.query;
        let params = []; let filter = "WHERE role = 'student'";
        if (year) { params.push(year); filter += ` AND academic_year = $${params.length}`; }
        if (section) { params.push(section); filter += ` AND section = $${params.length}`; }

        const [studentsQuery, pendingQuery, avgScoreQuery, pendingListQuery] = await Promise.all([
            pool.query(`SELECT COUNT(*) FROM users ${filter}`, params),
            pool.query(`SELECT COUNT(*) FROM attendance a JOIN users u ON a.student_id = u.id ${filter} AND a.status = 'Pending'`, params),
            pool.query(`SELECT COALESCE(AVG(qr.score), 0) as avg_score FROM quiz_results qr JOIN users u ON qr.student_id = u.id ${filter}`, params),
            pool.query(`SELECT a.id as attendance_id, u.name as student_name, a.date, a.reason_for_absence FROM attendance a JOIN users u ON a.student_id = u.id ${filter} AND a.status = 'Pending' ORDER BY a.date DESC`, params)
        ]);

        res.json({ totalStudents: parseInt(studentsQuery.rows[0].count), pendingCount: parseInt(pendingQuery.rows[0].count), avgQuizScore: parseFloat(avgScoreQuery.rows[0].avg_score).toFixed(1), pendingRequests: pendingListQuery.rows });
    } catch (error) { res.status(500).json({ error: 'Dashboard Error' }); }
});

app.get('/api/attendance/roster', async (req, res) => {
    try {
        const { year, section, course_id, date } = req.query;
        const result = await pool.query(`
            SELECT u.id as student_id, u.name, u.roll_number, COALESCE(a.status, 'Pending') as status, COALESCE(a.teacher_remarks, '') as remarks
            FROM users u LEFT JOIN attendance a ON u.id = a.student_id AND a.date = $1 AND a.course_id = $2
            WHERE u.role = 'student' AND u.academic_year = $3 AND u.section = $4 ORDER BY u.roll_number ASC;
        `, [date, course_id, year, section]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Roster error' }); }
});

app.post('/api/attendance/bulk', async (req, res) => {
    const { course_id, date, records } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const upsert = `INSERT INTO attendance (student_id, course_id, date, status, teacher_remarks) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (student_id, course_id, date) DO UPDATE SET status = EXCLUDED.status, teacher_remarks = EXCLUDED.teacher_remarks;`;
        for (let r of records) await client.query(upsert, [r.student_id, course_id, date, r.status, r.remarks]);
        await client.query('COMMIT'); res.json({ message: 'Saved' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Save failed' }); } finally { client.release(); }
});

app.post('/api/attendance/update', async (req, res) => {
    try {
        await pool.query('UPDATE attendance SET status = $1 WHERE id = $2', [req.body.status, req.body.attendance_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/courses', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.id, c.title, c.description, u.name AS teacher_name FROM courses c JOIN users u ON c.teacher_id = u.id ORDER BY c.id DESC;`);
    res.json(result.rows);
  } catch (err) { res.status(500).send('Server Error'); }
});

app.post('/api/courses/create', async (req, res) => {
    try {
        const result = await pool.query(`INSERT INTO courses (teacher_id, title, description) VALUES ($1, $2, $3) RETURNING *;`, [req.body.teacher_id, req.body.title, req.body.description]);
        res.status(201).json({ course: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed to create' }); }
});

app.put('/api/courses/:id', async (req, res) => {
    try {
        const result = await pool.query(`UPDATE courses SET title = $1, description = $2 WHERE id = $3 RETURNING *;`, [req.body.title, req.body.description, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/courses/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

app.get('/api/courses/details/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Course not found' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/content/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const result = await pool.query(`INSERT INTO content (course_id, title, file_url, type) VALUES ($1, $2, $3, $4) RETURNING *;`, [req.body.course_id, req.body.title, '/uploads/' + req.file.filename, req.body.type]);
        res.status(201).json({ content: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Upload failed' }); }
});

app.get('/api/content/course/:course_id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM content WHERE course_id = $1 ORDER BY uploaded_at DESC', [req.params.course_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.delete('/api/content/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM content WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/quizzes/create', async (req, res) => {
    try {
        const result = await pool.query('INSERT INTO quizzes (course_id, title, questions) VALUES ($1, $2, $3) RETURNING *', [req.body.course_id, req.body.title, JSON.stringify(req.body.questions)]);
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/quizzes/course/:course_id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quizzes WHERE course_id = $1 ORDER BY created_at DESC', [req.params.course_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.put('/api/quizzes/:id', async (req, res) => {
    try {
        await pool.query('UPDATE quizzes SET title = $1, questions = $2 WHERE id = $3', [req.body.title, JSON.stringify(req.body.questions), req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.delete('/api/quizzes/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM quizzes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/quizzes/:quiz_id/results', async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.name, u.roll_number, qr.score, qr.submitted_at FROM quiz_results qr JOIN users u ON qr.student_id = u.id WHERE qr.quiz_id = $1 ORDER BY qr.score DESC, qr.submitted_at ASC`, [req.params.quiz_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/quizzes-dashboard/:course_id', async (req, res) => {
    try {
        const quizStatsRes = await pool.query(`SELECT q.id, q.title, COUNT(qr.id) as submission_count, COALESCE(ROUND(AVG(qr.score), 2), 0) as avg_score FROM quizzes q LEFT JOIN quiz_results qr ON q.id = qr.quiz_id WHERE q.course_id = $1 GROUP BY q.id, q.title ORDER BY q.id DESC;`, [req.params.course_id]);
        const leaderboardRes = await pool.query(`SELECT u.name, u.roll_number, COALESCE(ROUND(AVG(qr.score), 2), 0) as avg_score, COUNT(qr.id) as quizzes_taken FROM users u JOIN quiz_results qr ON u.id = qr.student_id JOIN quizzes q ON qr.quiz_id = q.id WHERE q.course_id = $1 GROUP BY u.id, u.name, u.roll_number ORDER BY avg_score DESC;`, [req.params.course_id]);
        const totalStudentsRes = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'student'");
        res.json({ totalStudents: parseInt(totalStudentsRes.rows[0].count), totalQuizzes: quizStatsRes.rows.length, quizStats: quizStatsRes.rows, leaderboard: leaderboardRes.rows });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch quiz dashboard data' }); }
});

// ==========================================
// USER PROFILE MANAGEMENT 
// ==========================================

app.get('/api/users/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, role, roll_number, academic_year, section, password FROM users WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.put('/api/users/:id', async (req, res) => {
    const { name, email, password, rollNumber, year, section } = req.body;
    try {
        const updateQuery = `
            UPDATE users 
            SET name = $1, email = $2, password = $3, roll_number = $4, academic_year = $5, section = $6
            WHERE id = $7 RETURNING id, name, email, role;
        `;
        const result = await pool.query(updateQuery, [name, email, password, rollNumber, year, section, req.params.id]);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Email or Roll Number is already in use.' });
        res.status(500).json({ error: 'Failed to update profile' });
    }
});


// ==========================================
// STUDENT ROUTES (ENROLLMENT & DASHBOARD)
// ==========================================
app.post('/api/student/enroll', async (req, res) => {
    try {
        await pool.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2)', [req.body.student_id, req.body.course_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Enrollment failed' }); }
});

app.post('/api/student/unenroll', async (req, res) => {
    try {
        await pool.query('DELETE FROM enrollments WHERE student_id = $1 AND course_id = $2', [req.body.student_id, req.body.course_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Unenrollment failed' }); }
});

app.get('/api/dashboard/student/:id', async (req, res) => {
    const studentId = req.params.id;
    if (!studentId || studentId === 'undefined') return res.status(400).json({ error: 'Invalid ID' });

    try {
        // FIXED: Calculate Rank strictly against students in the SAME Year & Section
        const rankQuery = `
            WITH MyCohort AS (
                SELECT academic_year, section FROM users WHERE id = $1
            ),
            StudentAverages AS (
                SELECT u.id as student_id, COALESCE(AVG(qr.score), 0) as avg_score
                FROM users u 
                JOIN MyCohort mc ON u.academic_year = mc.academic_year AND u.section = mc.section
                LEFT JOIN quiz_results qr ON u.id = qr.student_id
                WHERE u.role = 'student' 
                GROUP BY u.id
            )
            SELECT student_id, avg_score, RANK() OVER (ORDER BY avg_score DESC) as rank
            FROM StudentAverages;
        `;

        const availableQuery = `
            SELECT c.id, c.title, c.description, u.name as teacher_name 
            FROM courses c JOIN users u ON c.teacher_id = u.id 
            WHERE c.id NOT IN (SELECT course_id FROM enrollments WHERE student_id = $1)
            ORDER BY c.created_at DESC;
        `;

        const enrolledQuery = `
            SELECT c.id, c.title, c.description, u.name as teacher_name,
                (SELECT COUNT(*) FROM content WHERE course_id = c.id) as total_content,
                (SELECT COUNT(*) FROM content_tracking ct JOIN content co ON ct.content_id = co.id WHERE co.course_id = c.id AND ct.student_id = $1) as completed_content,
                (SELECT COUNT(*) FROM quizzes WHERE course_id = c.id) as total_quizzes,
                (SELECT COUNT(*) FROM quiz_results qr JOIN quizzes q ON qr.quiz_id = q.id WHERE q.course_id = c.id AND qr.student_id = $1) as completed_quizzes
            FROM courses c
            JOIN enrollments e ON c.id = e.course_id
            JOIN users u ON c.teacher_id = u.id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC;
        `;
        
        const [rankRes, availableRes, enrolledRes, absencesRes] = await Promise.all([
            pool.query(rankQuery, [studentId]), // Pass studentId to the CTE query!
            pool.query(availableQuery, [studentId]),
            pool.query(enrolledQuery, [studentId]),
            pool.query(`SELECT date, reason_for_absence, status FROM attendance WHERE student_id = $1 AND reason_for_absence IS NOT NULL ORDER BY date DESC LIMIT 5;`, [studentId])
        ]);

        const myData = rankRes.rows.find(r => r.student_id == studentId) || { avg_score: 0, rank: 'N/A' };
        const totalStudentsInCohort = rankRes.rows.length || 1; // Now represents Class size, not College size!

        res.json({
            rank: myData.rank,
            totalStudents: totalStudentsInCohort, // Sending back cohort size
            avgScore: parseFloat(myData.avg_score).toFixed(1),
            availableCourses: availableRes.rows,
            enrolledCourses: enrolledRes.rows,
            absences: absencesRes.rows
        });
    } catch (err) { res.status(500).json({ error: 'Server Error', details: err.message }); }
});

app.get('/api/student/course-view/:course_id/:student_id', async (req, res) => {
    const { course_id, student_id } = req.params;
    try {
        const [courseRes, materialsRes, quizzesRes, leaderboardRes] = await Promise.all([
            pool.query('SELECT * FROM courses WHERE id = $1', [course_id]),
            pool.query(`
                SELECT c.*, CASE WHEN ct.id IS NOT NULL THEN true ELSE false END as is_completed
                FROM content c LEFT JOIN content_tracking ct ON c.id = ct.content_id AND ct.student_id = $1
                WHERE c.course_id = $2 ORDER BY c.uploaded_at DESC
            `, [student_id, course_id]),
            pool.query(`
                SELECT q.id, q.title, q.created_at, q.questions, 
                       CASE WHEN qr.id IS NOT NULL THEN true ELSE false END as is_completed
                FROM quizzes q LEFT JOIN quiz_results qr ON q.id = qr.quiz_id AND qr.student_id = $1
                WHERE q.course_id = $2 ORDER BY q.created_at DESC
            `, [student_id, course_id]),
            pool.query(`
                SELECT u.name, u.roll_number, COALESCE(ROUND(AVG(qr.score), 2), 0) as avg_score, COUNT(qr.id) as quizzes_taken 
                FROM users u JOIN quiz_results qr ON u.id = qr.student_id JOIN quizzes q ON qr.quiz_id = q.id 
                WHERE q.course_id = $1 GROUP BY u.id, u.name, u.roll_number ORDER BY avg_score DESC;
            `, [course_id])
        ]);

        if (courseRes.rows.length === 0) return res.status(404).json({ error: 'Course not found' });

        const safeQuizzes = quizzesRes.rows.map(q => {
            let qCount = 0;
            if (typeof q.questions === 'string') {
                try { qCount = JSON.parse(q.questions).length; } catch(e) {}
            } else if (Array.isArray(q.questions)) { qCount = q.questions.length; }
            return { ...q, question_count: qCount };
        });

        res.json({
            course: courseRes.rows[0],
            materials: materialsRes.rows,
            quizzes: safeQuizzes,
            leaderboard: leaderboardRes.rows
        });
    } catch (error) { res.status(500).json({ error: 'Failed to load course data' }); }
});

app.post('/api/content/track', async (req, res) => {
    try {
        await pool.query('INSERT INTO content_tracking (student_id, content_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.body.student_id, req.body.content_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/quizzes/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/quizzes/submit', async (req, res) => {
    try {
        await pool.query('INSERT INTO quiz_results (student_id, quiz_id, score) VALUES ($1, $2, $3)', [req.body.student_id, req.body.quiz_id, req.body.score]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/attendance/report', async (req, res) => {
  try {
    const result = await pool.query(`INSERT INTO attendance (student_id, course_id, status, reason_for_absence, date) VALUES ($1, $2, 'Pending', $3, $4) RETURNING *`, [req.body.student_id, req.body.course_id, req.body.reason_for_absence, req.body.date]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).send('Server Error.'); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));