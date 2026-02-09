const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { stringify } = require('csv-stringify/sync');
const { db, ensureUser, promoteToManager, getExpectedPaidMonth } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Auto-seed with demo data if DB is empty (no staff users yet)
const staffCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role != 'payroll'").get().c;
if (staffCount === 0) {
  console.log('Empty database detected - seeding demo data...');
  require('./seed');
}

// Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'overtime-app-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.messages = req.flash();
  next();
});

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireManager(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'manager' && req.session.user.role !== 'payroll') {
    return res.status(403).render('error', { message: 'Access denied' });
  }
  next();
}
function requirePayroll(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'payroll') {
    return res.status(403).render('error', { message: 'Access denied' });
  }
  next();
}

// ============ AUTH ROUTES ============

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'payroll') return res.redirect('/payroll');
    if (req.session.user.role === 'manager') return res.redirect('/manager');
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    overtime_rate: user.overtime_rate,
    nights_away_rate: user.nights_away_rate,
    is_field_engineer: user.is_field_engineer
  };

  if (user.role === 'payroll') return res.redirect('/payroll');
  if (user.role === 'manager') return res.redirect('/manager');
  return res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============ STAFF DASHBOARD ============

app.get('/dashboard', requireLogin, (req, res) => {
  const overtime = db.prepare(`
    SELECT *,
      CASE WHEN paid = 1 THEN paid_month ELSE NULL END as actual_paid_month
    FROM overtime_entries
    WHERE submitter_email = ?
    ORDER BY date DESC
  `).all(req.session.user.email);

  const nights = db.prepare(`
    SELECT *,
      CASE WHEN paid = 1 THEN paid_month ELSE NULL END as actual_paid_month
    FROM nights_away
    WHERE submitter_email = ?
    ORDER BY date DESC
  `).all(req.session.user.email);

  // Add expected paid month for unpaid entries
  overtime.forEach(e => {
    if (!e.paid) {
      e.expected_paid_month = getExpectedPaidMonth(e.created_at || e.date);
    }
  });
  nights.forEach(e => {
    if (!e.paid) {
      e.expected_paid_month = getExpectedPaidMonth(e.created_at || e.date);
    }
  });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.session.user.email);

  res.render('dashboard', { overtime, nights, staffUser: user });
});

// ============ MANAGER VIEW ============

app.get('/manager', requireManager, (req, res) => {
  const pendingOvertime = db.prepare(`
    SELECT * FROM overtime_entries
    WHERE approver_email = ? AND approved = 0
    ORDER BY submitter_name, date DESC
  `).all(req.session.user.email);

  const pendingNights = db.prepare(`
    SELECT * FROM nights_away
    WHERE approver_email = ? AND approved = 0
    ORDER BY submitter_name, date DESC
  `).all(req.session.user.email);

  const approvedOvertime = db.prepare(`
    SELECT * FROM overtime_entries
    WHERE approver_email = ? AND approved = 1
    ORDER BY date DESC
  `).all(req.session.user.email);

  const approvedNights = db.prepare(`
    SELECT * FROM nights_away
    WHERE approver_email = ? AND approved = 1
    ORDER BY date DESC
  `).all(req.session.user.email);

  res.render('manager', { pendingOvertime, pendingNights, approvedOvertime, approvedNights });
});

app.post('/manager/approve/overtime/:id', requireManager, (req, res) => {
  db.prepare(`
    UPDATE overtime_entries SET approved = 1, approved_at = datetime('now')
    WHERE id = ? AND approver_email = ?
  `).run(req.params.id, req.session.user.email);
  req.flash('success', 'Overtime entry approved');
  res.redirect('/manager');
});

app.post('/manager/approve/night/:id', requireManager, (req, res) => {
  db.prepare(`
    UPDATE nights_away SET approved = 1, approved_at = datetime('now')
    WHERE id = ? AND approver_email = ?
  `).run(req.params.id, req.session.user.email);
  req.flash('success', 'Night away entry approved');
  res.redirect('/manager');
});

app.post('/manager/approve-all/overtime', requireManager, (req, res) => {
  db.prepare(`
    UPDATE overtime_entries SET approved = 1, approved_at = datetime('now')
    WHERE approver_email = ? AND approved = 0
  `).run(req.session.user.email);
  req.flash('success', 'All overtime entries approved');
  res.redirect('/manager');
});

app.post('/manager/approve-all/nights', requireManager, (req, res) => {
  db.prepare(`
    UPDATE nights_away SET approved = 1, approved_at = datetime('now')
    WHERE approver_email = ? AND approved = 0
  `).run(req.session.user.email);
  req.flash('success', 'All nights away entries approved');
  res.redirect('/manager');
});

// ============ PAYROLL VIEW ============

