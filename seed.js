const { db, ensureUser, promoteToManager } = require('./db');
const bcrypt = require('bcryptjs');

console.log('Seeding database with dummy data...');

// Staff members
const staff = [
  { email: 'james.wilson@flotek.io', name: 'James Wilson', rate: 22.50, fieldEngineer: 1 },
  { email: 'sarah.thompson@flotek.io', name: 'Sarah Thompson', rate: 18.75, fieldEngineer: 0 },
  { email: 'michael.brown@flotek.io', name: 'Michael Brown', rate: 25.00, fieldEngineer: 1 },
  { email: 'emma.davies@flotek.io', name: 'Emma Davies', rate: 20.00, fieldEngineer: 0 },
  { email: 'daniel.roberts@flotek.io', name: 'Daniel Roberts', rate: 23.00, fieldEngineer: 1 },
  { email: 'lucy.hall@flotek.io', name: 'Lucy Hall', rate: 19.50, fieldEngineer: 0 },
];

// Managers
const managers = [
  { email: 'david.mitchell@flotek.io', name: 'David Mitchell' },
  { email: 'karen.taylor@flotek.io', name: 'Karen Taylor' },
];

// Create staff users
staff.forEach(s => {
  ensureUser(s.email, s.name);
  db.prepare('UPDATE users SET overtime_rate = ?, nights_away_rate = ?, is_field_engineer = ? WHERE email = ?')
    .run(s.rate, s.fieldEngineer ? 50 : 25, s.fieldEngineer, s.email);
});

// Create manager users
managers.forEach(m => {
  ensureUser(m.email, m.name);
  promoteToManager(m.email);
});

// Descriptions pool
const descriptions = [
  'Emergency server migration for client',
  'Network switch replacement at CEMEX site',
  'After-hours patching and updates',
  'On-call incident response - critical P1',
  'Weekend site visit for UPS installation',
  'Out of hours firewall configuration',
  'Client office relocation support',
  'Overnight data centre maintenance',
  'Emergency VPN tunnel rebuild',
  'After-hours backup recovery',
  'Weekend rollout of new desktops',
  'Urgent printer deployment for NHS',
  'Late night Teams phone migration',
  'Server room cooling failure response',
  'Out of hours Active Directory migration',
];

const clients = ['CEMEX', 'NHS', '', '', 'CEMEX', 'NHS', '', 'CEMEX', '', 'NHS'];
const tickets = ['HAL-1234', 'HAL-2056', 'HAL-3891', 'HAL-4102', 'HAL-5567', '', '', 'HAL-6234', 'HAL-7890', ''];

// Assignments: which manager approves which staff
const assignments = {
  'david.mitchell@flotek.io': ['james.wilson@flotek.io', 'sarah.thompson@flotek.io', 'michael.brown@flotek.io'],
  'karen.taylor@flotek.io': ['emma.davies@flotek.io', 'daniel.roberts@flotek.io', 'lucy.hall@flotek.io'],
};

let submissionId = 1000;

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomHours() {
  const options = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8];
  return options[Math.floor(Math.random() * options.length)];
}

// Generate overtime entries across Sep 2025 - Jan 2026
const months = [
  { year: 2025, month: 9, label: 'September 2025', paid: 'October 2025' },
  { year: 2025, month: 10, label: 'October 2025', paid: 'November 2025' },
  { year: 2025, month: 11, label: 'November 2025', paid: 'December 2025' },
  { year: 2025, month: 12, label: 'December 2025', paid: 'January 2026' },
  { year: 2026, month: 1, label: 'January 2026', paid: '' }, // Current - unpaid
];

