const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { stringify } = require('csv-stringify/sync');
const { db, ensureUser, promoteToManager, getExpectedPaidMonth, calcCommission } = require('./db');

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
  res.locals.portal = req.session.portal || null;
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
  res.render('portal-select');
});

app.get('/login', (req, res) => {
  const portal = req.query.portal || 'overtime';
  res.render('login', { portal });
});

app.post('/login', (req, res) => {
  const { email, password, portal } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Invalid email or password');
    return res.redirect('/login?portal=' + (portal || 'overtime'));
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
  req.session.portal = portal || 'overtime';

  if (portal === 'commissions') {
    if (user.role === 'payroll') return res.redirect('/commissions/payroll');
    if (user.role === 'manager') return res.redirect('/commissions/manager');
    return res.redirect('/commissions/dashboard');
  }

  if (user.role === 'payroll') return res.redirect('/payroll');
  if (user.role === 'manager') return res.redirect('/manager');
  return res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
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

  // Get list of managers for the submit form
  const managers = db.prepare("SELECT email, name FROM users WHERE role = 'manager' ORDER BY name").all();

  res.render('dashboard', { overtime, nights, staffUser: user, managers });
});

// ============ STAFF SUBMIT OVERTIME ============

app.post('/dashboard/submit-overtime', requireLogin, (req, res) => {
  const { date, hours, halo_ticket_ref, client, description, approver_email } = req.body;

  if (!date || !hours || !approver_email) {
    req.flash('error', 'Date, hours, and approver are required');
    return res.redirect('/dashboard');
  }

  const d = new Date(date);
  const isWeekend = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0;
  const approver = db.prepare('SELECT name FROM users WHERE email = ?').get(approver_email);

  db.prepare(`
    INSERT INTO overtime_entries
    (submitter_email, submitter_name, date, hours, halo_ticket_ref, client, description, approver_email, approver_name, approved, is_weekend, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
  `).run(
    req.session.user.email,
    req.session.user.name,
    date,
    parseFloat(hours),
    halo_ticket_ref || '',
    client || '',
    description || '',
    approver_email,
    approver ? approver.name : '',
    isWeekend
  );

  req.flash('success', 'Overtime submitted for approval');
  res.redirect('/dashboard');
});

// ============ STAFF DELETE UNAPPROVED ============

app.post('/dashboard/delete-overtime/:id', requireLogin, (req, res) => {
  const entry = db.prepare('SELECT * FROM overtime_entries WHERE id = ? AND submitter_email = ?').get(
    req.params.id, req.session.user.email
  );

  if (!entry) {
    req.flash('error', 'Entry not found');
    return res.redirect('/dashboard');
  }
  if (entry.approved || entry.paid) {
    req.flash('error', 'Cannot delete approved or paid entries');
    return res.redirect('/dashboard');
  }

  db.prepare('DELETE FROM overtime_entries WHERE id = ?').run(req.params.id);
  req.flash('success', 'Overtime entry deleted');
  res.redirect('/dashboard');
});

// ============ STAFF UPDATE & RESUBMIT ============