app.get('/payroll', requirePayroll, (req, res) => {
  const monthFilter = req.query.month || '';

  let overtime, nights;
  if (monthFilter) {
    overtime = db.prepare(`
      SELECT oe.*, u.overtime_rate
      FROM overtime_entries oe
      LEFT JOIN users u ON u.email = oe.submitter_email
      WHERE strftime('%Y-%m', oe.date) = ?
      ORDER BY oe.submitter_name, oe.date
    `).all(monthFilter);
    nights = db.prepare(`
      SELECT na.*, u.nights_away_rate, u.is_field_engineer
      FROM nights_away na
      LEFT JOIN users u ON u.email = na.submitter_email
      WHERE strftime('%Y-%m', na.date) = ?
      ORDER BY na.submitter_name, na.date
    `).all(monthFilter);
  } else {
    overtime = db.prepare(`
      SELECT oe.*, u.overtime_rate
      FROM overtime_entries oe
      LEFT JOIN users u ON u.email = oe.submitter_email
      ORDER BY oe.submitter_name, oe.date DESC
    `).all();
    nights = db.prepare(`
      SELECT na.*, u.nights_away_rate, u.is_field_engineer
      FROM nights_away na
      LEFT JOIN users u ON u.email = na.submitter_email
      ORDER BY na.submitter_name, na.date DESC
    `).all();
  }

  // Get available months for filter
  const months = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', date) as month FROM overtime_entries
    UNION
    SELECT DISTINCT strftime('%Y-%m', date) as month FROM nights_away
    ORDER BY month DESC
  `).all();

  // Staff summary
  const staffSummary = db.prepare(`
    SELECT u.email, u.name, u.overtime_rate, u.nights_away_rate, u.is_field_engineer,
      COALESCE(ot.total_hours, 0) as total_hours,
      COALESCE(ot.pending_hours, 0) as pending_hours,
      COALESCE(ot.approved_hours, 0) as approved_hours,
      COALESCE(na.total_nights, 0) as total_nights,
      COALESCE(na.pending_nights, 0) as pending_nights,
      COALESCE(na.approved_nights, 0) as approved_nights
    FROM users u
    LEFT JOIN (
      SELECT submitter_email,
        SUM(hours) as total_hours,
        SUM(CASE WHEN approved = 0 THEN hours ELSE 0 END) as pending_hours,
        SUM(CASE WHEN approved = 1 THEN hours ELSE 0 END) as approved_hours
      FROM overtime_entries GROUP BY submitter_email
    ) ot ON ot.submitter_email = u.email
    LEFT JOIN (
      SELECT submitter_email,
        COUNT(*) as total_nights,
        SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as pending_nights,
        SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved_nights
      FROM nights_away GROUP BY submitter_email
    ) na ON na.submitter_email = u.email
    WHERE u.role != 'payroll' AND (ot.total_hours > 0 OR na.total_nights > 0)
    ORDER BY u.name
  `).all();

  const users = db.prepare("SELECT * FROM users WHERE role != 'payroll' ORDER BY name").all();

  res.render('payroll', { overtime, nights, months, monthFilter, staffSummary, users });
});

app.post('/payroll/mark-paid', requirePayroll, (req, res) => {
  const { entry_ids, paid_month, type } = req.body;
  if (!entry_ids || !paid_month) {
    req.flash('error', 'Missing required fields');
    return res.redirect('/payroll');
  }

  const ids = Array.isArray(entry_ids) ? entry_ids : [entry_ids];
  const table = type === 'nights' ? 'nights_away' : 'overtime_entries';

  const stmt = db.prepare(`UPDATE ${table} SET paid = 1, paid_month = ? WHERE id = ?`);
  const batch = db.transaction((ids) => {
    for (const id of ids) {
      stmt.run(paid_month, id);
    }
  });
  batch(ids);

  req.flash('success', `Marked ${ids.length} entries as paid for ${paid_month}`);
  res.redirect('/payroll');
});

app.post('/payroll/update-rate', requirePayroll, (req, res) => {
  const { user_id, overtime_rate, nights_away_rate, is_field_engineer } = req.body;
  db.prepare(`
    UPDATE users SET overtime_rate = ?, nights_away_rate = ?, is_field_engineer = ? WHERE id = ?
  `).run(
    parseFloat(overtime_rate) || 0,
    is_field_engineer === '1' ? 50 : 25,
    is_field_engineer === '1' ? 1 : 0,
    user_id
  );
  req.flash('success', 'Rate updated');
  res.redirect('/payroll');
});

app.get('/payroll/export', requirePayroll, (req, res) => {
  const month = req.query.month || '';
  let query = `
    SELECT oe.submitter_name as Name, oe.submitter_email as Email, oe.date as Date,
      oe.hours as Hours, oe.is_weekend as Weekend, u.overtime_rate as Rate,
      CASE WHEN oe.is_weekend = 1 THEN oe.hours * u.overtime_rate * 1.5
           ELSE oe.hours * u.overtime_rate END as Amount,
      oe.halo_ticket_ref as 'Ticket Ref', oe.client as Client,
      oe.description as Description,
      CASE WHEN oe.approved = 1 THEN 'Approved' ELSE 'Pending' END as Status,
      oe.paid_month as 'Paid Month'
    FROM overtime_entries oe
    LEFT JOIN users u ON u.email = oe.submitter_email
  `;
  const params = [];
  if (month) {
    query += ` WHERE strftime('%Y-%m', oe.date) = ?`;
    params.push(month);
  }
  query += ` ORDER BY oe.submitter_name, oe.date`;

  const rows = db.prepare(query).all(...params);
  const csv = stringify(rows, { header: true });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="overtime-export-${month || 'all'}.csv"`);
  res.send(csv);
});

