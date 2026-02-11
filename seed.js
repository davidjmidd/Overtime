const { db, ensureUser, promoteToManager, calcMrgpMultiplier, calcCommission } = require('./db');
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

// ============ COMMISSION SEED DATA ============

// Account managers (sales staff) - some overlap with existing staff, some new
const accountManagers = [
  { email: 'sarah.thompson@flotek.io', name: 'Sarah Thompson', salary: 32000 },
  { email: 'emma.davies@flotek.io', name: 'Emma Davies', salary: 28000 },
  { email: 'tom.carter@flotek.io', name: 'Tom Carter', salary: 35000 },
  { email: 'rachel.green@flotek.io', name: 'Rachel Green', salary: 30000 },
];

// Ensure new commission-only staff exist
accountManagers.forEach(am => ensureUser(am.email, am.name));

// Commission months
const commMonths = [
  { label: 'October 2025', year: 2025, month: 10 },
  { label: 'November 2025', year: 2025, month: 11 },
  { label: 'December 2025', year: 2025, month: 12 },
  { label: 'January 2026', year: 2026, month: 1 },
];

// Customer names pool
const customers = [
  'Acme Industries', 'Bright Solutions Ltd', 'ClearView Technologies', 'Dataflow Systems',
  'EdgePoint Consulting', 'Foxbridge Manufacturing', 'GreenLeaf Energy', 'Hilltop Healthcare',
  'Ironstone Construction', 'Jupiter Media Group', 'KeyStone Financial', 'Lakeview Properties',
  'Metro Logistics', 'NorthStar Retail', 'Oceanic Trading', 'Pinnacle Education',
  'QuickServ Hospitality', 'Redline Automotive', 'Skyward Aviation', 'TrueNorth Engineering',
];

const contractOptions = [12, 12, 12, 24, 24, 36, 36, 48, 60];

const insertTarget = db.prepare(`
  INSERT OR REPLACE INTO commission_targets (user_email, month, salary, one_off_gp_target, mrgp_target)
  VALUES (?, ?, ?, ?, ?)
`);

const insertDeal = db.prepare(`
  INSERT INTO commission_deals
  (account_manager_email, account_manager_name, customer_name, is_new_customer, deal_date, month,
   one_off_gp, mrgp, contract_months, mrgp_multiplier, mrgp_commission_value,
   one_off_commission_rate, one_off_commission_value, total_commission,
   project_delivered, delivered_date, qualifies, description,
   approver_email, approver_name, approved, approved_at,
   paid, paid_month, manual_adjustment, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Manager who approves commissions
const commissionManager = managers[0]; // David Mitchell

const seedCommissions = db.transaction(() => {
  let custIdx = 0;

  for (const am of accountManagers) {
    const monthlySalary = am.salary / 12;
    const oneOffTarget = monthlySalary * 3.5;
    const mrgpTarget = oneOffTarget * 0.0625;

    // Set targets for each month
    for (const m of commMonths) {
      insertTarget.run(am.email, m.label, am.salary, oneOffTarget, mrgpTarget);
    }

    // Generate deals per month
    for (const m of commMonths) {
      const numDeals = 2 + Math.floor(Math.random() * 4); // 2-5 deals per month

      for (let i = 0; i < numDeals; i++) {
        const customer = customers[custIdx % customers.length];
        custIdx++;
        const isNew = Math.random() > 0.7 ? 1 : 0;
        const day = 1 + Math.floor(Math.random() * 28);
        const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const oneOffGP = Math.round((1000 + Math.random() * 15000) * 100) / 100;
        const mrgp = Math.round((100 + Math.random() * 2000) * 100) / 100;
        const contractMonths = randomItem(contractOptions);

        const deal = { is_new_customer: isNew, one_off_gp: oneOffGP, mrgp: mrgp, contract_months: contractMonths, manual_adjustment: 0 };
        const calc = calcCommission(deal);

        const isPast = (m.year === 2025);
        const isJan = (m.year === 2026 && m.month === 1);

        // Delivery status: past months mostly delivered, Jan mixed
        let delivered = 0;
        let deliveredDate = null;
        if (isPast) {
          delivered = Math.random() > 0.15 ? 1 : 0;
          deliveredDate = delivered ? dateStr : null;
        } else {
          delivered = Math.random() > 0.5 ? 1 : 0;
          deliveredDate = delivered ? dateStr : null;
        }

        // Approval status
        let approved = 0;
        let approvedAt = null;
        if (m.month <= 11 && m.year === 2025) {
          // Oct-Nov: all approved
          approved = 1;
          approvedAt = `${dateStr}T18:00:00`;
        } else if (m.month === 12 && m.year === 2025) {
          // Dec: mostly approved
          approved = Math.random() > 0.2 ? 1 : 0;
          approvedAt = approved ? `${dateStr}T18:00:00` : null;
        } else {
          // Jan: mix
          approved = Math.random() > 0.5 ? 1 : 0;
          approvedAt = approved ? `${dateStr}T18:00:00` : null;
        }

        // Paid status
        let paid = 0;
        let paidMonth = '';
        if (m.month <= 11 && m.year === 2025 && approved && delivered) {
          paid = 1;
          paidMonth = m.month === 10 ? 'November 2025' : 'December 2025';
        } else if (m.month === 12 && m.year === 2025 && approved && delivered) {
          paid = Math.random() > 0.5 ? 1 : 0;
          paidMonth = paid ? 'January 2026' : '';
        }

        insertDeal.run(
          am.email, am.name, customer, isNew, dateStr, m.label,
          oneOffGP, mrgp, contractMonths, calc.mrgpMult, calc.mrgpComm,
          calc.oneOffRate, calc.oneOffComm, calc.total,
          delivered, deliveredDate, 1, null,
          commissionManager.email, commissionManager.name,
          approved, approvedAt,
          paid, paidMonth, 0, dateStr
        );
      }
    }
  }
});

seedCommissions();

// Print summary
const otCount = db.prepare('SELECT COUNT(*) as c FROM overtime_entries').get().c;
const naCount = db.prepare('SELECT COUNT(*) as c FROM nights_away').get().c;
const dealCount = db.prepare('SELECT COUNT(*) as c FROM commission_deals').get().c;
const targetCount = db.prepare('SELECT COUNT(*) as c FROM commission_targets').get().c;
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;

console.log(`\nSeeded successfully!`);
console.log(`  Users: ${userCount}`);
console.log(`  Overtime entries: ${otCount}`);
console.log(`  Nights away entries: ${naCount}`);
console.log(`  Commission deals: ${dealCount}`);
console.log(`  Commission targets: ${targetCount}`);
console.log(`\n--- Login credentials ---`);
console.log(`\nStaff (Overtime):`);
staff.forEach(s => {
  const firstName = s.email.split('@')[0].split('.')[0];
  console.log(`  ${s.name.padEnd(20)} ${s.email.padEnd(30)} password: ${firstName}`);
});
console.log(`\nAccount Managers (Commissions):`);
accountManagers.forEach(am => {
  const firstName = am.email.split('@')[0].split('.')[0];
  console.log(`  ${am.name.padEnd(20)} ${am.email.padEnd(30)} password: ${firstName}`);
});
console.log(`\nManagers:`);
managers.forEach(m => {
  const firstName = m.email.split('@')[0].split('.')[0];
  console.log(`  ${m.name.padEnd(20)} ${m.email.padEnd(30)} password: ${firstName}`);
});
console.log(`\nPayroll:`);
console.log(`  Payroll Admin       payroll@flotek.io              password: payroll`);