app.post('/dashboard/resubmit-overtime/:id', requireLogin, (req, res) => {
  const { date, hours, halo_ticket_ref, client, description } = req.body;
  const entry = db.prepare('SELECT * FROM overtime_entries WHERE id = ? AND submitter_email = ? AND approved = 0').get(
    req.params.id, req.session.user.email
  );

  if (!entry) {
    req.flash('error', 'Entry not found or already approved');
    return res.redirect('/dashboard');
  }

  const d = new Date(date);
  const isWeekend = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0;

  db.prepare(`
    UPDATE overtime_entries
    SET date = ?, hours = ?, halo_ticket_ref = ?, client = ?, description = ?, is_weekend = ?, rejection_comment = NULL, rejected_at = NULL
    WHERE id = ?
  `).run(date, parseFloat(hours), halo_ticket_ref || '', client || '', description || '', isWeekend, req.params.id);

  req.flash('success', 'Overtime entry updated and resubmitted');
  res.redirect('/dashboard');
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

app.post('/manager/reject/overtime/:id', requireManager, (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) {
    req.flash('error', 'A comment is required when sending back for review');
    return res.redirect('/manager');
  }

  db.prepare(`
    UPDATE overtime_entries
    SET approved = 0, approved_at = NULL, rejection_comment = ?, rejected_at = datetime('now')
    WHERE id = ? AND approver_email = ?
  `).run(comment.trim(), req.params.id, req.session.user.email);

  req.flash('success', 'Entry sent back for review');
  res.redirect('/manager');
});

// ============ PAYROLL VIEW ============

app.get('/payroll', requirePayroll, (req, res) => {
  const monthFilter = req.query.month || '';
  const staffFilter = req.query.staff || '';
  const statusFilter = req.query.status || ''; // all, approved, pending, paid, unpaid

  // Get available months for filter
  const months = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', date) as month FROM overtime_entries
    UNION
    SELECT DISTINCT strftime('%Y-%m', date) as month FROM nights_away
    ORDER BY month DESC
  `).all();

  const activeMonth = monthFilter || (months.length ? months[0].month : '');

  // All staff who have entries (for slicer)
  const allStaff = db.prepare(`
    SELECT DISTINCT submitter_email, submitter_name FROM overtime_entries
    UNION
    SELECT DISTINCT submitter_email, submitter_name FROM nights_away
    ORDER BY submitter_name
  `).all();

  // Base queries for active month
  let overtime, nights;
  if (activeMonth) {
    overtime = db.prepare(`
      SELECT oe.*, u.overtime_rate
      FROM overtime_entries oe
      LEFT JOIN users u ON u.email = oe.submitter_email
      WHERE strftime('%Y-%m', oe.date) = ?
      ORDER BY oe.submitter_name, oe.date
    `).all(activeMonth);
    nights = db.prepare(`
      SELECT na.*, u.nights_away_rate, u.is_field_engineer
      FROM nights_away na
      LEFT JOIN users u ON u.email = na.submitter_email
      WHERE strftime('%Y-%m', na.date) = ?
      ORDER BY na.submitter_name, na.date
    `).all(activeMonth);
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

  // Apply slicer filters
  let filteredOT = overtime;
  let filteredNA = nights;
  if (staffFilter) {
    filteredOT = filteredOT.filter(e => e.submitter_email === staffFilter);
    filteredNA = filteredNA.filter(e => e.submitter_email === staffFilter);
  }
  if (statusFilter === 'approved') {
    filteredOT = filteredOT.filter(e => e.approved && !e.paid);
    filteredNA = filteredNA.filter(e => e.approved && !e.paid);
  } else if (statusFilter === 'pending') {
    filteredOT = filteredOT.filter(e => !e.approved);
    filteredNA = filteredNA.filter(e => !e.approved);
  } else if (statusFilter === 'paid') {
    filteredOT = filteredOT.filter(e => e.paid);
    filteredNA = filteredNA.filter(e => e.paid);
  } else if (statusFilter === 'unpaid') {
    filteredOT = filteredOT.filter(e => !e.paid);
    filteredNA = filteredNA.filter(e => !e.paid);
  }

  // Per-staff monthly summary (always for the month, unfiltered by status)
  const staffEmails = [...new Set([...overtime.map(e => e.submitter_email), ...nights.map(e => e.submitter_email)])];
  const summary = staffEmails.map(email => {
    const sOT = overtime.filter(e => e.submitter_email === email);
    const sNA = nights.filter(e => e.submitter_email === email);
    const name = sOT[0]?.submitter_name || sNA[0]?.submitter_name || email;
    const rate = sOT[0]?.overtime_rate || 0;
    const naRate = sNA[0]?.nights_away_rate || sNA[0]?.rate || 25;

    const totalHours = sOT.reduce((s, e) => s + e.hours, 0);
    const pendingHours = sOT.filter(e => !e.approved).reduce((s, e) => s + e.hours, 0);
    const approvedHours = sOT.filter(e => e.approved).reduce((s, e) => s + e.hours, 0);

    const approvedOTCost = sOT.filter(e => e.approved).reduce((s, e) => {
      return s + (e.is_weekend ? e.hours * rate * 1.5 : e.hours * rate);
    }, 0);
    const paidOTCost = sOT.filter(e => e.paid).reduce((s, e) => {
      return s + (e.is_weekend ? e.hours * rate * 1.5 : e.hours * rate);
    }, 0);
    const unpaidApprovedOTCost = sOT.filter(e => e.approved && !e.paid).reduce((s, e) => {
      return s + (e.is_weekend ? e.hours * rate * 1.5 : e.hours * rate);
    }, 0);

    const totalNights = sNA.length;
    const pendingNights = sNA.filter(e => !e.approved).length;
    const approvedNights = sNA.filter(e => e.approved).length;
    const paidNights = sNA.filter(e => e.paid).length;
    const unpaidApprovedNights = sNA.filter(e => e.approved && !e.paid).length;

    const approvedNACost = approvedNights * naRate;
    const paidNACost = paidNights * naRate;
    const unpaidApprovedNACost = unpaidApprovedNights * naRate;

    return {
      email, name, rate, naRate,
      totalHours, pendingHours, approvedHours,
      approvedOTCost, paidOTCost, unpaidApprovedOTCost,
      totalNights, pendingNights, approvedNights, paidNights, unpaidApprovedNights,
      approvedNACost, paidNACost, unpaidApprovedNACost,
      totalCost: approvedOTCost + approvedNACost,
      unpaidReadyOT: sOT.filter(e => e.approved && !e.paid).length,
      unpaidReadyNA: sNA.filter(e => e.approved && !e.paid).length
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const users = db.prepare("SELECT * FROM users WHERE role != 'payroll' ORDER BY name").all();

  res.render('payroll', {
    overtime: filteredOT, nights: filteredNA,
    allOvertime: overtime, allNights: nights,
    months, activeMonth, summary, users, allStaff,
    staffFilter, statusFilter
  });
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
  const staff = req.query.staff || '';
  const status = req.query.status || '';
  const type = req.query.type || 'overtime'; // overtime or nights

  if (type === 'nights') {
    const conditions = [];
    const params = [];
    if (month) { conditions.push("strftime('%Y-%m', na.date) = ?"); params.push(month); }
    if (staff) { conditions.push('na.submitter_email = ?'); params.push(staff); }
    if (status === 'approved') { conditions.push('na.approved = 1 AND na.paid = 0'); }
    else if (status === 'pending') { conditions.push('na.approved = 0'); }
    else if (status === 'paid') { conditions.push('na.paid = 1'); }
    else if (status === 'unpaid') { conditions.push('na.paid = 0'); }

    let query = `SELECT na.submitter_name as Name, na.submitter_email as Email, na.date as Date,
      na.description as Description, COALESCE(u.nights_away_rate, na.rate, 25) as Rate,
      CASE WHEN na.approved = 1 THEN 'Approved' ELSE 'Pending' END as Status,
      CASE WHEN na.paid = 1 THEN 'Yes' ELSE 'No' END as Paid,
      na.paid_month as 'Paid Month'
      FROM nights_away na
      LEFT JOIN users u ON u.email = na.submitter_email`;
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ` ORDER BY na.submitter_name, na.date`;
    const rows = db.prepare(query).all(...params);
    const csv = stringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    const fname = `nights-away-${month || 'all'}${staff ? '-' + staff.split('@')[0] : ''}${status ? '-' + status : ''}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(csv);
  }

  // Default: overtime export
  const conditions = [];
  const params = [];
  if (month) { conditions.push("strftime('%Y-%m', oe.date) = ?"); params.push(month); }
  if (staff) { conditions.push('oe.submitter_email = ?'); params.push(staff); }
  if (status === 'approved') { conditions.push('oe.approved = 1 AND oe.paid = 0'); }
  else if (status === 'pending') { conditions.push('oe.approved = 0'); }
  else if (status === 'paid') { conditions.push('oe.paid = 1'); }
  else if (status === 'unpaid') { conditions.push('oe.paid = 0'); }

  let query = `
    SELECT oe.submitter_name as Name, oe.submitter_email as Email, oe.date as Date,
      oe.hours as Hours, oe.is_weekend as Weekend, u.overtime_rate as Rate,
      CASE WHEN oe.is_weekend = 1 THEN oe.hours * u.overtime_rate * 1.5
           ELSE oe.hours * u.overtime_rate END as Amount,
      oe.halo_ticket_ref as 'Ticket Ref', oe.client as Client,
      oe.description as Description,
      CASE WHEN oe.approved = 1 THEN 'Approved' ELSE 'Pending' END as Status,
      CASE WHEN oe.paid = 1 THEN 'Yes' ELSE 'No' END as Paid,
      oe.paid_month as 'Paid Month'
    FROM overtime_entries oe
    LEFT JOIN users u ON u.email = oe.submitter_email
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY oe.submitter_name, oe.date`;

  const rows = db.prepare(query).all(...params);
  const csv = stringify(rows, { header: true });

  res.setHeader('Content-Type', 'text/csv');
  const fname = `overtime-${month || 'all'}${staff ? '-' + staff.split('@')[0] : ''}${status ? '-' + status : ''}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
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

// ============ COMMISSION ROUTES ============

// Staff/Account Manager Dashboard
app.get('/commissions/dashboard', requireLogin, (req, res) => {
  const monthFilter = req.query.month || '';
  const email = req.session.user.email;

  const months = db.prepare(`
    SELECT DISTINCT month FROM commission_deals WHERE account_manager_email = ? ORDER BY month DESC
  `).all(email);

  const activeMonth = monthFilter || (months.length ? months[0].month : '');

  const deals = db.prepare(`
    SELECT * FROM commission_deals WHERE account_manager_email = ? AND month = ? ORDER BY deal_date DESC
  `).all(email, activeMonth);

  const target = db.prepare(`
    SELECT * FROM commission_targets WHERE user_email = ? AND month = ?
  `).get(email, activeMonth);

  // Calculate totals for the month
  const qualifyingDeals = deals.filter(d => d.qualifies);
  const totalOneOffGP = qualifyingDeals.reduce((s, d) => s + d.one_off_gp, 0);
  const totalMRGP = qualifyingDeals.reduce((s, d) => s + d.mrgp, 0);
  const totalCommission = deals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
  const deliveredComm = deals.filter(d => d.project_delivered).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);

  // Target-met gating: if target not met this month, commission = £0
  const targetMet = target && target.one_off_gp_target > 0 ? totalOneOffGP >= target.one_off_gp_target : false;
  const qualifiedCommission = targetMet ? totalCommission : 0;

  // "In the bank" - approved & delivered but not yet paid
  const inTheBank = deals.filter(d => d.approved && d.project_delivered && !d.paid)
    .reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
  const inTheBankCount = deals.filter(d => d.approved && d.project_delivered && !d.paid).length;

  const managers = db.prepare("SELECT email, name FROM users WHERE role = 'manager' ORDER BY name").all();

  // 6-month performance history
  const allMonths = db.prepare(`
    SELECT DISTINCT month FROM commission_deals WHERE account_manager_email = ? ORDER BY month ASC
  `).all(email).map(m => m.month);
  const last6 = allMonths.slice(-6);
  const history = last6.map(m => {
    const mDeals = db.prepare(`SELECT * FROM commission_deals WHERE account_manager_email = ? AND month = ?`).all(email, m);
    const mTarget = db.prepare(`SELECT * FROM commission_targets WHERE user_email = ? AND month = ?`).get(email, m);
    const qualifying = mDeals.filter(d => d.qualifies);
    const oneOffGP = qualifying.reduce((s, d) => s + d.one_off_gp, 0);
    const mrgp = qualifying.reduce((s, d) => s + d.mrgp, 0);
    const commission = mDeals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const paid = mDeals.filter(d => d.paid).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const oneOffTarget = mTarget ? mTarget.one_off_gp_target : 0;
    const mrgpTarget = mTarget ? mTarget.mrgp_target : 0;
    const mTargetMet = oneOffTarget > 0 ? oneOffGP >= oneOffTarget : false;
    const qualifiedComm = mTargetMet ? commission : 0;
    // In the bank for this month
    const mInTheBank = mDeals.filter(d => d.approved && d.project_delivered && !d.paid)
      .reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    return {
      month: m, dealCount: mDeals.length, oneOffGP, mrgp, commission, paid,
      oneOffTarget, mrgpTarget,
      oneOffPct: oneOffTarget > 0 ? (oneOffGP / oneOffTarget * 100) : 0,
      mrgpPct: mrgpTarget > 0 ? (mrgp / mrgpTarget * 100) : 0,
      targetMet: mTargetMet, qualifiedComm, inTheBank: mInTheBank
    };
  });
  const historyTotals = {
    deals: history.reduce((s, h) => s + h.dealCount, 0),
    oneOffGP: history.reduce((s, h) => s + h.oneOffGP, 0),
    mrgp: history.reduce((s, h) => s + h.mrgp, 0),
    commission: history.reduce((s, h) => s + h.commission, 0),
    qualifiedComm: history.reduce((s, h) => s + h.qualifiedComm, 0),
    paid: history.reduce((s, h) => s + h.paid, 0),
    inTheBank: history.reduce((s, h) => s + h.inTheBank, 0),
    oneOffTarget: history.reduce((s, h) => s + h.oneOffTarget, 0),
    mrgpTarget: history.reduce((s, h) => s + h.mrgpTarget, 0),
    monthsMet: history.filter(h => h.targetMet).length,
    monthsTotal: history.length
  };

  res.render('commissions/dashboard', {
    deals, target, months, activeMonth, totalOneOffGP, totalMRGP, totalCommission, deliveredComm,
    managers, history, historyTotals, targetMet, qualifiedCommission, inTheBank, inTheBankCount
  });
});

// Staff submit deal
app.post('/commissions/submit-deal', requireLogin, (req, res) => {
  const { customer_name, is_new_customer, deal_date, one_off_gp, mrgp, contract_months, description, approver_email, project_delivered } = req.body;

  if (!customer_name || !deal_date || !approver_email) {
    req.flash('error', 'Customer, date, and approver are required');
    return res.redirect('/commissions/dashboard');
  }

  const d = new Date(deal_date);
  const month = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  const deal = {
    one_off_gp: parseFloat(one_off_gp) || 0,
    mrgp: parseFloat(mrgp) || 0,
    contract_months: parseInt(contract_months) || 12,
    is_new_customer: is_new_customer === '1' ? 1 : 0,
    manual_adjustment: 0
  };
  const comm = calcCommission(deal);
  const approver = db.prepare('SELECT name FROM users WHERE email = ?').get(approver_email);

  db.prepare(`
    INSERT INTO commission_deals
    (account_manager_email, account_manager_name, customer_name, is_new_customer, deal_date, month,
     one_off_gp, mrgp, contract_months, mrgp_multiplier, mrgp_commission_value,
     one_off_commission_rate, one_off_commission_value, total_commission,
     project_delivered, description, approver_email, approver_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    req.session.user.email, req.session.user.name, customer_name, deal.is_new_customer,
    deal_date, month, deal.one_off_gp, deal.mrgp, deal.contract_months,
    comm.mrgpMult, comm.mrgpComm, comm.oneOffRate, comm.oneOffComm, comm.total,
    project_delivered === '1' ? 1 : 0, description || '', approver_email, approver ? approver.name : ''
  );

  req.flash('success', 'Deal submitted for approval');
  res.redirect('/commissions/dashboard');
});