const insertOT = db.prepare(`
  INSERT INTO overtime_entries
  (submission_id, submitter_email, submitter_name, date, hours, halo_ticket_ref, client, description, approver_email, approver_name, approved, approved_at, paid, paid_month, is_weekend, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertNA = db.prepare(`
  INSERT INTO nights_away
  (submission_id, submitter_email, submitter_name, date, description, approver_email, approver_name, approved, approved_at, paid, paid_month, rate, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  for (const [managerEmail, staffEmails] of Object.entries(assignments)) {
    const manager = managers.find(m => m.email === managerEmail);

    for (const staffEmail of staffEmails) {
      const member = staff.find(s => s.email === staffEmail);

      for (const m of months) {
        // Generate 2-5 overtime entries per person per month
        const numEntries = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numEntries; i++) {
          const day = 1 + Math.floor(Math.random() * 28);
          const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const d = new Date(dateStr);
          const isWeekend = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0;
          const hours = randomHours();
          const isPast = m.month <= 12 && m.year === 2025;
          const isJan = m.month === 1 && m.year === 2026;

          // Past months: all approved and paid
          // Dec 2025: approved but some unpaid
          // Jan 2026: mix of approved and pending, none paid
          let approved = 1;
          let approvedAt = `${dateStr}T18:00:00`;
          let paid = 0;
          let paidMonth = '';

          if (m.month <= 11 && m.year === 2025) {
            // Sep-Nov: all paid
            approved = 1;
            paid = 1;
            paidMonth = m.paid;
          } else if (m.month === 12 && m.year === 2025) {
            // Dec: approved, half paid
            approved = 1;
            paid = i < numEntries / 2 ? 1 : 0;
            paidMonth = paid ? m.paid : '';
          } else {
            // Jan 2026: mix pending/approved, none paid
            approved = Math.random() > 0.4 ? 0 : 1;
            approvedAt = approved ? `${dateStr}T18:00:00` : null;
            paid = 0;
            paidMonth = '';
          }

          submissionId++;
          insertOT.run(
            String(submissionId),
            staffEmail,
            member.name,
            dateStr,
            hours,
            randomItem(tickets),
            randomItem(clients),
            randomItem(descriptions),
            managerEmail,
            manager.name,
            approved,
            approvedAt,
            paid,
            paidMonth,
            isWeekend,
            dateStr
          );
        }

        // Generate 0-2 nights away per person per month (field engineers get more)
        const numNights = member.fieldEngineer ? Math.floor(Math.random() * 3) : (Math.random() > 0.6 ? 1 : 0);
        for (let i = 0; i < numNights; i++) {
          const day = 1 + Math.floor(Math.random() * 28);
          const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

          let approved = 1;
          let approvedAt = `${dateStr}T18:00:00`;
          let paid = 0;
          let paidMonth = '';

          if (m.month <= 11 && m.year === 2025) {
            paid = 1;
            paidMonth = m.paid;
          } else if (m.month === 12 && m.year === 2025) {
            paid = i === 0 ? 1 : 0;
            paidMonth = paid ? m.paid : '';
          } else {
            approved = Math.random() > 0.4 ? 0 : 1;
            approvedAt = approved ? `${dateStr}T18:00:00` : null;
          }

          submissionId++;
          insertNA.run(
            String(submissionId),
            staffEmail,
            member.name,
            dateStr,
            randomItem(descriptions),
            managerEmail,
            manager.name,
            approved,
            approvedAt,
            paid,
            paidMonth,
            member.fieldEngineer ? 50 : 25,
            dateStr
          );
        }
      }
    }
  }
});

seed();

// Print summary
const otCount = db.prepare('SELECT COUNT(*) as c FROM overtime_entries').get().c;
const naCount = db.prepare('SELECT COUNT(*) as c FROM nights_away').get().c;
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;

console.log(`\nSeeded successfully!`);
console.log(`  Users: ${userCount}`);
console.log(`  Overtime entries: ${otCount}`);
console.log(`  Nights away entries: ${naCount}`);
console.log(`\n--- Login credentials ---`);
console.log(`\nStaff:`);
staff.forEach(s => {
  const firstName = s.email.split('@')[0].split('.')[0];
  console.log(`  ${s.name.padEnd(20)} ${s.email.padEnd(30)} password: ${firstName}`);
});
console.log(`\nManagers:`);
managers.forEach(m => {
  const firstName = m.email.split('@')[0].split('.')[0];
  console.log(`  ${m.name.padEnd(20)} ${m.email.padEnd(30)} password: ${firstName}`);
});
console.log(`\nPayroll:`);
console.log(`  Payroll Admin       payroll@flotek.io              password: payroll`);
