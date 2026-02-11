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
    return {
      month: m, dealCount: mDeals.length, oneOffGP, mrgp, commission, paid,
      oneOffTarget: mTarget ? mTarget.one_off_gp_target : 0,
      mrgpTarget: mTarget ? mTarget.mrgp_target : 0,
      oneOffPct: mTarget && mTarget.one_off_gp_target > 0 ? (oneOffGP / mTarget.one_off_gp_target * 100) : 0,
      mrgpPct: mTarget && mTarget.mrgp_target > 0 ? (mrgp / mTarget.mrgp_target * 100) : 0
    };
  });
  const historyTotals = {
    deals: history.reduce((s, h) => s + h.dealCount, 0),
    oneOffGP: history.reduce((s, h) => s + h.oneOffGP, 0),
    mrgp: history.reduce((s, h) => s + h.mrgp, 0),
    commission: history.reduce((s, h) => s + h.commission, 0),
    paid: history.reduce((s, h) => s + h.paid, 0),
    oneOffTarget: history.reduce((s, h) => s + h.oneOffTarget, 0),
    mrgpTarget: history.reduce((s, h) => s + h.mrgpTarget, 0)
  };

  res.render('commissions/dashboard', {
    deals, target, months, activeMonth, totalOneOffGP, totalMRGP, totalCommission, deliveredComm, managers, history, historyTotals
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
      return {
        month: m, dealCount: mDeals.length, oneOffGP, mrgp, commission,
        oneOffTarget: mTarget ? mTarget.one_off_gp_target : 0,
        mrgpTarget: mTarget ? mTarget.mrgp_target : 0,
        oneOffPct: mTarget && mTarget.one_off_gp_target > 0 ? (oneOffGP / mTarget.one_off_gp_target * 100) : 0,
        mrgpPct: mTarget && mTarget.mrgp_target > 0 ? (mrgp / mTarget.mrgp_target * 100) : 0
      };
    });
    const totals = {
      deals: monthlyData.reduce((s, h) => s + h.dealCount, 0),
      oneOffGP: monthlyData.reduce((s, h) => s + h.oneOffGP, 0),
      mrgp: monthlyData.reduce((s, h) => s + h.mrgp, 0),
      commission: monthlyData.reduce((s, h) => s + h.commission, 0),
      oneOffTarget: monthlyData.reduce((s, h) => s + h.oneOffTarget, 0),
      mrgpTarget: monthlyData.reduce((s, h) => s + h.mrgpTarget, 0)
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
      oneOffTarget: mData.reduce((s, d) => s + d.oneOffTarget, 0),
      mrgpTarget: mData.reduce((s, d) => s + d.mrgpTarget, 0)
    };
  });
  const teamAggTotals = {
    deals: teamMonthlyAgg.reduce((s, m) => s + m.dealCount, 0),
    oneOffGP: teamMonthlyAgg.reduce((s, m) => s + m.oneOffGP, 0),
    mrgp: teamMonthlyAgg.reduce((s, m) => s + m.mrgp, 0),
    commission: teamMonthlyAgg.reduce((s, m) => s + m.commission, 0),
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
  const months = db.prepare(`SELECT DISTINCT month FROM commission_deals ORDER BY month DESC`).all();
  const activeMonth = monthFilter || (months.length ? months[0].month : '');

  let deals;
  if (activeMonth) {
    deals = db.prepare(`SELECT * FROM commission_deals WHERE month = ? ORDER BY account_manager_name, deal_date`).all(activeMonth);
  } else {
    deals = db.prepare(`SELECT * FROM commission_deals ORDER BY account_manager_name, deal_date DESC`).all();
  }

  // Summary by account manager
  const amEmails = [...new Set(deals.map(d => d.account_manager_email))];
  const summary = amEmails.map(e => {
    const amDeals = deals.filter(d => d.account_manager_email === e);
    const target = db.prepare('SELECT * FROM commission_targets WHERE user_email = ? AND month = ?').get(e, activeMonth);
    const totalComm = amDeals.reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const deliveredComm = amDeals.filter(d => d.project_delivered).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    const approvedDeliveredComm = amDeals.filter(d => d.project_delivered && d.approved).reduce((s, d) => s + d.total_commission + d.manual_adjustment, 0);
    return {
      email: e, name: amDeals[0]?.account_manager_name || e,
      target, totalComm, deliveredComm, approvedDeliveredComm,
      dealCount: amDeals.length,
      paidCount: amDeals.filter(d => d.paid).length,
      unpaidCount: amDeals.filter(d => !d.paid && d.approved && d.project_delivered).length
    };
  });

  const targets = db.prepare(`SELECT ct.*, u.name FROM commission_targets ct LEFT JOIN users u ON u.email = ct.user_email WHERE ct.month = ? ORDER BY u.name`).all(activeMonth);
  const users = db.prepare("SELECT * FROM users WHERE role != 'payroll' ORDER BY name").all();

  res.render('commissions/payroll', { deals, months, activeMonth, summary, targets, users });
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
  const oneOffTarget = sal * 3.5;
  const mrgpTarget = oneOffTarget * 0.0625;
  db.prepare(`INSERT INTO commission_targets (user_email, month, salary, one_off_gp_target, mrgp_target)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_email, month) DO UPDATE SET salary=?, one_off_gp_target=?, mrgp_target=?`)
    .run(user_email, month, sal, oneOffTarget, mrgpTarget, sal, oneOffTarget, mrgpTarget);
  req.flash('success', 'Target set');
  res.redirect('/commissions/payroll?month=' + month);
});

app.get('/commissions/payroll/export', requirePayroll, (req, res) => {
  const month = req.query.month || '';
  let query = `SELECT account_manager_name as Name, customer_name as Customer, deal_date as Date,
    one_off_gp as 'One Off GP', mrgp as MRGP, contract_months as 'Contract Months',
    is_new_customer as 'New Customer', one_off_commission_value as 'One Off Commission',
    mrgp_commission_value as 'MRGP Commission', manual_adjustment as 'Adjustment',
    total_commission + manual_adjustment as 'Total Commission',
    CASE WHEN project_delivered = 1 THEN 'Yes' ELSE 'No' END as Delivered,
    CASE WHEN approved = 1 THEN 'Approved' ELSE 'Pending' END as Status,
    paid_month as 'Paid Month' FROM commission_deals`;
  const params = [];
  if (month) { query += ` WHERE month = ?`; params.push(month); }
  query += ` ORDER BY account_manager_name, deal_date`;
  const rows = db.prepare(query).all(...params);
  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="commissions-export-${month || 'all'}.csv"`);
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