// Staff delete unapproved deal
app.post('/commissions/delete-deal/:id', requireLogin, (req, res) => {
  const entry = db.prepare('SELECT * FROM commission_deals WHERE id = ? AND account_manager_email = ?').get(
    req.params.id, req.session.user.email
  );
  if (!entry) { req.flash('error', 'Deal not found'); return res.redirect('/commissions/dashboard'); }
  if (entry.approved || entry.paid) { req.flash('error', 'Cannot delete approved or paid deals'); return res.redirect('/commissions/dashboard'); }
  db.prepare('DELETE FROM commission_deals WHERE id = ?').run(req.params.id);
  req.flash('success', 'Deal deleted');
  res.redirect('/commissions/dashboard');
});

// Commission Manager Dashboard
app.get('/commissions/manager', requireManager, (req, res) => {
  const monthFilter = req.query.month || '';
  const email = req.session.user.email;

  const months = db.prepare(`SELECT DISTINCT month FROM commission_deals ORDER BY month DESC`).all();
  const activeMonth = monthFilter || (months.length ? months[0].month : '');

  const pendingDeals = db.prepare(`
    SELECT * FROM commission_deals WHERE approver_email = ? AND approved = 0 ORDER BY account_manager_name, deal_date DESC
  `).all(email);

  const monthDeals = db.prepare(`
    SELECT cd.*, ct.one_off_gp_target, ct.mrgp_target, ct.salary
    FROM commission_deals cd
    LEFT JOIN commission_targets ct ON ct.user_email = cd.account_manager_email AND ct.month = cd.month
    WHERE cd.approver_email = ? AND cd.month = ?
    ORDER BY cd.account_manager_name, cd.deal_date
  `).all(email, activeMonth);

  // KPI: group by account manager for the active month
  const teamEmails = [...new Set(monthDeals.map(d => d.account_manager_email))];
  const teamKPIs = teamEmails.map(te => {
    const deals = monthDeals.filter(d => d.account_manager_email === te);
    const target = db.prepare('SELECT * FROM commission_targets WHERE user_email = ? AND month = ?').get(te, activeMonth);
    const qualifying = deals.filter(d => d.qualifies);
    const totalOneOff = qualifying.reduce((s, d) => s + d.one_off_gp, 0);
    const totalMRGP = qualifying.reduce((s, d) => s + d.mrgp, 0);
    const totalComm = deals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const deliveredComm = deals.filter(d => d.project_delivered).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    return {
      email: te,
      name: deals[0]?.account_manager_name || te,
      target,
      totalOneOff, totalMRGP, totalComm, deliveredComm,
      oneOffPct: target && target.one_off_gp_target > 0 ? (totalOneOff / target.one_off_gp_target * 100) : 0,
      mrgpPct: target && target.mrgp_target > 0 ? (totalMRGP / target.mrgp_target * 100) : 0,
      dealCount: deals.length,
      approvedCount: deals.filter(d => d.approved).length,
      pendingCount: deals.filter(d => !d.approved).length
    };
  });

  // Totals
  const teamTotalComm = teamKPIs.reduce((s, k) => s + k.totalComm, 0);
  const teamDeliveredComm = teamKPIs.reduce((s, k) => s + k.deliveredComm, 0);

  // 6-month performance history for each team member
  const allTeamMonths = db.prepare(`
    SELECT DISTINCT month FROM commission_deals WHERE approver_email = ? ORDER BY month ASC
  `).all(email).map(m => m.month);
  const last6Months = allTeamMonths.slice(-6);

  // All team members who have ever had deals under this manager
  const allTeamEmails = db.prepare(`
    SELECT DISTINCT account_manager_email, account_manager_name FROM commission_deals WHERE approver_email = ?
  `).all(email);

  const teamHistory = allTeamEmails.map(te => {
    const monthlyData = last6Months.map(m => {
      const mDeals = db.prepare(`SELECT * FROM commission_deals WHERE account_manager_email = ? AND month = ? AND approver_email = ?`).all(te.account_manager_email, m, email);
      const mTarget = db.prepare(`SELECT * FROM commission_targets WHERE user_email = ? AND month = ?`).get(te.account_manager_email, m);
      const qualifying = mDeals.filter(d => d.qualifies);
      const oneOffGP = qualifying.reduce((s, d) => s + d.one_off_gp, 0);
      const mrgp = qualifying.reduce((s, d) => s + d.mrgp, 0);
      const commission = mDeals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
      const paid = mDeals.filter(d => d.paid).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
      const oneOffTarget = mTarget ? mTarget.one_off_gp_target : 0;
      const mrgpTarget = mTarget ? mTarget.mrgp_target : 0;
      const targetMet = oneOffTarget > 0 ? oneOffGP >= oneOffTarget : false;
      const qualifiedComm = targetMet ? commission : 0;
      const inTheBank = mDeals.filter(d => d.approved && d.project_delivered && !d.paid)
        .reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
      return {
        month: m, dealCount: mDeals.length, oneOffGP, mrgp, commission, paid,
        oneOffTarget, mrgpTarget,
        oneOffPct: oneOffTarget > 0 ? (oneOffGP / oneOffTarget * 100) : 0,
        mrgpPct: mrgpTarget > 0 ? (mrgp / mrgpTarget * 100) : 0,
        targetMet, qualifiedComm, inTheBank
      };
    });
    const totals = {
      deals: monthlyData.reduce((s, h) => s + h.dealCount, 0),
      oneOffGP: monthlyData.reduce((s, h) => s + h.oneOffGP, 0),
      mrgp: monthlyData.reduce((s, h) => s + h.mrgp, 0),
      commission: monthlyData.reduce((s, h) => s + h.commission, 0),
      qualifiedComm: monthlyData.reduce((s, h) => s + h.qualifiedComm, 0),
      paid: monthlyData.reduce((s, h) => s + h.paid, 0),
      inTheBank: monthlyData.reduce((s, h) => s + h.inTheBank, 0),
      oneOffTarget: monthlyData.reduce((s, h) => s + h.oneOffTarget, 0),
      mrgpTarget: monthlyData.reduce((s, h) => s + h.mrgpTarget, 0),
      monthsMet: monthlyData.filter(h => h.targetMet).length
    };
    return { email: te.account_manager_email, name: te.account_manager_name, monthlyData, totals };
  });

  // Team aggregate history per month
  const teamMonthlyAgg = last6Months.map(m => {
    const mData = teamHistory.map(th => th.monthlyData.find(md => md.month === m)).filter(Boolean);
    return {
      month: m,
      dealCount: mData.reduce((s, d) => s + d.dealCount, 0),
      oneOffGP: mData.reduce((s, d) => s + d.oneOffGP, 0),
      mrgp: mData.reduce((s, d) => s + d.mrgp, 0),
      commission: mData.reduce((s, d) => s + d.commission, 0),
      qualifiedComm: mData.reduce((s, d) => s + d.qualifiedComm, 0),
      paid: mData.reduce((s, d) => s + d.paid, 0),
      inTheBank: mData.reduce((s, d) => s + d.inTheBank, 0),
      oneOffTarget: mData.reduce((s, d) => s + d.oneOffTarget, 0),
      mrgpTarget: mData.reduce((s, d) => s + d.mrgpTarget, 0)
    };
  });
  const teamAggTotals = {
    deals: teamMonthlyAgg.reduce((s, m) => s + m.dealCount, 0),
    oneOffGP: teamMonthlyAgg.reduce((s, m) => s + m.oneOffGP, 0),
    mrgp: teamMonthlyAgg.reduce((s, m) => s + m.mrgp, 0),
    commission: teamMonthlyAgg.reduce((s, m) => s + m.commission, 0),
    qualifiedComm: teamMonthlyAgg.reduce((s, m) => s + m.qualifiedComm, 0),
    paid: teamMonthlyAgg.reduce((s, m) => s + m.paid, 0),
    inTheBank: teamMonthlyAgg.reduce((s, m) => s + m.inTheBank, 0),
    oneOffTarget: teamMonthlyAgg.reduce((s, m) => s + m.oneOffTarget, 0),
    mrgpTarget: teamMonthlyAgg.reduce((s, m) => s + m.mrgpTarget, 0)
  };

  res.render('commissions/manager', {
    pendingDeals, monthDeals, months, activeMonth, teamKPIs, teamTotalComm, teamDeliveredComm,
    teamHistory, teamMonthlyAgg, teamAggTotals, last6Months
  });
});

