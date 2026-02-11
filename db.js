const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'overtime.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      overtime_rate REAL DEFAULT 0,
      nights_away_rate REAL DEFAULT 25.00,
      is_field_engineer INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS overtime_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT,
      submitter_email TEXT NOT NULL,
      submitter_name TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      halo_ticket_ref TEXT,
      client TEXT,
      description TEXT,
      approver_email TEXT,
      approver_name TEXT,
      approved INTEGER DEFAULT 0,
      approved_at TEXT,
      paid INTEGER DEFAULT 0,
      paid_month TEXT,
      is_weekend INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (submitter_email) REFERENCES users(email)
    );

    CREATE TABLE IF NOT EXISTS nights_away (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT,
      submitter_email TEXT NOT NULL,
      submitter_name TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT,
      approver_email TEXT,
      approver_name TEXT,
      approved INTEGER DEFAULT 0,
      approved_at TEXT,
      paid INTEGER DEFAULT 0,
      paid_month TEXT,
      rate REAL NOT NULL DEFAULT 25.00,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (submitter_email) REFERENCES users(email)
    );

    CREATE INDEX IF NOT EXISTS idx_overtime_submitter ON overtime_entries(submitter_email);
    CREATE INDEX IF NOT EXISTS idx_overtime_approver ON overtime_entries(approver_email);
    CREATE INDEX IF NOT EXISTS idx_nights_submitter ON nights_away(submitter_email);
    CREATE INDEX IF NOT EXISTS idx_nights_approver ON nights_away(approver_email);

    -- Commission tables
    CREATE TABLE IF NOT EXISTS commission_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      month TEXT NOT NULL,
      salary REAL NOT NULL DEFAULT 0,
      one_off_gp_target REAL NOT NULL DEFAULT 0,
      mrgp_target REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_email, month)
    );

    CREATE TABLE IF NOT EXISTS commission_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_manager_email TEXT NOT NULL,
      account_manager_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      is_new_customer INTEGER DEFAULT 0,
      deal_date TEXT NOT NULL,
      month TEXT NOT NULL,
      one_off_gp REAL DEFAULT 0,
      mrgp REAL DEFAULT 0,
      contract_months INTEGER DEFAULT 12,
      mrgp_multiplier REAL DEFAULT 1,
      mrgp_commission_value REAL DEFAULT 0,
      one_off_commission_rate REAL DEFAULT 0.10,
      one_off_commission_value REAL DEFAULT 0,
      total_commission REAL DEFAULT 0,
      project_delivered INTEGER DEFAULT 0,
      delivered_date TEXT,
      qualifies INTEGER DEFAULT 1,
      description TEXT,
      approver_email TEXT,
      approver_name TEXT,
      approved INTEGER DEFAULT 0,
      approved_at TEXT,
      paid INTEGER DEFAULT 0,
      paid_month TEXT,
      rejection_comment TEXT,
      rejected_at TEXT,
      manual_adjustment REAL DEFAULT 0,
      adjustment_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_commission_deals_am ON commission_deals(account_manager_email);
    CREATE INDEX IF NOT EXISTS idx_commission_deals_approver ON commission_deals(approver_email);
    CREATE INDEX IF NOT EXISTS idx_commission_deals_month ON commission_deals(month);
  `);

  // Add rejection_comment column if not exists (migration)
  const cols = db.prepare("PRAGMA table_info(overtime_entries)").all();
  if (!cols.find(c => c.name === 'rejection_comment')) {
    db.exec("ALTER TABLE overtime_entries ADD COLUMN rejection_comment TEXT");
    db.exec("ALTER TABLE overtime_entries ADD COLUMN rejected_at TEXT");
  }

  // Create default payroll user if not exists
  const payroll = db.prepare('SELECT id FROM users WHERE email = ?').get('payroll@flotek.io');
  if (!payroll) {
    const hash = bcrypt.hashSync('payroll', 10);
    db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
      'payroll@flotek.io', 'Payroll Admin', hash, 'payroll'
    );
  }
}

function ensureUser(email, name) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;

  // Password is first name from email: firstname.lastname@flotek.io -> firstname
  const firstName = email.split('@')[0].split('.')[0];
  const hash = bcrypt.hashSync(firstName, 10);

  // Determine role - if this email appears as an approver, give manager role
  const isApprover = db.prepare('SELECT 1 FROM overtime_entries WHERE approver_email = ? LIMIT 1').get(email);
  const role = isApprover ? 'manager' : 'staff';

  const result = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    email, name, hash, role
  );
  return result.lastInsertRowid;
}

function promoteToManager(email) {
  db.prepare("UPDATE users SET role = 'manager' WHERE email = ? AND role = 'staff'").run(email);
}

function getExpectedPaidMonth(dateStr) {
  // If no paid date, assume paid the month after submission
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + 1);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

function calcMrgpMultiplier(contractMonths) {
  if (contractMonths >= 60) return 3;
  if (contractMonths >= 13) return 2;
  return 1;
}

function calcCommission(deal) {
  const oneOffRate = deal.is_new_customer ? 0.20 : 0.10;
  const oneOffComm = deal.one_off_gp * oneOffRate;
  const mrgpMult = calcMrgpMultiplier(deal.contract_months);
  const mrgpComm = deal.mrgp * mrgpMult;
  const total = oneOffComm + mrgpComm + (deal.manual_adjustment || 0);
  return { oneOffRate, oneOffComm, mrgpMult, mrgpComm, total };
}

init();

module.exports = { db, ensureUser, promoteToManager, getExpectedPaidMonth, calcMrgpMultiplier, calcCommission };
