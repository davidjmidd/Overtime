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

init();

module.exports = { db, ensureUser, promoteToManager, getExpectedPaidMonth };