app.post('/commissions/manager/approve/:id', requireManager, (req, res) => {
  db.prepare(`UPDATE commission_deals SET approved = 1, approved_at = datetime('now'), rejection_comment = NULL, rejected_at = NULL WHERE id = ? AND approver_email = ?`)
    .run(req.params.id, req.session.user.email);
  req.flash('success', 'Deal approved');
  res.redirect('/commissions/manager');
});

app.post('/commissions/manager/approve-all', requireManager, (req, res) => {
  db.prepare(`UPDATE commission_deals SET approved = 1, approved_at = datetime('now') WHERE approver_email = ? AND approved = 0`)
    .run(req.session.user.email);
  req.flash('success', 'All pending deals approved');
  res.redirect('/commissions/manager');
});

app.post('/commissions/manager/reject/:id', requireManager, (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) { req.flash('error', 'Comment required'); return res.redirect('/commissions/manager'); }
  db.prepare(`UPDATE commission_deals SET approved = 0, rejection_comment = ?, rejected_at = datetime('now') WHERE id = ? AND approver_email = ?`)
    .run(comment.trim(), req.params.id, req.session.user.email);
  req.flash('success', 'Deal sent back for review');
  res.redirect('/commissions/manager');
});

app.post('/commissions/manager/adjust/:id', requireManager, (req, res) => {
  const { manual_adjustment, adjustment_reason } = req.body;
  db.prepare(`UPDATE commission_deals SET manual_adjustment = ?, adjustment_reason = ? WHERE id = ? AND approver_email = ?`)
    .run(parseFloat(manual_adjustment) || 0, adjustment_reason || '', req.params.id, req.session.user.email);
  req.flash('success', 'Adjustment applied');
  res.redirect('/commissions/manager');
});

