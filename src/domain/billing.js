// @ts-check
// Billing you can send (ADR 0011, audit #6 and C9). A real yard only; mixed into Simulation.prototype.
//   customers        customerSave / customerRemove / customerRestore (soft, with a reason) / customerLinkSites (the one-time link of the
//                    free-text client fields, reversible with customerUnlinkSite); a site links to one customer and may carry its own PO
//   hire settings    hireSettings (owner): the hire-stop rule and its window, the accounting file's account codes, retention years
//   off-hire         offHireRequested: the notice (who called, when), a pickup number and one bring-back order for the day;
//                    hireNotices feeds the hire book's reading of the hire-stop rule (hire.js hireOffHire)
//   statements       statementIssue: ONE statement per customer across all its sites, sequential number, a stored snapshot (lines, rates,
//                    GST, totals, the rule's wording, charge lines, adjustments) and its rendered text; immutable (migration 010 triggers);
//                    statementReverse voids one by a reversing statement; adjustmentAdd records a change after issue (owner)
//   the file         accountingFile: the month's statements as Xero 'Sales invoices' CSV, MYOB 'Sales' tab-delimited, or a generic CSV
//   unbilled         unbilledView: hire accrued past billedUpTo per customer and site (Today's card, Needs you)
//   parallel run     parallelRun: the app's figure per customer beside what the office invoiced, with the difference
//   retention        clockRetention: a real yard never hard-deletes money- or time-relevant records; only closed messages and
//                    notifications older than retentionYears go
import { createHash, randomUUID } from 'node:crypto';
import { requireRule, integer } from './geometry.js';
import { AppError } from '../service.js';
import { cached } from '../database.js';
import { requireLive } from './mode.js';
import { addDays, daysBetween, dayLabel } from './schedule.js';
import { bdAbnValid, bdAbnFormat } from './brand.js';
import {
  hireGst,
  hireMoney,
  hireDollars,
  lineGst,
  GST_PERCENT,
  STOP_RULES,
  STOP_RULE_WORDS,
  stopRuleWords,
} from './hire.js';
/** Commands here and the permission each needs (simulation.js execute). */
export const CUSTOMER_OPS = [
  'customerSave',
  'customerRemove',
  'customerRestore',
  'customerLinkSites',
  'customerUnlinkSite',
];
export const STATEMENT_OPS = ['statementIssue'];
export const OWNER_BILLING_OPS = ['hireSettings', 'statementReverse', 'adjustmentAdd'];
export const OFF_HIRE_OPS = ['offHireRequested'];
export const UNBILLED_DAYS = 31;
export const FOOTER = 'Statement — your accounting package issues the tax invoice.';
const DAY = /^\d{4}-\d{2}-\d{2}$/,
  MONTH = /^\d{4}-(0[1-9]|1[0-2])$/,
  MAX_CENTS = 100000000;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(v:unknown,name:string,max?:number)=>string|null} */