// ============ IMPORT ============

app.get('/payroll/import', requirePayroll, (req, res) => {
  res.render('import');
});

app.post('/payroll/import', requirePayroll, upload.single('file'), (req, res) => {
  if (!req.file) {
    req.flash('error', 'No file uploaded');
    return res.redirect('/payroll/import');
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;
    let skipped = 0;

    const insertOvertime = db.prepare(`
      INSERT OR IGNORE INTO overtime_entries
      (submission_id, submitter_email, submitter_name, date, hours, halo_ticket_ref, client, description, approver_name, is_weekend, paid, paid_month, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = db.transaction((rows) => {
      for (const row of rows) {
        const submissionId = String(row['Id'] || row['ID'] || '');
        const email = (row['Email'] || '').toLowerCase().trim();
        const name = row['Name'] || '';
        const dateRaw = row['Date'];
        const hours = parseFloat(row['Time (hours)'] || row['Hours'] || 0);
        const ticket = row['Halo Ticket Ref'] || row['Ticket Ref'] || '';
        const client = row['CEMEX?'] || row['Client'] || '';
        const desc = row['Brief description of work done'] || row['Description'] || '';
        const approver = row['Approved by'] || row['Approver'] || '';
        const paid = row['PAID'] || '';
        const isWeekend = row['Weekend'] ? 1 : 0;
        const startTime = row['Start time'] || '';

        if (!email || !name || !hours) {
          skipped++;
          continue;
        }

        // Parse date
        let dateStr = '';
        if (dateRaw) {
          if (typeof dateRaw === 'number') {
            // Excel serial date
            const d = XLSX.SSF.parse_date_code(dateRaw);
            dateStr = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
          } else {
            const d = new Date(dateRaw);
            if (!isNaN(d.getTime())) {
              dateStr = d.toISOString().split('T')[0];
            }
          }
        }

        if (!dateStr) {
          skipped++;
          continue;
        }

        // Ensure user exists
        ensureUser(email, name);

        // Resolve approver email - look up from name or use as-is
        let approverEmail = '';
        if (approver.includes('@')) {
          approverEmail = approver.toLowerCase().trim();
        } else if (approver) {
          // Try to find user by name
          const approverUser = db.prepare('SELECT email FROM users WHERE name = ?').get(approver);
          if (approverUser) {
            approverEmail = approverUser.email;
          } else {
            // Create approver from name: "First Last" -> "first.last@flotek.io"
            const parts = approver.trim().split(/\s+/);
            if (parts.length >= 2) {
              approverEmail = `${parts[0].toLowerCase()}.${parts[parts.length-1].toLowerCase()}@flotek.io`;
              ensureUser(approverEmail, approver);
              promoteToManager(approverEmail);
            }
          }
        }

        // Parse submission time for created_at
        let createdAt = '';
        if (startTime) {
          if (typeof startTime === 'number') {
            const d = XLSX.SSF.parse_date_code(startTime);
            createdAt = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
          } else {
            const d = new Date(startTime);
            if (!isNaN(d.getTime())) {
              createdAt = d.toISOString().split('T')[0];
            }
          }
        }

        // Determine paid month
        let paidMonth = '';
        const isPaid = paid && paid !== '0' && paid !== 'No' && paid !== 'no' && paid !== '';
        if (isPaid) {
          paidMonth = String(paid);
        }

        // Check if already imported
        if (submissionId) {
          const existing = db.prepare('SELECT id FROM overtime_entries WHERE submission_id = ?').get(submissionId);
          if (existing) {
            skipped++;
            continue;
          }
        }

        insertOvertime.run(
          submissionId, email, name, dateStr, hours, ticket, client, desc,
          approver, isWeekend, isPaid ? 1 : 0, paidMonth, createdAt || dateStr
        );

        // Set approver_email
        if (approverEmail) {
          db.prepare('UPDATE overtime_entries SET approver_email = ? WHERE submission_id = ?').run(approverEmail, submissionId);
        }

        imported++;
      }
    });

    batch(rows);

    // Clean up uploaded file
    const fs = require('fs');
    fs.unlinkSync(req.file.path);

    req.flash('success', `Imported ${imported} entries (${skipped} skipped)`);
    res.redirect('/payroll');
  } catch (err) {
    console.error('Import error:', err);
    req.flash('error', 'Import failed: ' + err.message);
    res.redirect('/payroll/import');
  }
});

// ============ CHANGE PASSWORD ============

app.post('/change-password', requireLogin, (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/dashboard');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  req.flash('success', 'Password changed successfully');
  res.redirect('/dashboard');
});

app.listen(PORT, () => {
  console.log(`Overtime app running on http://localhost:${PORT}`);
});