app.post('/commissions/manager/toggle-delivered/:id', requireManager, (req, res) => {
  const deal = db.prepare('SELECT * FROM commission_deals WHERE id = ? AND approver_email = ?').get(req.params.id, req.session.user.email);
  if (deal) {
    db.prepare('UPDATE commission_deals SET project_delivered = ?, delivered_date = ? WHERE id = ?')
      .run(deal.project_delivered ? 0 : 1, deal.project_delivered ? null : new Date().toISOString().split('T')[0], deal.id);
  }
  req.flash('success', deal.project_delivered ? 'Marked as not delivered' : 'Marked as delivered');
  res.redirect('/commissions/manager');
});

// Commission Payroll
app.get('/commissions/payroll', requirePayroll, (req, res) => {
  const monthFilter = req.query.month || '';
  const staffFilter = req.query.staff || '';
  const statusFilter = req.query.status || ''; // all, approved, pending, paid, unpaid
  const deliveryFilter = req.query.delivery || ''; // all, delivered, undelivered

  const months = db.prepare(`SELECT DISTINCT month FROM commission_deals ORDER BY month DESC`).all();
  const activeMonth = monthFilter || (months.length ? months[0].month : '');

  // All staff who have deals (for slicer)
  const allStaff = db.prepare(`SELECT DISTINCT account_manager_email, account_manager_name FROM commission_deals ORDER BY account_manager_name`).all();

  // Base query for active month
  let deals;
  if (activeMonth) {
    deals = db.prepare(`SELECT * FROM commission_deals WHERE month = ? ORDER BY account_manager_name, deal_date`).all(activeMonth);
  } else {
    deals = db.prepare(`SELECT * FROM commission_deals ORDER BY account_manager_name, deal_date DESC`).all();
  }

  // Apply slicer filters
  let filteredDeals = deals;
  if (staffFilter) {
    filteredDeals = filteredDeals.filter(d => d.account_manager_email === staffFilter);
  }
  if (statusFilter === 'approved') filteredDeals = filteredDeals.filter(d => d.approved && !d.paid);
  else if (statusFilter === 'pending') filteredDeals = filteredDeals.filter(d => !d.approved);
  else if (statusFilter === 'paid') filteredDeals = filteredDeals.filter(d => d.paid);
  else if (statusFilter === 'unpaid') filteredDeals = filteredDeals.filter(d => !d.paid);
  if (deliveryFilter === 'delivered') filteredDeals = filteredDeals.filter(d => d.project_delivered);
  else if (deliveryFilter === 'undelivered') filteredDeals = filteredDeals.filter(d => !d.project_delivered);

  // Per-staff monthly summary (always for the month, unfiltered by status/delivery for target calc)
  const amEmails = [...new Set(deals.map(d => d.account_manager_email))];
  const summary = amEmails.map(e => {
    const amDeals = deals.filter(d => d.account_manager_email === e);
    const target = db.prepare('SELECT * FROM commission_targets WHERE user_email = ? AND month = ?').get(e, activeMonth);
    const qualifying = amDeals.filter(d => d.qualifies);
    const oneOffGP = qualifying.reduce((s, d) => s + d.one_off_gp, 0);
    const mrgp = qualifying.reduce((s, d) => s + d.mrgp, 0);
    const totalComm = amDeals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const oneOffTarget = target ? target.one_off_gp_target : 0;
    const mrgpTarget = target ? target.mrgp_target : 0;
    const targetMet = oneOffTarget > 0 ? oneOffGP >= oneOffTarget : false;
    const qualifiedComm = targetMet ? totalComm : 0;
    const inTheBank = amDeals.filter(d => d.approved && d.project_delivered && !d.paid)
      .reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const paidComm = amDeals.filter(d => d.paid).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    return {
      email: e, name: amDeals[0]?.account_manager_name || e,
      target, oneOffGP, mrgp, totalComm, qualifiedComm, targetMet,
      oneOffTarget, mrgpTarget,
      oneOffPct: oneOffTarget > 0 ? (oneOffGP / oneOffTarget * 100) : 0,
      mrgpPct: mrgpTarget > 0 ? (mrgp / mrgpTarget * 100) : 0,
      inTheBank, paidComm,
      dealCount: amDeals.length,
      paidCount: amDeals.filter(d => d.paid).length,
      unpaidReadyCount: amDeals.filter(d => !d.paid && d.approved && d.project_delivered).length
    };
  });

  const targets = db.prepare(`SELECT ct.*, u.name FROM commission_targets ct LEFT JOIN users u ON u.email = ct.user_email WHERE ct.month = ? ORDER BY u.name`).all(activeMonth);
  const users = db.prepare("SELECT * FROM users WHERE role != 'payroll' ORDER BY name").all();

  res.render('commissions/payroll', {
    deals: filteredDeals, allDeals: deals, months, activeMonth, summary, targets, users, allStaff,
    staffFilter, statusFilter, deliveryFilter
  });
});