const optText = (v, name, max = 200) => {
  if (v === undefined || v === null) return null;
  requireRule(typeof v === 'string', name + ' must be text.');
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  requireRule(s.length <= max, name + ' can be at most ' + max + ' characters.');
  return s;
};
/** @type {(v:unknown,name:string,max?:number)=>string} */
const text = (v, name, max = 120) => {
  const s = optText(v, name, max);
  requireRule(s, name + ' is required.');
  return /** @type {string} */ (s);
};
const dayArg = (/** @type {unknown} */ v, /** @type {string} */ label) => {
  if (!(typeof v === 'string' && DAY.test(v) && addDays(v, 0) === v))
    throw new AppError(400, label + ' must be a date (YYYY-MM-DD).');
  return v;
};
/** Names compare with case and spacing ignored. @type {(s:string)=>string} */
export const nameKey = (s) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const pad6 = (/** @type {number} */ n) => String(n).padStart(6, '0');
/** 'Sat 19 Sep 2026': the locked document carries the year (kept for years). @type {(d:string)=>string} */
export const dayYear = (d) => (d ? dayLabel(d) + ' ' + d.slice(0, 4) : '');
/** The pieces column in words: '30 at start · 24 in · 54 out · 0 at end' when gear moved inside the period. @param {any} l */
export function piecesWords(l) {
  const m = l.moved;
  if (!m || (!m.in && !m.out)) return l.start + ' at start, ' + l.end + ' at end';
  return [
    l.start + ' at start',
    m.in ? m.in + ' in' : '',
    m.out ? m.out + ' out' + (m.sameDay ? ' (' + m.sameDay + ' same-day return)' : '') : '',
    l.end + ' at end',
  ]
    .filter(Boolean)
    .join(' · ');
}
/** The minimum-hire top-up in words: '24 × 28 days + 30 × 17 days short of the 28-day minimum'. @param {any} t */
export function topUpWords(t) {
  const parts = (t?.parts ?? []).map((p) => p.q + ' × ' + plural(p.days, 'day'));
  return (
    (parts.length ? parts.join(' + ') + ' short of the ' : 'back before the ') +
    t.minDays +
    '-day minimum' +
    (parts.length ? '' : ' (' + plural(t.pieceDays, 'piece-day') + ')')
  );
}
/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (Xero and MYOB in Australia). @type {(d:string)=>string} */
export const auDate = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '');
/** Cents as '12.50' with a sign, for the accounting file. @type {(c:number)=>string} */
export const fileMoney = (c) => (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2);
// The statement's GST shared across its lines so the file's GST equals the statement's (largest remainder): cents.
/** @param {number[]} amounts @param {number} gst @returns {number[]} */
export function shareGst(amounts, gst) {
  const out = amounts.map((a) => Math.round((a * GST_PERCENT) / 100));
  let diff = gst - out.reduce((s, x) => s + x, 0);
  if (!diff || !amounts.length) return out;
  const order = amounts
    .map((a, i) => ({ i, r: (a * GST_PERCENT) / 100 - out[i] }))
    .sort((x, y) => (diff > 0 ? y.r - x.r : x.r - y.r));
  for (let k = 0; diff; k = (k + 1) % order.length) {
    out[order[k].i] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  return out;
}
// A number (an amount, a quantity) goes in as it is; text starting like a formula is disarmed for spreadsheets.
const NUMBER = /^-?\d+(\.\d+)?$/;
const guard = (/** @type {string} */ s) => (NUMBER.test(s) ? s : s.replace(/^[=+@-]/, "'$&"));
const csvCell = (/** @type {unknown} */ v) => '"' + guard(String(v ?? '')).replaceAll('"', '""') + '"';
/** @type {(rows:unknown[][])=>string} */
export const csvText = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
/** Tab-delimited (MYOB): tabs and line breaks inside a value become spaces. @type {(rows:unknown[][])=>string} */
export const tabText = (rows) =>
  rows.map((r) => r.map((v) => guard(String(v ?? '').replace(/[\t\r\n]+/g, ' '))).join('\t')).join('\r\n') + '\r\n';
// Xero's 'Sales invoices' import template, in Xero's order (ADR 0011 cites the sources).
export const XERO_HEAD = [
  '*ContactName',
  'EmailAddress',
  'POAddressLine1',
  'POAddressLine2',
  'POAddressLine3',
  'POAddressLine4',
  'POCity',
  'PORegion',
  'POPostalCode',
  'POCountry',
  '*InvoiceNumber',
  'Reference',
  '*InvoiceDate',
  '*DueDate',
  'InventoryItemCode',
  '*Description',
  '*Quantity',
  '*UnitAmount',
  'Discount',
  '*AccountCode',
  '*TaxType',
  'TrackingName1',
  'TrackingOption1',
  'TrackingName2',
  'TrackingOption2',
  'Currency',
  'BrandingTheme',
];
// MYOB AccountRight / MYOB Business 'Sales - Service' import fields, in MYOB's order (the published field list, ADR 0011).
export const MYOB_HEAD = [
  'Co./Last Name',
  'First Name',
  'Addr 1 - Line 1',
  'Addr 1 - Line 2',
  'Addr 1 - Line 3',
  'Addr 1 - Line 4',
  'Inclusive',
  'Invoice No.',
  'Date',
  'Customer PO',
  'Ship Via',
  'Delivery Status',
  'Description',
  'Account No.',
  'Amount',
  'Job',
  'Comment',
  'Journal Memo',
  'Salesperson Last Name',
  'Salesperson First Name',
  'Promised Date',
  'Referral Source',
  'Tax Code',
  'Tax Amount',
  'Freight Amount',
  'Freight Tax Code',
  'Freight Tax Amount',
  'Sale Status',
  'Currency Code',
  'Terms - Payment is Due',
  'Terms - Discount Days',
  'Terms - Balance Due Days',
  'Terms - % Discount',
  'Terms - % Monthly Charge',
  'Amount Paid',
  'Payment Method',
  'Payment Notes',
  'Name on Card',
  'Card Number',
  'Authorisation Code',
  'BSB',
  'Account Number',
  'Drawer/Account Name',
  'Cheque Number',
  'Category',
  'Card ID',
  'Record ID',
];
export const GENERIC_HEAD = [
  'Statement',
  'Customer',
  'Customer ABN',
  'Billing email',
  'Issued',
  'Due',
  'PO',
  'Site',
  'Line',
  'Description',
  'Quantity',
  'Amount ex GST',
  'GST',
  'Amount inc GST',
  'Reverses',
];
const FORMAT_WORDS = { XERO: 'Xero', MYOB: 'MYOB', GENERIC: 'Generic CSV' };
const CHARGE_WORDS = { LOST: 'lost, charged', DAMAGED: 'damaged, charged', SITE_FINISH: 'not returned at site finish' };
/** Every line of a statement as the accounting file rows it: hire lines, top-ups, charges, adjustments. */
function statementRows(/** @type {any} */ st) {
  /** @type {{site:string|null,kind:string,description:string,amount:number}[]} */
  const rows = [];
  for (const s of st.sites) {
    const period = ' · hire ' + dayLabel(s.from) + ' to ' + dayLabel(s.to);
    for (const l of s.lines) {
      const name = l.product.name + (l.split ? ' (' + dayLabel(l.rateFrom) + ' to ' + dayLabel(l.rateTo) + ')' : '');
      rows.push({
        site: s.name,
        kind: 'HIRE',
        description: s.name + ' · ' + name + period + ' · ' + piecesWords(l) + ' · ' + plural(l.pieceDays, 'piece-day'),
        amount: l.amount ?? 0,
      });
      if (l.topUp)
        rows.push({
          site: s.name,
          kind: 'MINIMUM_HIRE',
          description: s.name + ' · ' + l.product.name + ' · minimum hire top-up: ' + topUpWords(l.topUp),
          amount: l.topUp.amount ?? 0,
        });
    }
    for (const c of s.charges)
      rows.push({
        site: s.name,
        kind: 'CHARGE',
        description:
          s.name +
          ' · ' +
          c.name +
          ' × ' +
          c.quantity +
          ' · ' +
          (CHARGE_WORDS[/** @type {keyof typeof CHARGE_WORDS} */ (c.reason)] ?? c.reason) +
          ' (' +
          dayLabel(c.occurredOn) +
          ')',
        amount: c.amount,
      });
  }
  for (const a of st.adjustments)
    rows.push({
      site: a.siteName ?? null,
      kind: 'ADJUSTMENT',
      description:
        'Adjustment · ' + a.description + ' · ' + a.reason + (a.statement ? ' (' + a.statement.number + ')' : ''),
      amount: a.amount,
    });
  return rows;
}
// The statement as one page of plain text: what a reprint returns, byte for byte (built from the snapshot alone, nothing read live).
/** @param {any} st */
export function statementText(st) {
  const money = (/** @type {number|null} */ c) => (c == null ? '' : hireDollars(c));
  const out = [
    'HIRE STATEMENT ' + st.number + (st.reverses ? ' (reverses ' + st.reverses.number + ')' : ''),
    ...(st.reverses && st.reason ? ['Reverses ' + st.reverses.number + ': ' + st.reason] : []),
    st.company.name + (st.company.abnText ? ' · ABN ' + st.company.abnText : ''),
    ...st.company.address,
    '',
    'To: ' + st.customer.name + (st.customer.abnText ? ' · ABN ' + st.customer.abnText : ''),
    ...(st.customer.address ? [st.customer.address] : []),
    ...(st.customer.billingEmail ? [st.customer.billingEmail] : []),
    'Issued ' + dayYear(st.issuedOn) + (st.dueOn ? ' · due ' + dayYear(st.dueOn) : ''),
    'Period ' + dayYear(st.from) + ' to ' + dayYear(st.to),
    'Amounts in AUD, ex GST unless marked',
    '',
  ];
  for (const s of st.sites) {
    out.push(
      s.name +
        (s.po ? ' · PO ' + s.po : '') +
        ' · hire ' +
        dayYear(s.from) +
        ' to ' +
        dayYear(s.to) +
        ' (' +
        plural(daysBetween(s.from, s.to) + 1, 'day') +
        ')',
    );
    for (const l of s.lines) {
      out.push(
        '  ' +
          l.product.name +
          (l.split ? ' (' + dayLabel(l.rateFrom) + ' to ' + dayLabel(l.rateTo) + ')' : '') +
          ' · ' +
          piecesWords(l) +
          ' · ' +
          plural(l.pieceDays, 'piece-day') +
          ' · ' +
          rateWords(l.rate) +
          ' · ' +
          money(l.amount),
      );
      if (l.topUp)
        out.push(
          '    minimum hire top-up: ' +
            topUpWords(l.topUp) +
            ' · ' +
            plural(l.topUp.pieceDays, 'piece-day') +
            ' · ' +
            money(l.topUp.amount),
        );
      for (const o of l.offHire ?? []) out.push('    ' + o.words);
    }
    for (const c of s.charges)
      out.push(
        '  ' +
          c.name +
          ' × ' +
          c.quantity +
          ' · ' +
          (CHARGE_WORDS[/** @type {keyof typeof CHARGE_WORDS} */ (c.reason)] ?? c.reason) +
          ' ' +
          dayLabel(c.occurredOn) +
          ' · ' +
          money(c.unitValue) +
          ' each · approved by ' +
          (c.approvedBy ?? 'the office') +
          ' · ' +
          money(c.amount),
      );
    out.push('  Site subtotal ' + money(s.subtotal), '');
  }
  for (const a of st.adjustments)
    out.push(
      'Adjustment ' +
        a.number +
        ' · ' +
        a.description +
        ' · ' +
        a.reason +
        (a.statement ? ' (' + a.statement.number + ')' : '') +
        ' · approved by ' +
        a.approvedBy.name +
        ' · ' +
        money(a.amount),
    );
  if (st.adjustments.length) out.push('');
  out.push(
    'Subtotal (ex GST) ' + money(st.subtotal),
    'GST ' + st.gstPercent + '% ' + money(st.gst),
    'Total (inc GST) ' + money(st.total),
    '',
    st.hireStopRule,
    st.footer,
    'Issued by ' +
      st.issuedBy.name +
      ' · ' +
      (st.issuedHm ? dayYear(st.issuedOn) + ' ' + st.issuedHm + (st.zone ? ' (' + st.zone + ')' : '') : st.issuedAt),
  );
  return out.join('\n') + '\n';
}
const rateWords = (/** @type {any} */ r) =>
  !r?.priced
    ? 'NO RATE'
    : [r.week != null ? hireDollars(r.week) + '/week' : '', r.day != null ? hireDollars(r.day) + '/day' : '']
        .filter(Boolean)
        .join(' + ') + (r.source === 'site' ? ' (site rate)' : '');
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const EMPTY_SETTINGS = {
  stopRule: 'OFF_HIRE_DAY',
  collectWithinDays: 7,
  xeroAccountCode: null,
  xeroTaxType: 'GST on Income',
  myobAccountNumber: null,
  myobTaxCode: 'GST',
  retentionYears: 7,
};
const retentionRuns = new WeakMap();

/** @type {Record<string,any> & ThisType<any>} */
export const billingMethods = {
  // ---------- settings ----------
  hireSettingsRecord() {
    return this.repo.all('hireSettings')[0] ?? null;
  },
  // The settings as pages read them, with 'not set' plain: the account codes are the owner's, never guessed.
  hireSettingsView() {
    const r = this.hireSettingsRecord(),
      d = { ...EMPTY_SETTINGS, ...(r ?? {}) };
    return {
      stopRule: d.stopRule,
      stopRuleWords: STOP_RULE_WORDS[/** @type {keyof typeof STOP_RULE_WORDS} */ (d.stopRule)],
      collectWithinDays: d.collectWithinDays,
      ruleSentence: stopRuleWords(d.stopRule, d.collectWithinDays),
      xeroAccountCode: d.xeroAccountCode,
      xeroTaxType: d.xeroTaxType,
      myobAccountNumber: d.myobAccountNumber,
      myobTaxCode: d.myobTaxCode,
      retentionYears: d.retentionYears,
      xeroReady: !!d.xeroAccountCode,
      myobReady: !!d.myobAccountNumber,
      set: !!r,
      updatedAt: r?.updatedAt ?? null,
      updatedOn: r?.updatedAt ? this.planDayOfIso(r.updatedAt) : null, // the company's day, never a slice of the ISO stamp
    };
  },
  // The owner's: the hire-stop rule and its window, the file's account codes and tax names, retention years.
  hireSettings(/** @type {any} */ input) {
    requireLive(this);
    this.auth.require(this.user, 'company.manage');
    const old = this.hireSettingsRecord(),
      d = { ...EMPTY_SETTINGS, ...(old ?? {}) };
    if (input.stopRule !== undefined) {
      requireRule(
        STOP_RULES.includes(input.stopRule),
        'Choose when hire stops: the off-hire day, the day after, or at collection.',
      );
      d.stopRule = input.stopRule;
    }
    if (input.collectWithinDays !== undefined)
      d.collectWithinDays = integer(input.collectWithinDays, 'Collected within (days)', 1, 90);
    for (const [k, label, max] of [
      ['xeroAccountCode', 'Xero account code', 20],
      ['xeroTaxType', 'Xero tax rate name', 60],
      ['myobAccountNumber', 'MYOB account number', 20],
      ['myobTaxCode', 'MYOB tax code', 10],
    ])
      if (input[k] !== undefined) d[k] = optText(input[k], /** @type {string} */ (label), /** @type {number} */ (max));
    if (input.retentionYears !== undefined)
      d.retentionYears = integer(input.retentionYears, 'Keep records (years)', 5, 99);
    const data = { ...d, updatedAt: iso(this.planNow()), updatedBy: this.user.id };
    if (old) this.repo.save({ ...old, ...data });
    else this.repo.add('hireSettings', data);
    this.auth.audit(this.user, 'hire.settings', { stopRule: d.stopRule, collectWithinDays: d.collectWithinDays });
    return { settings: this.hireSettingsView(), message: 'Hire settings saved.' };
  },
  // ---------- customers ----------
  customerRows() {
    return this.repo.all('customer');
  },
  /** @param {string} id */
  customerGet(id, { removed = false } = {}) {
    const c = this.repo.get(id, 'customer');
    requireRule(
      removed || c.status !== 'REMOVED',
      c.name + ' was removed' + (c.removedReason ? ': ' + c.removedReason : '.'),
    );
    return c;
  },
  /** @param {string|null} id */
  customerName(id) {
    if (!id) return null;
    try {
      return this.repo.get(id, 'customer').name;
    } catch {
      return null;
    }
  },
  customerView(/** @type {any} */ c) {
    return {
      id: c.id,
      name: c.name,
      abn: c.abn ?? '',
      abnText: c.abn ? bdAbnFormat(c.abn) : '',
      billingEmail: c.billingEmail ?? null,
      address: c.address ?? null,
      termsDays: c.termsDays ?? null,
      defaultPO: c.defaultPO ?? null,
      status: c.status,
      removedAt: c.removedAt ?? null,
      removedOn: c.removedAt ? this.planDayOfIso(c.removedAt) : null,
      removedReason: c.removedReason ?? null,
      createdAt: c.createdAt,
    };
  },
  customerFields(/** @type {any} */ input, /** @type {any} */ old = null) {
    const name = input.name === undefined && old ? old.name : text(input.name, 'Customer name', 120);
    let abn = input.abn === undefined && old ? (old.abn ?? '') : String(input.abn ?? '').replace(/[\s.-]+/g, '');
    requireRule(!abn || /^\d{11}$/.test(abn), 'An ABN has 11 digits, for example 12 345 678 901.');
    requireRule(
      !abn || bdAbnValid(abn),
      'That ABN is not valid: check the digits against the customer’s ABN record (the check digits do not match).',
    );
    const billingEmail =
      input.billingEmail === undefined && old
        ? (old.billingEmail ?? null)
        : (optText(input.billingEmail, 'Billing email', 254)?.toLowerCase() ?? null);
    requireRule(
      !billingEmail || /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(billingEmail),
      'Enter a valid billing email.',
    );
    const address = input.address === undefined && old ? (old.address ?? null) : optText(input.address, 'Address', 250),
      termsDays =
        input.termsDays === undefined && old
          ? (old.termsDays ?? null)
          : input.termsDays === null || input.termsDays === undefined || input.termsDays === ''
            ? null
            : integer(input.termsDays, 'Payment terms (days)', 0, 120),
      defaultPO = input.defaultPO === undefined && old ? (old.defaultPO ?? null) : optText(input.defaultPO, 'PO', 60);
    return { name, abn, billingEmail, address, termsDays, defaultPO };
  },
  // Make or change a customer. Names are unique in the company (case and spacing ignored).
  customerSave(/** @type {any} */ input) {
    requireLive(this);
    const old = input?.id ? this.customerGet(input.id) : null,
      f = this.customerFields(input ?? {}, old);
    const clash = this.customerRows().find(
      (/** @type {any} */ c) => c.status !== 'REMOVED' && c.id !== old?.id && nameKey(c.name) === nameKey(f.name),
    );
    requireRule(!clash, 'There is already a customer called ' + clash?.name + '.');
    const now = iso(this.planNow());
    const saved = old
      ? this.repo.save({ ...old, ...f, updatedAt: now, updatedBy: this.user.id })
      : this.repo.add('customer', { ...f, status: 'ACTIVE', createdAt: now, createdBy: this.user.id });
    this.auth.audit(this.user, old ? 'customer.updated' : 'customer.created', { customerId: saved.id });
    return { customer: this.customerView(saved), message: f.name + (old ? ' updated.' : ' added.') };
  },
  // Soft: kept with a reason; refused while an open site still links to it.
  customerRemove(/** @type {any} */ input) {
    requireLive(this);
    const c = this.customerGet(input?.id),
      reason = text(input?.reason, 'Why (a few words)', 200);
    const open = this.repo.all('site').find((/** @type {any} */ s) => s.customer === c.id && s.status === 'ACTIVE');
    requireRule(!open, open?.name + ' still links to ' + c.name + '. Move that site to another customer first.');
    // money still owing stays billable: a customer is removed only once its last statement is out (ADR 0011 review)
    const owed = this.unbilledCore().customers.find((/** @type {any} */ x) => x.customer === c.id);
    requireRule(
      !owed || (!owed.amount && !owed.adjustments),
      c.name + ' has ' + hireDollars(owed?.amount ?? 0) + ' unbilled: issue the last statement first.',
    );
    this.repo.save({
      ...c,
      status: 'REMOVED',
      removedAt: iso(this.planNow()),
      removedBy: this.user.id,
      removedReason: reason,
    });
    this.auth.audit(this.user, 'customer.removed', { customerId: c.id, reason });
    return { ok: true, message: c.name + ' removed (kept in the records): ' + reason };
  },
  customerRestore(/** @type {any} */ input) {
    requireLive(this);
    const c = this.customerGet(input?.id, { removed: true });
    requireRule(c.status === 'REMOVED', c.name + ' is not removed.');
    const clash = this.customerRows().find(
      (/** @type {any} */ x) => x.status !== 'REMOVED' && x.id !== c.id && nameKey(x.name) === nameKey(c.name),
    );
    requireRule(!clash, 'There is already a customer called ' + clash?.name + '.');
    this.repo.save({ ...c, status: 'ACTIVE', removedAt: null, removedBy: null, removedReason: null });
    return { ok: true, customer: this.customerView(this.repo.get(c.id, 'customer')), message: c.name + ' is back.' };
  },
  // The customer and PO fields of a site (logistics.js site / siteDetails, game.js gameSite): a real yard only.
  /** @param {any} input @param {any} [site] */
  siteCustomerFields(input, site = null) {
    if (!this.live()) return {};
    /** @type {{customer?:string|null,po?:string|null}} */
    const out = {};
    if (input.customer !== undefined) {
      if (input.customer === null || input.customer === '') out.customer = null;
      else {
        requireRule(typeof input.customer === 'string', 'Choose a customer.');
        out.customer = this.customerGet(input.customer).id;
      }
      if (site && (site.customer ?? null) !== (out.customer ?? null)) {
        this.siteCustomerGuard(site, out.customer ?? null);
        out.customerFrom = 'picked';
      }
    }
    if (input.po !== undefined) out.po = optText(input.po, 'PO', 60);
    return out;
  },
  // A site moves to another customer (or to none) only when nothing of its hire is waiting for the old customer's statement: hire
  // before today after billedUpTo, or a charge line not yet billed (ADR 0011 review: the old customer's period must never land on the
  // new customer's statement). Today's hire goes with the site to the new customer. A billed site never goes back to "no customer".
  /** @param {any} site @param {string|null} next */
  siteCustomerGuard(site, next) {
    const old = site.customer ? this.customerName(site.customer) : null;
    if (!site.customer) return;
    requireRule(
      next || !site.billedUpTo,
      site.name + ' has an issued statement: its customer stays. Choose another customer instead.',
    );
    const today = this.planNowCal().today,
      yesterday = addDays(today, -1),
      charges = this.chargeLines(site.id).filter(
        (/** @type {any} */ c) =>
          !this.billedItems('CHARGE').has(c.id) && (c.customer ?? site.customer) === site.customer,
      );
    const first = this.hireFull({}).sites.find((/** @type {any} */ r) => r.id === site.id)?.first ?? null,
      from = site.billedUpTo ? addDays(site.billedUpTo, 1) : first;
    let pieceDays = 0;
    if (from && from <= yesterday)
      pieceDays = this.hireFull({ site: site.id, from, to: yesterday }).statement.pieceDays;
    requireRule(
      !pieceDays && !charges.length,
      site.name +
        ' has ' +
        (pieceDays ? 'hire since ' + dayLabel(/** @type {string} */ (from)) : plural(charges.length, 'charge line')) +
        ' not yet on a statement for ' +
        old +
        '. Issue a statement to ' +
        old +
        ' up to ' +
        dayLabel(yesterday) +
        " first; today's hire then goes with the site.",
    );
  },
  // The one-time link of the free-text client fields (this company only, never guessed across companies): a site whose client text
  // equals a customer's name links to it; otherwise a customer of exactly that name is made. Reversible: customerUnlinkSite.
  customerLinkSites() {
    requireLive(this);
    const byKey = new Map(
      this.customerRows()
        .filter((/** @type {any} */ c) => c.status !== 'REMOVED')
        .map((/** @type {any} */ c) => [nameKey(c.name), c]),
    );
    const linked = [],
      created = [],
      now = iso(this.planNow());
    for (const s of this.repo.all('site')) {
      if (s.customer || !s.client || !nameKey(s.client)) continue;
      let c = byKey.get(nameKey(s.client));
      if (!c) {
        // through the same checks as a typed customer (the name to 120 characters); the billing email is the owner's to fill: a site
        // contact is not accounts payable (ADR 0011 review)
        const f = this.customerFields({ name: s.client.trim().replace(/\s+/g, ' ').slice(0, 120), abn: '' });
        c = this.repo.add('customer', {
          ...f,
          status: 'ACTIVE',
          createdAt: now,
          createdBy: this.user.id,
          from: 'client:' + s.id,
        });
        byKey.set(nameKey(c.name), c);
        created.push({ id: c.id, name: c.name });
      }
      this.repo.save({ ...s, customer: c.id, customerFrom: 'client' });
      linked.push({ site: s.id, name: s.name, customer: c.id, customerName: c.name });
    }
    this.auth.audit(this.user, 'customer.linked', { linked: linked.length, created: created.length });
    return {
      linked,
      created,
      message: linked.length
        ? plural(linked.length, 'site') +
          ' linked' +
          (created.length ? ', ' + plural(created.length, 'customer') + ' made' : '') +
          '.'
        : 'Nothing to link: every site with a client name already has a customer.',
    };
  },
  customerUnlinkSite(/** @type {any} */ input) {
    requireLive(this);
    const s = this.repo.get(input?.site, 'site');
    requireRule(s.customer, s.name + ' has no customer.');
    requireRule(!s.billedUpTo, s.name + ' has an issued statement: its customer stays.');
    this.repo.save({ ...s, customer: null, customerFrom: null });
    return { ok: true, message: s.name + ' no longer links to a customer (the client name stays).' };
  },
  // GET /api/customers: every customer with its sites and (finance) its unbilled exposure; sites with a client name but no customer.
  customersView() {
    const p = this.auth.permissions(this.user);
    requireRule(
      p.includes('customers.manage') || p.includes('operations.manage') || p.includes('finance.view'),
      'Your role does not allow this.',
    );
    if (!this.live()) return { live: false, customers: [], removed: [], unlinkedSites: [] };
    const finance = p.includes('finance.view'),
      unbilled = finance ? this.unbilledView() : null,
      sites = this.repo.all('site');
    const view = (/** @type {any} */ c) => {
      const mine = sites.filter((s) => s.customer === c.id),
        u = unbilled?.customers.find((/** @type {any} */ x) => x.customer === c.id) ?? null;
      return {
        ...this.customerView(c),
        sites: mine.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          po: s.po ?? null,
          billedUpTo: s.billedUpTo ?? null,
          lastStatement: s.lastStatement ?? null,
        })),
        exposure: finance ? { amount: u?.amount ?? 0, since: u?.since ?? null, days: u?.days ?? 0 } : null,
        lastStatement: finance ? this.statementLast(c.id) : null,
      };
    };
    const all = this.customerRows().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return {
      live: true,
      customers: all.filter((c) => c.status !== 'REMOVED').map(view),
      removed: all.filter((c) => c.status === 'REMOVED').map(view),
      unlinkedSites: sites
        .filter((s) => !s.customer && s.client && nameKey(s.client))
        .map((s) => ({ id: s.id, name: s.name, client: s.client, status: s.status })),
    };
  },
  // ---------- off-hire ----------
  // The builder called it off: record who and when, give it a pickup number and make one bring-back order for everything on the site's
  // record, for the pickup day (the off-hire day, or today when that has passed). The hire-stop rule reads the notice (hireNotices).
  offHireRequested(/** @type {any} */ input) {
    requireLive(this);
    const site = this.repo.get(input?.site, 'site'),
      cal = this.planNowCal(),
      today = cal.today;
    requireRule(site.status === 'ACTIVE', site.name + ' is not an open site.');
    const when = dayArg(input?.when ?? today, 'Off-hire day');
    requireRule(when <= today, 'The off-hire day cannot be ahead: it is the day the builder called.');
    requireRule(when >= addDays(today, -366), 'The off-hire day is more than a year back. Check the date.');
    const who = text(input?.whoCalled, 'Who called', 120),
      note = optText(input?.note, 'Note', 300);
    // the pickup day may already have passed (paperwork caught up on Monday for a call last week): the pickup is then overdue on
    // Needs you; the bring-back itself is booked for today at the earliest (ADR 0011 review)
    const pickupDay = input?.pickupDay ? dayArg(input.pickupDay, 'Pickup day') : when < today ? today : when;
    requireRule(pickupDay >= when, 'The pickup day is before the off-hire day. Check the dates.');
    const open = this.repo
      .all('offHire')
      .find((/** @type {any} */ o) => o.site === site.id && this.offHireStatus(o).status === 'WAITING');
    requireRule(!open, site.name + ' already has pickup ' + open?.label + ' waiting. Book or cancel that one first.');
    /** @type {Map<string,number>} */
    const on = new Map();
    for (const c of this.containers())
      if (c.location === site.id)
        for (const l of this.repo.lines(c.id)) on.set(l.product_id, (on.get(l.product_id) ?? 0) + l.quantity);
    requireRule(on.size, 'Nothing is on record at ' + site.name + ', so there is nothing to bring back.');
    // a bring-back already open for this site holds some of it, and so does a move planned from it (ADR 0012: the builder's gear going on
    // to their next job): the pickup asks only for the rest, or is that bring-back itself
    const openOrders = this.repo
      .all('order')
      .filter(
        (/** @type {any} */ o) =>
          ['OPEN', 'BOOKED'].includes(o.status) &&
          ((o.site === site.id && o.direction === 'BACK') || (o.fromSite === site.id && o.direction === 'MOVE')),
      );
    const backs = openOrders.filter((/** @type {any} */ o) => o.direction === 'BACK');
    /** @type {Map<string,number>} */
    const held = new Map();
    for (const o of openOrders)
      for (const l of o.lines ?? [])
        held.set(l.product, (held.get(l.product) ?? 0) + Math.max(0, (l.requested ?? 0) - (l.collected ?? 0)));
    const lines = [...on]
      .map(([product, quantity]) => ({ product, quantity: quantity - (held.get(product) ?? 0) }))
      .filter((l) => l.quantity > 0);
    requireRule(
      lines.length || backs.length,
      'Everything on record at ' +
        site.name +
        ' is on a move already (' +
        openOrders.map((/** @type {any} */ o) => this.orderLabel(o)).join(', ') +
        '). Record the off-hire once it has gone.',
    );
    const number =
        cached(this.db, "SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='offHire'").get(this.repo.company)
          .n + 1,
      label = 'P-' + number,
      heldWords = openOrders.length
        ? [...new Set(openOrders.map((/** @type {any} */ o) => this.orderLabel(o)))].join(', ')
        : '';
    const made = lines.length
      ? this.orderMake(
          'BACK',
          {
            site: site.id,
            lines,
            neededOn: pickupDay < today ? today : pickupDay,
            note: 'Off-hire ' + label + ' · called by ' + who + (note ? ' · ' + note : ''),
          },
          { source: 'office' },
        )
      : null;
    const order = made
      ? made.order
      : this.orderView(this.repo.get(backs.sort((a, b) => a.number - b.number)[0].id, 'order'));
    const o = this.repo.add('offHire', {
      number,
      label,
      site: site.id,
      when,
      whoCalled: who,
      note,
      pickupDay,
      order: order.id,
      orderLabel: order.label,
      pieces: [...on.values()].reduce((s, q) => s + q, 0),
      requestedAt: iso(this.planNow()),
      requestedBy: this.user.id,
    });
    this.repo.event(this.user.id, 'OFF_HIRE', {
      destination: site.id,
      reason: 'Off-hire ' + label + ' at ' + site.name + ': called ' + dayLabel(when) + ' by ' + who,
      key: this.key,
    });
    const view = this.offHireView(o);
    return {
      offHire: view,
      order,
      message:
        'Off-hire ' +
        label +
        ' for ' +
        site.name +
        ': called ' +
        dayLabel(when) +
        ' by ' +
        who +
        '. ' +
        (made
          ? 'Pickup ' +
            order.label +
            ' for ' +
            dayLabel(pickupDay) +
            (heldWords ? ' (' + heldWords + ' already holds the rest)' : '') +
            (pickupDay < today ? ' — already overdue' : '')
          : 'Pickup ' + order.label + ' already holds everything on record: it is the pickup') +
        '. ' +
        this.hireSettingsView().ruleSentence,
    };
  },
  /** @param {any} o */
  offHireStatus(o) {
    let order = null;
    try {
      order = this.repo.get(o.order, 'order');
    } catch {}
    const st = order?.status ?? 'CANCELLED';
    let collectedOn = null;
    if (order?.trip)
      try {
        const t = this.repo.get(order.trip, 'trip');
        collectedOn = t.steps?.COLLECTED?.at ? this.planDayOfIso(t.steps.COLLECTED.at) : null;
      } catch {}
    const status =
      st === 'CANCELLED'
        ? 'CANCELLED'
        : ['COLLECTED', 'RETURNED', 'NOT_DELIVERED'].includes(st) || collectedOn
          ? 'COLLECTED'
          : 'WAITING';
    return { status, orderStatus: st, collectedOn };
  },
  /** @param {any} o */
  offHireView(o) {
    const s = this.offHireStatus(o),
      today = this.planNowCal().today;
    return {
      id: o.id,
      label: o.label,
      site: o.site,
      siteName: this.planSiteName(o.site),
      when: o.when,
      whoCalled: o.whoCalled,
      note: o.note ?? null,
      pickupDay: o.pickupDay,
      order: o.order,
      orderLabel: o.orderLabel,
      pieces: o.pieces,
      requestedAt: o.requestedAt,
      ...s,
      overdue: s.status === 'WAITING' && o.pickupDay < today,
    };
  },
  offHiresView() {
    this.auth.require(this.user, 'operations.manage');
    return {
      offHires: this.repo
        .all('offHire')
        .map((o) => this.offHireView(o))
        .reverse(),
    };
  },
  // Per site, the notices the hire book reads (a cancelled pickup is no notice).
  /** @returns {Map<string,{pickup:string,when:string,who:string}[]>} */
  hireNotices() {
    const m = new Map();
    for (const o of this.repo.all('offHire')) {
      if (this.offHireStatus(o).status === 'CANCELLED') continue;
      let l = m.get(o.site);
      if (!l) m.set(o.site, (l = []));
      l.push({ pickup: o.label, when: o.when, who: o.whoCalled });
    }
    return m;
  },
  // ---------- statements ----------
  stRequire() {
    if (!this.auth.permissions(this.user).includes('finance.view'))
      throw new AppError(403, 'Statements are for the owner and accounts.');
  },
  statementRows() {
    return this.repo.all('statement');
  },
  /** @param {string} customerId */
  statementLast(customerId) {
    const s = this.statementRows()
      .filter((x) => x.customer === customerId)
      .at(-1);
    return s ? { id: s.id, number: s.number, to: s.to, total: s.total, issuedOn: s.issuedOn } : null;
  },
  billedItems(/** @type {'CHARGE'|'ADJUSTMENT'} */ kind) {
    return new Set(
      cached(this.db, 'SELECT item_id FROM statement_items WHERE company_id=? AND item_kind=?')
        .all(this.repo.company, kind)
        .map((/** @type {any} */ r) => r.item_id),
    );
  },
  // Everything a statement for this customer up to `to` would carry, priced exactly as the Hire page's preview: per site from the day
  // after billedUpTo (or its first hire day) to `to`, the charge lines stamped with this customer (older lines resolve through the site),
  // the customer's open adjustments. `to` is yesterday unless given: a statement to today would count every open lot for the whole of
  // today, and a collection later in the day leaves it over-billed (ADR 0011 review). Nothing here writes.
  /** @param {string} customerId @param {string|null} toArg @param {{preview?:boolean,withAdjustments?:boolean}} [o] */
  statementBuild(customerId, toArg, { preview = false, withAdjustments = true } = {}) {
    const cal = this.planNowCal(),
      today = cal.today,
      cust = this.customerGet(customerId, { removed: preview }),
      to = toArg ? dayArg(toArg, 'To') : addDays(today, -1);
    requireRule(to <= today, 'A statement runs up to today at the latest.');
    const overview = this.hireFull({}),
      rowOf = new Map(overview.sites.map((/** @type {any} */ r) => [r.id, r])),
      billedCharges = this.billedItems('CHARGE'),
      billedAdj = this.billedItems('ADJUSTMENT'),
      mine = this.repo.all('site').filter((s) => s.customer === cust.id),
      siteIds = new Set(mine.map((s) => s.id)),
      /** @type {Map<string,any>} */
      groups = new Map(),
      unpriced = new Set(),
      already = [],
      openPickups = [],
      openLots = [];
    // a charge line goes to the customer it was stamped with when it was made; an older line (no customer) to the site's customer now
    const charges = this.chargeLines().filter(
      (/** @type {any} */ c) =>
        !billedCharges.has(c.id) &&
        this.planDayOfIso(c.occurredAt) <= to &&
        (c.customer ? c.customer === cust.id : siteIds.has(c.site)),
    );
    const group = (/** @type {any} */ site) => {
      let g = groups.get(site.id);
      if (!g)
        groups.set(
          site.id,
          (g = {
            site: site.id,
            name: site.name,
            address: site.address ?? null,
            po: site.po ?? cust.defaultPO ?? null,
            from: to,
            to,
            prevBilledUpTo: site.billedUpTo ?? null,
            lines: [],
            charges: [],
            subtotal: 0,
            onHireAtEnd: 0,
          }),
        );
      return g;
    };
    for (const site of mine) {
      const row = rowOf.get(site.id),
        from = site.billedUpTo ? addDays(site.billedUpTo, 1) : (row?.first ?? null);
      if (site.billedUpTo && site.billedUpTo >= to) already.push(site);
      if (row?.pieces && to >= today) openLots.push({ site: site.id, name: site.name, pieces: row.pieces });
      if (!from || from > to) continue;
      const st = this.hireFull({ site: site.id, from, to }).statement;
      if (!st.lines.length) continue;
      const g = group(site);
      g.from = from;
      g.onHireAtEnd = st.endPieces ?? 0;
      for (const l of st.lines) {
        if (!l.rate.priced && !l.zero) unpriced.add(l.product.name);
        for (const o of l.offHire ?? [])
          if (o.provisional && to >= o.stoppedOn && !openPickups.some((x) => x.pickup === o.pickup))
            openPickups.push({
              pickup: o.pickup,
              site: site.id,
              name: site.name,
              when: o.when,
              who: o.who,
              stoppedOn: o.stoppedOn,
            });
        g.lines.push({
          product: {
            id: l.product.id,
            name: l.product.name,
            reference: l.product.reference,
            system: l.product.system,
          },
          rateFrom: l.rateFrom,
          rateTo: l.rateTo,
          split: l.split,
          start: l.start,
          end: l.end,
          peak: l.peak,
          pieceDays: l.pieceDays,
          moved: l.moved ?? null,
          zero: !!l.zero,
          rate: {
            week: l.rate.week,
            day: l.rate.day,
            minDays: l.rate.minDays,
            source: l.rate.source,
            minSource: l.rate.minSource,
            priced: l.rate.priced,
            rule: l.rate.rule,
          },
          amount: l.amount,
          topUp: l.topUp
            ? {
                pieceDays: l.topUp.pieceDays,
                amount: l.topUp.amount,
                minDays: l.topUp.minDays,
                parts: (l.topUp.parts ?? []).map((/** @type {any} */ p) => ({ q: p.q, held: p.held, days: p.days })),
              }
            : null,
          offHire: (l.offHire ?? []).map(({ words, pickup, when, who, stoppedOn, collectedOn, ran, provisional }) => ({
            words,
            pickup,
            when,
            who,
            stoppedOn,
            collectedOn,
            ran,
            provisional,
          })),
        });
      }
    }
    for (const c of charges) {
      let site = null;
      try {
        site = this.repo.get(c.site, 'site');
      } catch {
        continue;
      }
      group(site).charges.push({
        id: c.id,
        product: c.product,
        name: c.name,
        quantity: c.quantity,
        unitValue: c.unitValue,
        amount: c.amount,
        reason: c.reason,
        occurredOn: this.planDayOfIso(c.occurredAt),
        approvedBy: c.approvedBy ? this.userName(c.approvedBy) : null,
      });
    }
    const sites = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const g of sites)
      g.subtotal =
        g.lines.reduce((s, l) => s + (l.amount ?? 0) + (l.topUp?.amount ?? 0), 0) +
        g.charges.reduce((s, c) => s + c.amount, 0);
    const adjustments = withAdjustments
      ? this.repo
          .all('adjustment')
          .filter((a) => a.customer === cust.id && !billedAdj.has(a.id))
          .map((a) => ({
            id: a.id,
            number: a.number,
            site: a.site ?? null,
            siteName: a.site ? this.planSiteName(a.site) : null,
            statement: a.statement ?? null,
            amount: a.amount,
            description: a.description,
            reason: a.reason,
            approvedBy: a.approvedBy,
            madeOn: a.madeOn,
          }))
      : [];
    const heldAdjustments = withAdjustments
      ? 0
      : this.repo.all('adjustment').filter((a) => a.customer === cust.id && !billedAdj.has(a.id)).length;
    // GST line by line (each line's GST rounded to the cent on its own), so the statement, the MYOB file and the invoice Xero raises
    // from the file agree to the cent (ADR 0011 review)
    let subtotal = 0,
      gst = 0,
      positive = false,
      negative = false;
    const count = (/** @type {number|null} */ c) => {
      if (c == null) return;
      subtotal += c;
      gst += lineGst(c);
      if (c > 0) positive = true;
      if (c < 0) negative = true;
    };
    for (const g of sites) {
      for (const l of g.lines) {
        count(l.amount);
        count(l.topUp?.amount ?? null);
      }
      for (const c of g.charges) count(c.amount);
    }
    for (const a of adjustments) count(a.amount);
    const settings = this.hireSettingsView(),
      brand = this.bdView(),
      // a credit larger than the hire: Xero and MYOB take a negative total as a credit note, which holds only credits
      mixed = subtotal < 0 && positive && negative;
    return {
      customer: {
        id: cust.id,
        name: cust.name,
        abn: cust.abn ?? '',
        abnText: cust.abn ? bdAbnFormat(cust.abn) : '',
        billingEmail: cust.billingEmail ?? null,
        address: cust.address ?? null,
        termsDays: cust.termsDays ?? null,
        po: cust.defaultPO ?? null,
      },
      company: {
        name: brand.name,
        abn: brand.abn,
        abnText: brand.abnText,
        address: brand.address,
        phone: brand.phone,
        email: brand.email,
      },
      from: sites.length ? sites.map((s) => s.from).sort()[0] : to,
      to,
      today,
      dueOn: cust.termsDays != null ? addDays(today, cust.termsDays) : null, // the issue day plus the customer's terms
      hireStopRule: settings.ruleSentence,
      stopRule: settings.stopRule,
      collectWithinDays: settings.collectWithinDays,
      sites,
      adjustments,
      subtotal,
      gst,
      gstPercent: GST_PERCENT,
      total: subtotal + gst,
      footer: FOOTER,
      unpriced: [...unpriced],
      alreadyBilled: already.map((s) => ({
        site: s.id,
        name: s.name,
        billedUpTo: s.billedUpTo,
        statement: s.lastStatement,
      })),
      // why Issue would be refused, in the preview's words (ADR 0011 review): a pickup still waiting inside the period, gear still
      // out on a statement to today, a credit larger than the hire
      openPickups,
      suggestedTo: openPickups.length ? addDays(openPickups.map((p) => p.when).sort()[0], -1) : null,
      openLots,
      mixed,
      withAdjustments,
      heldAdjustments,
      // nothing priced (only same-day returns), no charge, no adjustment: nothing to issue
      empty: !sites.some((g) => g.lines.some((l) => !l.zero) || g.charges.length) && !adjustments.length,
    };
  },
  /** @param {string} id */
  userName(id) {
    return cached(this.db, 'SELECT name FROM users WHERE id=?').get(id)?.name ?? 'the office';
  },
  // Why a build cannot be issued, in one sentence (null when it can): the preview shows it, Issue refuses with it.
  /** @param {any} b @returns {{code:string,words:string}|null} */
  statementBlock(b) {
    const day = (/** @type {string} */ d) => dayLabel(d);
    if (b.empty)
      return {
        code: b.alreadyBilled.length ? 'ALREADY_ISSUED' : 'NOTHING_TO_BILL',
        words: b.alreadyBilled.length
          ? b.alreadyBilled[0].name +
            ' is billed up to ' +
            day(b.alreadyBilled[0].billedUpTo) +
            ' on ' +
            b.alreadyBilled[0].statement +
            '. Nothing new to bill for ' +
            b.customer.name +
            ' up to ' +
            day(b.to) +
            '.'
          : 'Nothing to bill for ' + b.customer.name + ' up to ' + day(b.to) + '.',
      };
    if (b.unpriced.length)
      return {
        code: 'UNPRICED',
        words:
          'No rate yet for ' + b.unpriced.join(', ') + '. Set the rate first: a statement never goes out incomplete.',
      };
    if (b.openPickups.length) {
      const p = b.openPickups[0];
      return {
        code: 'PICKUP_OPEN',
        words:
          'Pickup ' +
          p.pickup +
          ' at ' +
          p.name +
          ' is not collected yet: hire from ' +
          day(p.stoppedOn) +
          ' is not settled (the rule stops it only if the gear is collected within ' +
          b.collectWithinDays +
          ' days). Issue after the collection, or up to ' +
          day(/** @type {string} */ (b.suggestedTo)) +
          ', the day before the call.',
      };
    }
    if (b.openLots.length)
      return {
        code: 'TO_TODAY',
        words:
          b.openLots.map((/** @type {any} */ s) => s.name).join(', ') +
          ' still ' +
          (b.openLots.length === 1 ? 'has' : 'have') +
          ' gear on hire: a statement runs up to yesterday (' +
          day(addDays(b.today, -1)) +
          ") while gear is out, so today's collections are not billed for a day they were not there.",
      };
    if (b.mixed)
      return {
        code: 'MIXED_CREDIT',
        words:
          'The credit is larger than the hire (' +
          hireDollars(b.subtotal) +
          ' ex GST): Xero and MYOB take a negative total as a credit note, which must hold only credits. Issue the hire without the adjustments, then the credit on its own statement.',
      };
    return null;
  },
  // GET /api/statement-preview?customer=&to=&adjustments=0 : what Issue would lock, without writing.
  statementPreview(/** @type {any} */ query = {}) {
    requireLive(this);
    this.stRequire();
    requireRule(query.customer, 'Choose a customer.');
    const b = this.statementBuild(query.customer, query.to || null, {
      preview: true,
      withAdjustments: !['0', 'false', 'no'].includes(String(query.adjustments ?? '1')),
    });
    const block = this.statementBlock(b);
    return {
      ...b,
      number: 'PREVIEW',
      canIssue: !block,
      why: block?.words ?? null,
      whyCode: block?.code ?? null,
    };
  },
  // Issue: the preview becomes the locked document under the next number; each site's billedUpTo moves to `to`.
  statementIssue(/** @type {any} */ input) {
    requireLive(this);
    requireRule(input?.customer, 'Choose a customer.');
    const b = this.statementBuild(input.customer, input.to ?? null, {
      withAdjustments: input.withAdjustments !== false,
    });
    const block = this.statementBlock(b);
    if (block) {
      const e = new AppError(409, block.words);
      e.code = block.code;
      e.detail = {
        alreadyBilled: b.alreadyBilled,
        unpriced: b.unpriced,
        openPickups: b.openPickups,
        suggestedTo: b.suggestedTo,
        openLots: b.openLots,
      };
      throw e;
    }
    return this.statementWrite(b, { reverses: null, reason: null });
  },
  // Writes one statement from a build (an issue, or a reversal of an issued one) and moves the sites on.
  /** @param {any} b @param {{reverses:any,reason:string|null}} opts */
  statementWrite(b, { reverses, reason }) {
    const n =
        cached(this.db, "SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='statement'").get(this.repo.company)
          .n + 1,
      now = this.planNow(),
      parts = this.planParts(now),
      { unpriced, alreadyBilled, empty, today, openPickups, suggestedTo, openLots, mixed, heldAdjustments, ...body } =
        b;
    const snapshot = {
      ...body,
      number: 'ST-' + pad6(n),
      seq: n,
      issuedAt: iso(now),
      issuedOn: parts.day,
      issuedHm: parts.hm, // the issue time in company time, printed on the document (ADR 0011 review)
      zone: this.clockZone?.() ?? null,
      issuedBy: { id: this.user.id, name: this.user.name ?? 'the office' },
      reverses,
      reason,
    };
    snapshot.hash = sha(JSON.stringify(snapshot));
    snapshot.text = statementText(snapshot);
    snapshot.textHash = sha(snapshot.text);
    const saved = this.repo.add('statement', snapshot);
    for (const s of b.sites) {
      if (!reverses)
        for (const c of s.charges)
          cached(this.db, 'INSERT INTO statement_items VALUES(?,?,?,?)').run(
            this.repo.company,
            saved.id,
            'CHARGE',
            c.id,
          );
      if (!s.lines.length) continue; // charge lines only: the site's hire is not on this statement, billedUpTo stays
      const site = this.repo.get(s.site, 'site');
      this.repo.save({
        ...site,
        billedUpTo: reverses ? s.rollBackTo : s.to,
        lastStatement: reverses ? s.rollBackStatement : snapshot.number,
      });
    }
    if (!reverses)
      for (const a of b.adjustments)
        cached(this.db, 'INSERT INTO statement_items VALUES(?,?,?,?)').run(
          this.repo.company,
          saved.id,
          'ADJUSTMENT',
          a.id,
        );
    this.repo.event(this.user.id, 'STATEMENT_ISSUED', {
      reason:
        snapshot.number +
        (reverses ? ' reverses ' + reverses.number : ' issued') +
        ' for ' +
        b.customer.name +
        ': ' +
        hireDollars(snapshot.total) +
        ' inc GST',
      key: this.key,
    });
    this.auth.audit(this.user, reverses ? 'statement.reversed' : 'statement.issued', {
      statementId: saved.id,
      number: snapshot.number,
      total: snapshot.total,
    });
    return {
      statement: this.statementView(saved),
      message:
        snapshot.number +
        (reverses ? ' reverses ' + reverses.number : ' issued') +
        ': ' +
        hireDollars(snapshot.total) +
        ' inc GST for ' +
        b.customer.name +
        '.',
    };
  },
  // The stored snapshot, exactly (plus who reversed it, and its exports).
  /** @param {any} s */
  statementView(s) {
    const { text, kind, version, ...rest } = s;
    const by = this.statementRows().find((x) => x.reverses?.id === s.id);
    return {
      ...rest,
      reversedBy: by ? { id: by.id, number: by.number } : null,
      exports: cached(
        this.db,
        'SELECT format,month,exported_at FROM statement_exports WHERE company_id=? AND statement_id=?',
      )
        .all(this.repo.company, s.id)
        .map((/** @type {any} */ r) => ({
          format: r.format,
          month: r.month,
          at: r.exported_at,
          on: this.planDayOfIso(r.exported_at), // the company's day, for 'in the Xero file for October (downloaded Thu 1 Oct)'
          words: FORMAT_WORDS[/** @type {keyof typeof FORMAT_WORDS} */ (r.format)] ?? r.format,
        })),
    };
  },
  // GET /api/statement?id=
  statementGet(/** @type {string} */ id) {
    requireLive(this);
    this.stRequire();
    return this.statementView(this.repo.get(id, 'statement'));
  },
  // GET /api/statement.txt?id= : the reprint, the stored bytes.
  statementReprint(/** @type {string} */ id) {
    requireLive(this);
    this.stRequire();
    const s = this.repo.get(id, 'statement');
    return { text: s.text, name: s.number + '.txt', number: s.number };
  },
  // GET /api/statements?customer=&month=
  statementsView(/** @type {any} */ query = {}) {
    requireLive(this);
    this.stRequire();
    const drift = new Map(this.statementDrift().map((d) => [d.statement, d]));
    const list = this.statementRows()
      .filter(
        (s) =>
          (!query.customer || s.customer.id === query.customer) && (!query.month || s.issuedOn.startsWith(query.month)),
      )
      .map((s) => {
        const v = this.statementView(s);
        return {
          id: s.id,
          number: s.number,
          customer: s.customer.id,
          customerName: s.customer.name,
          from: s.from,
          to: s.to,
          issuedOn: s.issuedOn,
          issuedBy: s.issuedBy.name,
          sites: s.sites.map((/** @type {any} */ x) => x.name),
          subtotal: s.subtotal,
          gst: s.gst,
          total: s.total,
          reverses: s.reverses,
          reason: s.reason ?? null, // why it was reversed, on the reversing statement
          reversedBy: v.reversedBy,
          exports: v.exports,
          drift: drift.get(s.id) ?? null, // the billed period reads differently now: the adjustment that would square it
        };
      })
      .reverse();
    return { statements: list, settings: this.hireSettingsView() };
  },
  // A billed period read again today: a collection later on the issue day, an off-hire window that closed uncollected, a notice
  // recorded late — the ledger is never altered, the issued statement never re-priced, so the difference is offered as an adjustment
  // (Needs you, the issued list). Per standing statement: the hire now for each site's period, less what was billed and what has
  // already been adjusted against it. Nothing here writes.
  statementDrift() {
    const rows = this.statementRows(),
      reversed = new Set(rows.map((x) => x.reverses?.id).filter(Boolean)),
      adjustments = this.repo.all('adjustment'),
      out = [];
    for (const st of rows) {
      if (st.reverses || reversed.has(st.id)) continue;
      let billed = 0,
        now = 0,
        read = false;
      for (const s of st.sites) {
        if (!s.lines.length) continue;
        billed += s.lines.reduce(
          (/** @type {number} */ a, /** @type {any} */ l) => a + (l.amount ?? 0) + (l.topUp?.amount ?? 0),
          0,
        );
        try {
          now += this.hireFull({ site: s.site, from: s.from, to: s.to }).statement.subtotal;
          read = true;
        } catch {
          read = false;
          break;
        }
      }
      if (!read) continue;
      const adjusted = adjustments
          .filter((a) => a.hire && a.statement?.id === st.id)
          .reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.amount, 0),
        delta = now - billed - adjusted;
      if (!delta) continue;
      out.push({
        statement: st.id,
        number: st.number,
        customer: st.customer.id,
        customerName: st.customer.name,
        from: st.from,
        to: st.to,
        billed,
        now,
        adjusted,
        delta,
        description: 'Hire ' + dayLabel(st.from) + ' – ' + dayLabel(st.to) + ' read again after ' + st.number,
        words:
          st.number +
          ' (' +
          st.customer.name +
          '): hire ' +
          dayLabel(st.from) +
          ' – ' +
          dayLabel(st.to) +
          ' now reads ' +
          hireDollars(now) +
          ' ex GST, billed ' +
          hireDollars(billed) +
          (adjusted ? ' with ' + hireDollars(adjusted) + ' already adjusted' : '') +
          ': an adjustment of ' +
          hireDollars(delta) +
          ' would square it.',
      });
    }
    return out;
  },
  // Void: the same lines negated under the next number; the sites' billedUpTo rolled back; the original's charges and adjustments
  // released to the next statement. Refused when a later statement already bills one of its sites.
  statementReverse(/** @type {any} */ input) {
    requireLive(this);
    const s = this.repo.get(input?.statement, 'statement'),
      reason = text(input?.reason, 'Why (a few words)', 200);
    requireRule(!s.reverses, s.number + ' is itself a reversal.');
    requireRule(!this.statementRows().some((x) => x.reverses?.id === s.id), s.number + ' was already reversed.');
    const neg = (/** @type {number|null} */ v) => (v == null ? v : -v);
    const sites = s.sites.map((/** @type {any} */ x) => {
      const site = this.repo.get(x.site, 'site');
      if (x.lines.length) {
        requireRule(
          site.lastStatement === s.number && site.billedUpTo === x.to,
          site.name + ' is billed past ' + s.number + ' (' + site.lastStatement + '). Reverse that statement first.',
        );
        // the period goes back to the customer it was billed to, never to whoever the site bills now (ADR 0011 review)
        requireRule(
          (site.customer ?? null) === s.customer.id,
          site.name +
            ' now bills to ' +
            (this.customerName(site.customer) ?? 'no customer') +
            ': ' +
            s.number +
            ' (' +
            s.customer.name +
            ') stays. Move the site back to ' +
            s.customer.name +
            ' first.',
        );
      }
      return {
        ...x,
        rollBackTo: x.prevBilledUpTo ?? null,
        rollBackStatement:
          this.statementRows().find(
            (y) => y.id !== s.id && y.sites.some((z) => z.site === x.site && z.to === x.prevBilledUpTo),
          )?.number ?? null,
        lines: x.lines.map((/** @type {any} */ l) => ({
          ...l,
          pieceDays: -l.pieceDays,
          amount: neg(l.amount),
          topUp: l.topUp ? { ...l.topUp, pieceDays: -l.topUp.pieceDays, amount: neg(l.topUp.amount) } : null,
        })),
        charges: x.charges.map((/** @type {any} */ c) => ({ ...c, amount: -c.amount })),
        subtotal: -x.subtotal,
      };
    });
    const b = {
      ...s,
      sites,
      adjustments: s.adjustments.map((/** @type {any} */ a) => ({ ...a, amount: -a.amount })),
      subtotal: -s.subtotal,
      gst: -s.gst,
      total: -s.total,
      hireStopRule: s.hireStopRule,
      unpriced: [],
      alreadyBilled: [],
      empty: false,
      today: this.planNowCal().today,
    };
    delete b.id;
    delete b.kind;
    delete b.version;
    delete b.number;
    delete b.seq;
    delete b.issuedAt;
    delete b.issuedOn;
    delete b.issuedBy;
    delete b.hash;
    delete b.text;
    delete b.textHash;
    delete b.reason;
    cached(this.db, 'DELETE FROM statement_items WHERE company_id=? AND statement_id=?').run(this.repo.company, s.id);
    return this.statementWrite(b, { reverses: { id: s.id, number: s.number }, reason });
  },
  // A change after issue: an amount ex GST (negative for a credit) with a description, a reason and the owner as approver, carried by
  // the customer's next statement.
  adjustmentAdd(/** @type {any} */ input) {
    requireLive(this);
    const cust = this.customerGet(input?.customer),
      amount = integer(input?.amount, 'Amount (cents ex GST)', -MAX_CENTS, MAX_CENTS);
    requireRule(amount !== 0, 'An adjustment needs an amount.');
    const description = text(input?.description, 'What it is for', 120),
      reason = text(input?.reason, 'Why (a few words)', 200);
    let statement = null;
    if (input?.statement) {
      const s = this.repo.get(input.statement, 'statement');
      requireRule(s.customer.id === cust.id, s.number + ' is not ' + cust.name + "'s statement.");
      statement = { id: s.id, number: s.number };
    }
    let site = null;
    if (input?.site) site = this.repo.get(input.site, 'site').id;
    // recorded to square a hire re-read of that statement (Needs you's "Billed differently"): only such adjustments offset the drift,
    // a goodwill credit against the same statement does not
    const hire = input?.hire === true;
    requireRule(!hire || statement, 'An adjustment that squares a hire re-read names the statement.');
    const n =
        cached(this.db, "SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='adjustment'").get(
          this.repo.company,
        ).n + 1,
      now = this.planNow();
    const a = this.repo.add('adjustment', {
      number: 'ADJ-' + pad6(n),
      customer: cust.id,
      site,
      statement,
      hire,
      amount,
      description,
      reason,
      approvedBy: { id: this.user.id, name: this.user.name ?? 'the owner' },
      madeAt: iso(now),
      madeOn: this.planDayOfIso(iso(now)),
    });
    this.repo.event(this.user.id, 'ADJUSTMENT', {
      reason: a.number + ' for ' + cust.name + ': ' + hireDollars(amount) + ' ex GST · ' + description + ' · ' + reason,
      key: this.key,
    });
    return {
      adjustment: { ...a },
      message:
        a.number +
        ' recorded: ' +
        hireDollars(amount) +
        ' ex GST goes on ' +
        cust.name +
        (/s$/i.test(cust.name) ? '’' : '’s') +
        ' next statement.',
    };
  },
  // ---------- the accounting file ----------
  // GET /api/accounting.csv?format=xero|myob|generic&month=YYYY-MM : one row per statement line for the month's statements.
  /** @param {any} [query] @param {{record?:boolean}} [o] record false: the summary the page shows before saving the file, nothing recorded */
  accountingFile(query = {}, { record = true } = {}) {
    requireLive(this);
    this.auth.require(this.user, 'statements.manage');
    const format = String(query.format ?? 'generic').toLowerCase(),
      month = String(query.month ?? '');
    requireRule(['xero', 'myob', 'generic'].includes(format), 'Choose Xero, MYOB or generic.');
    requireRule(MONTH.test(month), 'Choose a month (YYYY-MM).');
    const settings = this.hireSettingsView();
    if (format === 'xero')
      requireRule(
        settings.xeroReady,
        'Set the Xero sales account code in Hire settings first (the account your sales go to in Xero).',
      );
    if (format === 'myob')
      requireRule(
        settings.myobReady,
        'Set the MYOB income account number in Hire settings first (the account your sales go to in MYOB).',
      );
    const statements = this.statementRows().filter((s) => s.issuedOn.startsWith(month));
    requireRule(statements.length, 'No statements were issued in ' + month + '.');
    /** @type {unknown[][]} */
    const rows = [];
    let gstTotal = 0;
    for (const st of statements) {
      // GST line by line, as the statement itself was worked out (a statement issued before this rule shares its GST by largest remainder)
      const lines = statementRows(st),
        perLine = lines.map((l) => lineGst(l.amount)),
        gst =
          perLine.reduce((a, b) => a + b, 0) === st.gst
            ? perLine
            : shareGst(
                lines.map((l) => l.amount),
                st.gst,
              ),
        issued = auDate(st.issuedOn),
        due = auDate(st.dueOn ?? st.issuedOn),
        po = st.sites.map((/** @type {any} */ s) => s.po).find(Boolean) ?? st.customer.po ?? '';
      lines.forEach((l, i) => {
        gstTotal += gst[i];
        if (format === 'xero')
          rows.push([
            st.customer.name,
            st.customer.billingEmail ?? '',
            st.customer.address ?? '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            st.number,
            po,
            issued,
            due,
            '',
            l.description,
            1,
            fileMoney(l.amount),
            '',
            settings.xeroAccountCode,
            settings.xeroTaxType ?? '',
            '',
            '',
            '',
            '',
            'AUD',
            '',
          ]);
        else if (format === 'myob')
          rows.push([
            st.customer.name,
            '',
            st.customer.address ?? '',
            '',
            '',
            '',
            '',
            st.number,
            issued,
            po,
            '',
            '',
            l.description,
            settings.myobAccountNumber,
            fileMoney(l.amount),
            '',
            '',
            'Scaffold hire ' + st.number,
            '',
            '',
            '',
            '',
            settings.myobTaxCode ?? '',
            fileMoney(gst[i]),
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            st.customer.termsDays ?? '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
          ]);
        else
          rows.push([
            st.number,
            st.customer.name,
            st.customer.abnText,
            st.customer.billingEmail ?? '',
            st.issuedOn,
            st.dueOn ?? '',
            po,
            l.site ?? '',
            l.kind,
            l.description,
            1,
            fileMoney(l.amount),
            fileMoney(gst[i]),
            fileMoney(l.amount + gst[i]),
            st.reverses?.number ?? '',
          ]);
      });
    }
    const head = format === 'xero' ? XERO_HEAD : format === 'myob' ? MYOB_HEAD : GENERIC_HEAD,
      body = format === 'myob' ? tabText([head, ...rows]) : csvText([head, ...rows]),
      at = iso(this.planNow());
    if (record) {
      for (const st of statements)
        cached(this.db, 'INSERT INTO statement_exports VALUES(?,?,?,?,?,?,?)').run(
          randomUUID(),
          this.repo.company,
          st.id,
          format.toUpperCase(),
          month,
          at,
          this.user.id,
        );
      this.auth.audit(this.user, 'statements.exported', { format, month, statements: statements.length });
    }
    return {
      format,
      month,
      gst: gstTotal,
      body,
      name: 'scaffold-' + format + '-' + month + (format === 'myob' ? '.txt' : '.csv'),
      type: format === 'myob' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8',
      statements: statements.map((s) => s.number),
      rows: rows.length,
      total: statements.reduce((s, x) => s + x.total, 0),
      words:
        format === 'xero'
          ? 'When Xero asks, the amounts are Tax Exclusive and the dates are DD/MM/YYYY.'
          : format === 'myob'
            ? 'MYOB matches Co./Last Name to an existing customer card: make the card first. Amounts are ex GST (Inclusive left blank).'
            : 'Every line with its GST, for any package or a spreadsheet.',
    };
  },
  // ---------- unbilled ----------
  // Per customer and site: hire accrued after billedUpTo (ex GST), unbilled charges and open adjustments, and the day it started.
  unbilledView() {
    requireLive(this);
    this.stRequire();
    return this.unbilledCore();
  },
  // The same without the permission check: Needs you reads it for its UNBILLED rule (the words carry no amount without finance.view).
  unbilledCore() {
    const overview = this.hireFull({}),
      today = overview.today,
      billedCharges = this.billedItems('CHARGE'),
      billedAdj = this.billedItems('ADJUSTMENT'),
      byCustomer = new Map(),
      noCustomer = [];
    for (const r of overview.sites) {
      const site = this.repo.get(r.id, 'site'),
        from = site.billedUpTo ? addDays(site.billedUpTo, 1) : r.first;
      let hire = 0,
        missing = 0;
      if (from && from <= today) {
        const st = this.hireFull({ site: site.id, from, to: today }).statement;
        hire = st.subtotal;
        missing = st.missing;
      }
      const charges = this.chargeLines(site.id).filter((/** @type {any} */ c) => !billedCharges.has(c.id)),
        chargeSum = charges.reduce((s, c) => s + c.amount, 0);
      if (!hire && !chargeSum && !r.pieces) continue;
      const row = {
        site: site.id,
        name: site.name,
        customer: site.customer ?? null,
        since: from && from <= today ? from : null,
        days: from && from <= today ? daysBetween(from, today) + 1 : 0,
        hire,
        charges: chargeSum,
        amount: hire + chargeSum,
        unpriced: missing,
        pieces: r.pieces,
        billedUpTo: site.billedUpTo ?? null,
        lastStatement: site.lastStatement ?? null,
      };
      if (!site.customer) {
        noCustomer.push(row);
        continue;
      }
      let c = byCustomer.get(site.customer);
      if (!c)
        byCustomer.set(
          site.customer,
          (c = {
            customer: site.customer,
            name: this.customerName(site.customer) ?? 'Customer',
            sites: [],
            adjustments: 0,
            amount: 0,
            since: null,
            days: 0,
          }),
        );
      c.sites.push(row);
    }
    for (const a of this.repo.all('adjustment')) {
      if (billedAdj.has(a.id)) continue;
      let c = byCustomer.get(a.customer);
      if (!c)
        byCustomer.set(
          a.customer,
          (c = {
            customer: a.customer,
            name: this.customerName(a.customer) ?? 'Customer',
            sites: [],
            adjustments: 0,
            amount: 0,
            since: null,
            days: 0,
          }),
        );
      c.adjustments += a.amount;
    }
    const customers = [...byCustomer.values()].map((c) => {
      const since =
        c.sites
          .map((s) => s.since)
          .filter(Boolean)
          .sort()[0] ?? null;
      const amount = c.sites.reduce((s, x) => s + x.amount, 0) + c.adjustments;
      return { ...c, amount, gst: hireGst(amount), since, days: since ? daysBetween(since, today) + 1 : 0 };
    });
    customers.sort((a, b) => b.amount - a.amount);
    const amount = customers.reduce((s, c) => s + c.amount, 0) + noCustomer.reduce((s, x) => s + x.amount, 0),
      since = [...customers.map((c) => c.since), ...noCustomer.map((x) => x.since)].filter(Boolean).sort()[0] ?? null;
    return {
      today,
      amount,
      gst: hireGst(amount),
      incGst: amount + hireGst(amount),
      since,
      days: since ? daysBetween(since, today) + 1 : 0,
      words: amount
        ? hireDollars(amount) + ' unbilled' + (since ? ' since ' + dayLabel(since) : '')
        : 'Nothing unbilled',
      customers,
      noCustomer,
    };
  },
  // ---------- the parallel run ----------
  // For a period, the app's figure per customer beside what the office invoiced (typed), with the difference. A view: nothing is written.
  parallelRun(/** @type {any} */ input = {}) {
    requireLive(this);
    this.stRequire();
    const from = dayArg(input.from, 'From'),
      to = dayArg(input.to, 'To');
    requireRule(from <= to, 'The period starts after it ends.');
    const typed = new Map();
    for (const x of Array.isArray(input.invoiced) ? input.invoiced : [])
      if (x && typeof x.customer === 'string')
        typed.set(x.customer, integer(x.amount ?? 0, 'Invoiced (cents)', 0, MAX_CENTS * 100));
    const sites = this.repo.all('site'),
      rows = [];
    // every customer, a removed one too while it still has hire in the period (ADR 0011 review)
    for (const c of this.customerRows()) {
      let app = 0,
        unpriced = 0;
      const mine = sites.filter((s) => s.customer === c.id);
      for (const s of mine) {
        let st;
        try {
          st = this.hireFull({ site: s.id, from, to }).statement;
        } catch {
          continue;
        }
        app += st.subtotal;
        unpriced += st.missing;
      }
      const inv = typed.has(c.id) ? typed.get(c.id) : null;
      if (!app && inv == null && (!mine.length || c.status === 'REMOVED')) continue;
      rows.push({
        customer: c.id,
        name: c.name,
        removed: c.status === 'REMOVED',
        sites: mine.length,
        app,
        appIncGst: app + hireGst(app),
        invoiced: inv,
        difference: inv == null ? null : app - inv,
        percent: inv ? Math.round(((app - inv) / inv) * 1000) / 10 : null,
        unpriced,
      });
    }
    return {
      from,
      to,
      rows,
      words: 'Ex GST. The app’s hire for the period beside what you invoiced; the difference is app minus invoiced.',
    };
  },
  // ---------- retention ----------
  // Once a company day: closed messages and notifications older than retentionYears go; nothing else is ever pruned in a real yard.
  /** @param {number} now */
  clockRetention(now) {
    const today = this.clockDay(now);
    let m = retentionRuns.get(this.db);
    if (!m) retentionRuns.set(this.db, (m = new Map()));
    if (m.get(this.repo.company) === today) return 0;
    m.set(this.repo.company, today);
    const years = this.hireSettingsView().retentionYears,
      cut = addDays(today, -365 * years),
      cutIso = cut + 'T00:00:00.000Z';
    let n = 0;
    for (const r of cached(
      this.db,
      "SELECT id,kind FROM objects WHERE company_id=? AND ((kind='message' AND json_extract(data,'$.status') NOT IN ('WAITING_TO_SEND','SENT') AND json_extract(data,'$.day')<?) OR (kind='notification' AND json_extract(data,'$.createdAt')<?))",
    ).all(this.repo.company, cut, cutIso)) {
      this.repo.remove(r.id, r.kind);
      n++;
    }
    return n;
  },
};