app.post('/commissions/payroll/mark-paid', requirePayroll, (req, res) => {
  const { entry_ids, paid_month } = req.body;
  if (!entry_ids || !paid_month) { req.flash('error', 'Missing fields'); return res.redirect('/commissions/payroll'); }
  const ids = Array.isArray(entry_ids) ? entry_ids : [entry_ids];
  const stmt = db.prepare('UPDATE commission_deals SET paid = 1, paid_month = ? WHERE id = ?');
  const batch = db.transaction((ids) => { for (const id of ids) stmt.run(paid_month, id); });
  batch(ids);
  req.flash('success', `Marked ${ids.length} deals as paid`);
  res.redirect('/commissions/payroll');
});

app.post('/commissions/payroll/set-target', requirePayroll, (req, res) => {
  const { user_email, month, salary } = req.body;
  if (!user_email || !month || !salary) { req.flash('error', 'All fields required'); return res.redirect('/commissions/payroll'); }
  const sal = parseFloat(salary);
  const monthlySalary = sal / 12;
  const oneOffTarget = monthlySalary * 3.5;
  const mrgpTarget = oneOffTarget * 0.0625;
  db.prepare(`INSERT INTO commission_targets (user_email, month, salary, one_off_gp_target, mrgp_target)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_email, month) DO UPDATE SET salary=?, one_off_gp_target=?, mrgp_target=?`)
    .run(user_email, month, sal, oneOffTarget, mrgpTarget, sal, oneOffTarget, mrgpTarget);
  req.flash('success', 'Target set');
  res.redirect('/commissions/payroll?month=' + month);
});

app.get('/commissions/payroll/export', requirePayroll, (req, res) => {
  const month = req.query.month || '';
  const staff = req.query.staff || '';
  const status = req.query.status || '';
  const delivery = req.query.delivery || '';

  const conditions = [];
  const params = [];
  if (month) { conditions.push('month = ?'); params.push(month); }
  if (staff) { conditions.push('account_manager_email = ?'); params.push(staff); }
  if (status === 'approved') { conditions.push('approved = 1 AND paid = 0'); }
  else if (status === 'pending') { conditions.push('approved = 0'); }
  else if (status === 'paid') { conditions.push('paid = 1'); }
  else if (status === 'unpaid') { conditions.push('paid = 0'); }
  if (delivery === 'delivered') { conditions.push('project_delivered = 1'); }
  else if (delivery === 'undelivered') { conditions.push('project_delivered = 0'); }

  let query = `SELECT account_manager_name as Name, customer_name as Customer, deal_date as Date, month as Month,
    one_off_gp as 'One Off GP', mrgp as MRGP, contract_months as 'Contract Months',
    is_new_customer as 'New Customer', one_off_commission_value as 'One Off Commission',
    mrgp_commission_value as 'MRGP Commission', manual_adjustment as 'Adjustment',
    total_commission + manual_adjustment as 'Total Commission',
    CASE WHEN project_delivered = 1 THEN 'Yes' ELSE 'No' END as Delivered,
    CASE WHEN approved = 1 THEN 'Approved' ELSE 'Pending' END as Status,
    CASE WHEN paid = 1 THEN 'Yes' ELSE 'No' END as Paid,
    paid_month as 'Paid Month' FROM commission_deals`;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY account_manager_name, deal_date`;
  const rows = db.prepare(query).all(...params);
  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  const fname = `commissions-${month || 'all'}${staff ? '-' + staff.split('@')[0] : ''}${status ? '-' + status : ''}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
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
