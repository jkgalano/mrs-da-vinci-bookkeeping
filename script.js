/* Mrs da Vinci Pty Ltd — Internal Bookkeeping
   Data is stored only in the browser's localStorage. */

const STORAGE_KEY = 'mrsDaVinci_purchaseRequests';
const FUND_STORAGE_KEY = 'mrsDaVinci_fundTransactions';
const STARTING_BALANCE = 10000;

// localStorage has a small total quota (commonly 5-10MB), shared across the
// whole site, so attachments are capped per file to leave room for many
// requests' worth of data.
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const DIRECTORS = ['Johanna Galano', 'Giorgenes Gelatti'];

const currencyFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD'
});

/* ---------- Storage helpers ---------- */

function loadRequests() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read purchase requests from localStorage', e);
    return [];
  }
}

function saveRequests(requests) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
}

function loadFundTransactions() {
  try {
    const raw = localStorage.getItem(FUND_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read fund transactions from localStorage', e);
    return [];
  }
}

function saveFundTransactions(txns) {
  localStorage.setItem(FUND_STORAGE_KEY, JSON.stringify(txns));
}

let requests = loadRequests();
let fundTransactions = loadFundTransactions();
let activeRequestId = null;

/* ---------- Formatting helpers ---------- */

// Convert an ISO date (YYYY-MM-DD) to Australian DD/MM/YYYY for display.
function formatDateAU(isoDate) {
  if (!isoDate) return '—';
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return isoDate;
  return `${day}/${month}/${year}`;
}

function formatCurrency(amount) {
  const value = Number(amount);
  if (Number.isNaN(value)) return currencyFormatter.format(0);
  return currencyFormatter.format(value);
}

function otherDirector(name) {
  return DIRECTORS.find(d => d !== name) || '';
}

// Auto-generates a sequential bookkeeping reference like "PR-2026-0001",
// numbered per calendar year based on how many requests already exist
// for that year. Directors can still overwrite it in the detail modal if
// they need to match an external invoice/reference number instead.
function generateBookkeepingReference(requestDate) {
  const year = (requestDate || todayISO()).slice(0, 4);
  const countThisYear = requests.filter(r => (r.requestDate || '').slice(0, 4) === year).length;
  const seq = String(countThisYear + 1).padStart(4, '0');
  return `PR-${year}-${seq}`;
}

// One-time migration: requests submitted before the auto-reference feature
// existed have no bookkeeping reference yet. Assigns them one, in
// chronological (request date) order per year, continuing on from whatever
// numbering already-referenced requests in that year have.
function backfillBookkeepingReferences() {
  const missing = requests.filter(r => !r.bookkeepingReference);
  if (missing.length === 0) return;

  missing.sort((a, b) =>
    (a.requestDate || '').localeCompare(b.requestDate || '') ||
    (a.createdAt || '').localeCompare(b.createdAt || '')
  );

  const yearCounts = {};
  requests.forEach(r => {
    if (r.bookkeepingReference) {
      const year = (r.requestDate || '').slice(0, 4);
      yearCounts[year] = (yearCounts[year] || 0) + 1;
    }
  });

  missing.forEach(r => {
    const year = (r.requestDate || todayISO()).slice(0, 4);
    yearCounts[year] = (yearCounts[year] || 0) + 1;
    r.bookkeepingReference = `PR-${year}-${String(yearCounts[year]).padStart(4, '0')}`;
  });

  saveRequests(requests);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Compares an ISO date (YYYY-MM-DD) against a year/month by string parts,
// avoiding any timezone shifting that Date parsing could introduce.
function isInMonth(isoDate, year, month) {
  if (!isoDate) return false;
  const [y, m] = isoDate.split('-').map(Number);
  return y === year && m === month;
}

function monthYearLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

// The amount actually paid: the recorded final amount if one was entered,
// otherwise the originally requested amount.
function paidAmount(r) {
  const val = (r.finalAmountPaid !== '' && r.finalAmountPaid !== undefined && r.finalAmountPaid !== null)
    ? Number(r.finalAmountPaid)
    : Number(r.amount);
  return Number.isNaN(val) ? 0 : val;
}

// A request counts as an actual expense once its payment status is
// explicitly set to "Paid" in the After Purchase section.
function isPaid(r) {
  return r.paymentStatus === 'Paid';
}

/* ---------- Recurring deduction engine ---------- */

// Adds `months` calendar months to an ISO date, clamping the day to the
// last day of the resulting month (e.g. 31 Jan + 1 month -> 28/29 Feb).
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const totalMonths = (m - 1) + months;
  const newYear = y + Math.floor(totalMonths / 12);
  const newMonth = (((totalMonths % 12) + 12) % 12) + 1;
  const lastDay = new Date(newYear, newMonth, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addYears(isoDate, years) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const newYear = y + years;
  const lastDay = new Date(newYear, m, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${newYear}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// True once a request has had at least one payment recorded against it —
// covers both a currently-Paid request and one that was Paid and has since
// been Refunded (its past deductions still happened and still count).
function hasPaymentActivity(r) {
  return r.paymentStatus === 'Paid' || r.paymentStatus === 'Refunded';
}

// For a request with payment activity, works out every deduction that has
// fallen due: a single deduction for a one-off, or one per elapsed period
// (starting at the start date) for a monthly/annual subscription. The
// first occurrence uses the recorded final amount (or the requested amount
// as a fallback); later occurrences use the originally requested amount,
// since only one "final amount paid" is recorded per request. Once a
// request is Refunded, no further periods accrue past the refund date —
// the refund itself is accounted for separately in computeRequestRefunds.
function computeDeductionOccurrences(r) {
  if (!hasPaymentActivity(r)) return [];
  const start = r.startDate || r.requestDate;
  if (!start) return [];
  const cutoff = (r.paymentStatus === 'Refunded' && r.refundDate) ? r.refundDate : todayISO();

  if (r.frequency !== 'Monthly' && r.frequency !== 'Annual') {
    if (start > cutoff) return [];
    return [{ date: start, amount: paidAmount(r), requestId: r.id, label: r.itemName }];
  }

  const stepFn = r.frequency === 'Monthly' ? addMonths : addYears;
  const occurrences = [];
  let k = 0;
  let date = start;
  while (date <= cutoff) {
    occurrences.push({
      date,
      amount: k === 0 ? paidAmount(r) : (Number(r.amount) || 0),
      requestId: r.id,
      label: r.itemName
    });
    k += 1;
    date = stepFn(start, k);
  }
  return occurrences;
}

function computeAllDeductions() {
  const all = [];
  requests.forEach(r => all.push(...computeDeductionOccurrences(r)));
  return all;
}

// Refund amounts for requests explicitly marked Refunded — added back to
// the fund balance as an inflow, dated at the recorded refund date.
function computeRequestRefunds() {
  return requests
    .filter(r => r.paymentStatus === 'Refunded' && r.refundDate)
    .map(r => ({
      date: r.refundDate,
      amount: (r.refundAmount !== '' && r.refundAmount !== undefined && r.refundAmount !== null)
        ? Number(r.refundAmount)
        : paidAmount(r),
      requestId: r.id,
      label: r.itemName
    }));
}

// The next upcoming renewal date/amount for a paid recurring subscription,
// for display only (not yet deducted from the balance).
function nextRenewalInfo(r) {
  if (!isPaid(r)) return null;
  if (r.frequency !== 'Monthly' && r.frequency !== 'Annual') return null;
  const start = r.startDate || r.requestDate;
  if (!start) return null;

  const today = todayISO();
  const stepFn = r.frequency === 'Monthly' ? addMonths : addYears;
  let k = 0;
  let date = start;
  while (date <= today) {
    k += 1;
    date = stepFn(start, k);
  }
  return { date, amount: Number(r.amount) || 0 };
}

/* ---------- Fund balance ---------- */

function computeFundSummary(deductions) {
  const allDeductions = deductions || computeAllDeductions();
  const deposits = fundTransactions.filter(t => t.type === 'Deposit').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const manualRefunds = fundTransactions.filter(t => t.type === 'Refund').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const requestRefunds = computeRequestRefunds().reduce((s, r) => s + r.amount, 0);
  const refunds = manualRefunds + requestRefunds;
  const deductionsTotal = allDeductions.reduce((s, d) => s + d.amount, 0);
  const balance = STARTING_BALANCE + deposits + refunds - deductionsTotal;
  return { deposits, refunds, deductionsTotal, balance };
}

/* ---------- Tabs ---------- */

function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

/* ---------- New Purchase Request form ---------- */

function initPurchaseForm() {
  const requestedBySelect = document.getElementById('req-requestedBy');
  const approverInput = document.getElementById('req-approver');
  const form = document.getElementById('purchase-form');

  requestedBySelect.addEventListener('change', () => {
    approverInput.value = otherDirector(requestedBySelect.value);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const requestedBy = requestedBySelect.value;
    if (!DIRECTORS.includes(requestedBy)) {
      alert('Please select who is requesting this purchase.');
      return;
    }

    const requestDate = document.getElementById('req-date').value;

    const record = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      requestDate: requestDate,
      requestedBy: requestedBy,
      approver: otherDirector(requestedBy),
      supplier: document.getElementById('req-supplier').value.trim(),
      itemName: document.getElementById('req-itemName').value.trim(),
      businessReason: document.getElementById('req-reason').value.trim(),
      amount: parseFloat(document.getElementById('req-amount').value) || 0,
      frequency: document.getElementById('req-frequency').value,
      startDate: document.getElementById('req-startDate').value,

      approvalStatus: 'Pending',
      approvalDate: '',
      approvalComments: '',

      paymentStatus: 'Unpaid',
      finalAmountPaid: '',
      invoiceReceived: false,
      paymentEvidenceReceived: false,
      bookkeepingReference: generateBookkeepingReference(requestDate),

      createdAt: new Date().toISOString()
    };

    requests.push(record);
    saveRequests(requests);

    form.reset();
    approverInput.value = '';

    refreshAll();

    // Jump to the requests tab so the user sees the new submission.
    document.querySelector('.tab-btn[data-tab="requests"]').click();
  });
}

/* ---------- Requests table ---------- */

function statusBadge(status) {
  const cls = status === 'Approved' ? 'status-approved'
    : status === 'Declined' ? 'status-declined'
    : 'status-pending';
  return `<span class="status-badge ${cls}">${status}</span>`;
}

function paymentBadge(status) {
  const s = status || 'Unpaid';
  const cls = s === 'Paid' ? 'status-approved'
    : s === 'Refunded' ? 'status-refunded'
    : 'status-pending';
  return `<span class="status-badge ${cls}">${s}</span>`;
}

function docsBadge(r) {
  const count = (r.attachments || []).length;
  if (count === 0) return `<span class="status-badge status-declined">No documents</span>`;
  return `<span class="status-badge status-approved">${count} attached</span>`;
}

function renderTable() {
  const tbody = document.getElementById('requests-tbody');
  const emptyNote = document.getElementById('requests-empty');
  tbody.innerHTML = '';

  if (requests.length === 0) {
    emptyNote.style.display = 'block';
    return;
  }
  emptyNote.style.display = 'none';

  const sorted = [...requests].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  sorted.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateAU(r.requestDate)}</td>
      <td>${escapeHtml(r.requestedBy)}</td>
      <td>${escapeHtml(r.supplier)}</td>
      <td>${escapeHtml(r.itemName)}</td>
      <td>${formatCurrency(r.amount)}</td>
      <td>${escapeHtml(r.frequency)}</td>
      <td>${formatDateAU(r.startDate)}</td>
      <td>${escapeHtml(r.approver)}</td>
      <td>${statusBadge(r.approvalStatus)}</td>
      <td>${paymentBadge(r.paymentStatus)}</td>
      <td>${docsBadge(r)}</td>
      <td><button class="link-btn" data-id="${r.id}">View / Update</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => openDetailModal(btn.dataset.id));
  });
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Detail / Approval modal ---------- */

function initModal() {
  document.getElementById('modal-close').addEventListener('click', closeDetailModal);
  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') closeDetailModal();
  });

  document.getElementById('apr-decision').addEventListener('change', (e) => {
    const dateField = document.getElementById('apr-date');
    if ((e.target.value === 'Approved' || e.target.value === 'Declined') && !dateField.value) {
      dateField.value = todayISO();
    }
  });

  document.getElementById('ap-paymentStatus').addEventListener('change', (e) => {
    const r = requests.find(x => x.id === activeRequestId);
    toggleRefundFields(e.target.value, r);
    if (r) updateRenewalInfo(r);
  });

  document.getElementById('approval-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveDetailModal();
  });

  document.getElementById('download-pdf').addEventListener('click', () => {
    if (!activeRequestId) return;
    downloadRequestPdf(activeRequestId);
  });

  document.getElementById('delete-request').addEventListener('click', () => {
    if (!activeRequestId) return;
    if (confirm('Delete this purchase request? This cannot be undone.')) {
      requests = requests.filter(r => r.id !== activeRequestId);
      saveRequests(requests);
      closeDetailModal();
      refreshAll();
    }
  });

  document.getElementById('ap-attachment-input').addEventListener('change', (e) => {
    if (e.target.files.length) {
      handleAttachmentFiles(e.target.files);
    }
    e.target.value = '';
  });

  document.getElementById('ap-bookkeepingRef').addEventListener('input', () => {
    const r = requests.find(x => x.id === activeRequestId);
    if (r) renderAttachmentsList(r);
  });

  initDropzone();
}

function initDropzone() {
  const dropzone = document.getElementById('ap-dropzone');
  const fileInput = document.getElementById('ap-attachment-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'dragend'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleAttachmentFiles(e.dataTransfer.files);
    }
  });
}

/* ---------- Attachments (receipts / invoices) ---------- */

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleAttachmentFiles(fileList) {
  const r = requests.find(x => x.id === activeRequestId);
  if (!r) return;
  if (!r.attachments) r.attachments = [];

  for (const file of Array.from(fileList)) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      alert(`"${file.name}" is too large (${formatFileSize(file.size)}). Please attach files under ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      r.attachments.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl,
        uploadedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('Failed to read file', err);
      alert(`Could not read "${file.name}".`);
    }
  }

  try {
    saveRequests(requests);
  } catch (err) {
    console.error('Failed to save attachment', err);
    alert('Could not save the attachment — browser storage is full. Try removing another attachment first, or attach a smaller file.');
    requests = loadRequests();
  }

  renderAttachmentsList(r);
  renderTable();
}

// Uses whatever's currently in the reference field (even if not yet saved)
// so newly-attached or renamed-on-download files always match what's on
// screen, falling back to the request's stored reference.
function currentBookkeepingReference(r) {
  const input = document.getElementById('ap-bookkeepingRef');
  const live = input ? input.value.trim() : '';
  return live || r.bookkeepingReference || '';
}

function renderAttachmentsList(r) {
  const list = document.getElementById('ap-attachments-list');
  const refNote = document.getElementById('ap-attachments-ref-note');
  list.innerHTML = '';

  const reference = currentBookkeepingReference(r);
  refNote.textContent = reference
    ? `Downloaded files will be labelled with bookkeeping reference ${reference}.`
    : '';

  (r.attachments || []).forEach(a => {
    const li = document.createElement('li');
    li.className = 'attachment-item';
    const isImage = a.type && a.type.startsWith('image/');
    const thumb = isImage
      ? `<img src="${a.dataUrl}" class="attachment-thumb" alt="">`
      : `<span class="attachment-icon">📄</span>`;
    const downloadName = reference ? `${reference} - ${a.name}` : a.name;

    li.innerHTML = `
      ${thumb}
      <span class="attachment-name">${escapeHtml(a.name)}</span>
      <span class="attachment-size">${formatFileSize(a.size)}</span>
      <a href="${a.dataUrl}" download="${escapeHtml(downloadName)}" class="link-btn">Download</a>
      <button type="button" class="link-btn attachment-remove" data-id="${a.id}">Remove</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('.attachment-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Remove this attachment?')) {
        r.attachments = (r.attachments || []).filter(a => a.id !== btn.dataset.id);
        saveRequests(requests);
        renderAttachmentsList(r);
      }
    });
  });
}

function openDetailModal(id) {
  const r = requests.find(x => x.id === id);
  if (!r) return;
  activeRequestId = id;

  document.getElementById('detail-summary').innerHTML = `
    <div><span>Request date:</span>${formatDateAU(r.requestDate)}</div>
    <div><span>Requested by:</span>${escapeHtml(r.requestedBy)}</div>
    <div><span>Supplier:</span>${escapeHtml(r.supplier)}</div>
    <div><span>Item:</span>${escapeHtml(r.itemName)}</div>
    <div><span>Business reason:</span>${escapeHtml(r.businessReason)}</div>
    <div><span>Amount:</span>${formatCurrency(r.amount)}</div>
    <div><span>Type:</span>${escapeHtml(r.frequency)}</div>
    <div><span>Start date:</span>${formatDateAU(r.startDate)}</div>
  `;

  document.getElementById('apr-decision').value = r.approvalStatus || 'Pending';
  document.getElementById('apr-approver').value = r.approver || '';
  document.getElementById('apr-date').value = r.approvalDate || '';
  document.getElementById('apr-comments').value = r.approvalComments || '';

  document.getElementById('ap-paymentStatus').value = r.paymentStatus || 'Unpaid';
  document.getElementById('ap-finalAmount').value = r.finalAmountPaid || '';
  document.getElementById('ap-bookkeepingRef').value = r.bookkeepingReference || '';
  document.getElementById('ap-invoiceReceived').checked = !!r.invoiceReceived;
  document.getElementById('ap-evidenceReceived').checked = !!r.paymentEvidenceReceived;
  document.getElementById('ap-refundDate').value = r.refundDate || '';
  document.getElementById('ap-refundAmount').value = (r.refundAmount !== '' && r.refundAmount !== undefined && r.refundAmount !== null) ? r.refundAmount : '';

  toggleRefundFields(r.paymentStatus || 'Unpaid', r);
  updateRenewalInfo(r);
  renderAttachmentsList(r);

  document.getElementById('detail-modal').classList.add('open');
}

// Shows/hides the refund date & amount fields, and pre-fills sensible
// defaults (today's date, the amount already paid) the first time a
// request is switched to Refunded.
function toggleRefundFields(status, r) {
  const container = document.getElementById('refund-fields');
  container.style.display = status === 'Refunded' ? '' : 'none';

  if (status === 'Refunded') {
    const dateField = document.getElementById('ap-refundDate');
    const amountField = document.getElementById('ap-refundAmount');
    if (!dateField.value) dateField.value = todayISO();
    if (!amountField.value && r) amountField.value = paidAmount(r);
  }
}

// Shows the next renewal date/amount for a paid Monthly/Annual request,
// using whatever payment status is currently selected in the form (so it
// updates live if the user just marked it Paid).
function updateRenewalInfo(r) {
  const infoEl = document.getElementById('ap-renewal-info');
  const draftStatus = document.getElementById('ap-paymentStatus').value;
  const preview = { ...r, paymentStatus: draftStatus };
  const info = nextRenewalInfo(preview);

  if (!info) {
    infoEl.textContent = '';
    return;
  }
  infoEl.textContent = `Next renewal: ${formatDateAU(info.date)} — estimated deduction ${formatCurrency(info.amount)}`;
}

function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('open');
  activeRequestId = null;
}

function saveDetailModal() {
  const r = requests.find(x => x.id === activeRequestId);
  if (!r) return;

  // The approver is fixed at request time (the opposite director) and cannot
  // approve their own purchase, so it is never editable here.
  r.approvalStatus = document.getElementById('apr-decision').value;
  r.approvalDate = document.getElementById('apr-date').value;
  r.approvalComments = document.getElementById('apr-comments').value.trim();

  r.finalAmountPaid = document.getElementById('ap-finalAmount').value
    ? parseFloat(document.getElementById('ap-finalAmount').value)
    : '';
  r.bookkeepingReference = document.getElementById('ap-bookkeepingRef').value.trim();
  r.invoiceReceived = document.getElementById('ap-invoiceReceived').checked;
  r.paymentEvidenceReceived = document.getElementById('ap-evidenceReceived').checked;

  r.paymentStatus = document.getElementById('ap-paymentStatus').value;
  if (r.paymentStatus === 'Refunded') {
    r.refundDate = document.getElementById('ap-refundDate').value || todayISO();
    const refundAmountVal = document.getElementById('ap-refundAmount').value;
    r.refundAmount = refundAmountVal !== '' ? parseFloat(refundAmountVal) : paidAmount(r);
  } else {
    r.refundDate = '';
    r.refundAmount = '';
  }

  saveRequests(requests);
  closeDetailModal();
  refreshAll();
}

/* ---------- Download as PDF (print-to-PDF) ---------- */

function printRow(label, value) {
  return `<div class="print-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function downloadRequestPdf(id) {
  const r = requests.find(x => x.id === id);
  if (!r) return;

  const body = document.getElementById('printable-body');
  body.innerHTML = `
    <div class="print-section-title">Request</div>
    ${printRow('Request date', formatDateAU(r.requestDate))}
    ${printRow('Requested by', r.requestedBy)}
    ${printRow('Supplier', r.supplier)}
    ${printRow('Purchase / subscription', r.itemName)}
    ${printRow('Business reason', r.businessReason)}
    ${printRow('Amount', formatCurrency(r.amount))}
    ${printRow('Type', r.frequency)}
    ${printRow('Purchase / start date', formatDateAU(r.startDate))}

    <div class="print-section-title">Approval</div>
    ${printRow('Status', r.approvalStatus)}
    ${printRow('Approver', r.approver)}
    ${printRow('Approval date', formatDateAU(r.approvalDate))}
    ${printRow('Comments', r.approvalComments || '—')}

    <div class="print-section-title">After Purchase</div>
    ${printRow('Payment status', r.paymentStatus || 'Unpaid')}
    ${printRow('Final amount paid', r.finalAmountPaid !== '' && r.finalAmountPaid !== undefined && r.finalAmountPaid !== null ? formatCurrency(r.finalAmountPaid) : '—')}
    ${printRow('Invoice / receipt received', yesNo(r.invoiceReceived))}
    ${printRow('Payment evidence received', yesNo(r.paymentEvidenceReceived))}
    ${printRow('Bookkeeping reference', r.bookkeepingReference || '—')}
    ${r.paymentStatus === 'Refunded' ? printRow('Refund date', formatDateAU(r.refundDate)) : ''}
    ${r.paymentStatus === 'Refunded' ? printRow('Refund amount', formatCurrency(r.refundAmount)) : ''}
    ${printRow('Attachments', (r.attachments && r.attachments.length) ? r.attachments.map(a => a.name).join(', ') : 'None')}
  `;

  document.getElementById('printable-title').textContent = 'Purchase Request';

  // Browsers commonly suggest the document title as the default filename
  // when the user chooses "Save as PDF" from the print dialog.
  const previousTitle = document.title;
  const safeItem = (r.itemName || 'request').replace(/[\\/:*?"<>|]/g, '-');
  const safeDate = (r.requestDate || '').split('-').reverse().join('-');
  document.title = `Purchase Request - ${safeItem} - ${safeDate}`;

  window.print();

  document.title = previousTitle;
}

/* ---------- Dashboard ---------- */

function renderDashboard() {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const allDeductions = computeAllDeductions();
  const totalExpenses = allDeductions.reduce((sum, d) => sum + d.amount, 0);
  const monthlyExpenses = allDeductions
    .filter(d => isInMonth(d.date, currentYear, currentMonth))
    .reduce((sum, d) => sum + d.amount, 0);

  const activeSubscriptions = requests.filter(r =>
    r.approvalStatus === 'Approved' &&
    (r.frequency === 'Monthly' || r.frequency === 'Annual')
  ).length;

  const awaitingApproval = requests.filter(r => r.approvalStatus === 'Pending').length;
  const fundSummary = computeFundSummary(allDeductions);

  const missingDocs = requests.filter(r =>
    r.approvalStatus === 'Approved' && (r.attachments || []).length === 0
  ).length;

  document.getElementById('stat-fund-balance').textContent = formatCurrency(fundSummary.balance);
  document.getElementById('stat-total-expenses').textContent = formatCurrency(totalExpenses);
  document.getElementById('stat-monthly-expenses').textContent = formatCurrency(monthlyExpenses);
  document.getElementById('stat-active-subs').textContent = activeSubscriptions;
  document.getElementById('stat-awaiting-approval').textContent = awaitingApproval;
  document.getElementById('stat-missing-docs').textContent = missingDocs;

  const monthName = now.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  document.getElementById('stat-monthly-note').textContent = monthName;
}

/* ---------- Monthly Report ---------- */

let currentReport = null;

function statCard(label, value, note) {
  return `
    <div class="stat-card">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value">${value}</span>
      <span class="stat-note">${escapeHtml(note || '')}</span>
    </div>
  `;
}

function initReportTab() {
  document.getElementById('report-month').value = currentYearMonth();

  document.getElementById('generate-report-btn').addEventListener('click', generateMonthlyReport);
  document.getElementById('download-report-pdf').addEventListener('click', downloadReportPdf);

  generateMonthlyReport();
}

// A request belongs to a month's report if it was submitted that month, or
// its purchase/subscription start date falls in that month.
function requestsForMonth(year, month) {
  return requests.filter(r => isInMonth(r.requestDate, year, month) || isInMonth(r.startDate, year, month));
}

function generateMonthlyReport() {
  const value = document.getElementById('report-month').value;
  if (!value) return;
  const [year, month] = value.split('-').map(Number);

  const rows = requestsForMonth(year, month);

  const approvedCount = rows.filter(r => r.approvalStatus === 'Approved').length;
  const declinedCount = rows.filter(r => r.approvalStatus === 'Declined').length;
  const pendingCount = rows.filter(r => r.approvalStatus === 'Pending').length;

  const totalRequested = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  // Expenses actually deducted from the fund this month, including
  // recurring subscription charges from requests started in prior months.
  const monthDeductions = computeAllDeductions().filter(d => isInMonth(d.date, year, month));
  const totalExpenses = monthDeductions.reduce((sum, d) => sum + d.amount, 0);

  const byType = { 'One-off': 0, 'Monthly': 0, 'Annual': 0 };
  rows.forEach(r => { if (byType.hasOwnProperty(r.frequency)) byType[r.frequency]++; });

  currentReport = { year, month, rows, monthDeductions, approvedCount, declinedCount, pendingCount, totalRequested, totalExpenses, byType };

  document.getElementById('report-summary').innerHTML =
    statCard('Requests This Month', rows.length, `${approvedCount} approved · ${declinedCount} declined · ${pendingCount} pending`) +
    statCard('Total Requested', formatCurrency(totalRequested), 'Sum of all requested amounts') +
    statCard('Total Expenses Paid', formatCurrency(totalExpenses), 'Fund deductions, incl. recurring') +
    statCard('By Type', `${byType['One-off']} / ${byType['Monthly']} / ${byType['Annual']}`, 'One-off / Monthly / Annual');

  renderReportTable(rows);
  renderReportDeductions(monthDeductions);
  document.getElementById('report-output').style.display = 'block';
}

function renderReportDeductions(monthDeductions) {
  const tbody = document.getElementById('report-deductions-tbody');
  const emptyNote = document.getElementById('report-deductions-empty');
  tbody.innerHTML = '';

  if (monthDeductions.length === 0) {
    emptyNote.style.display = 'block';
    return;
  }
  emptyNote.style.display = 'none';

  const sorted = [...monthDeductions].sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach(d => {
    const r = requests.find(x => x.id === d.requestId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateAU(d.date)}</td>
      <td>${escapeHtml(d.label)}</td>
      <td>${escapeHtml(r ? r.frequency : '')}</td>
      <td>${formatCurrency(d.amount)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderReportTable(rows) {
  const tbody = document.getElementById('report-tbody');
  const emptyNote = document.getElementById('report-empty');
  tbody.innerHTML = '';

  if (rows.length === 0) {
    emptyNote.style.display = 'block';
    return;
  }
  emptyNote.style.display = 'none';

  const sorted = [...rows].sort((a, b) => (a.requestDate || '').localeCompare(b.requestDate || ''));

  sorted.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateAU(r.requestDate)}</td>
      <td>${escapeHtml(r.requestedBy)}</td>
      <td>${escapeHtml(r.supplier)}</td>
      <td>${escapeHtml(r.itemName)}</td>
      <td>${formatCurrency(r.amount)}</td>
      <td>${escapeHtml(r.frequency)}</td>
      <td>${formatDateAU(r.startDate)}</td>
      <td>${statusBadge(r.approvalStatus)}</td>
      <td>${paymentBadge(r.paymentStatus)}</td>
      <td>${docsBadge(r)}</td>
      <td><button class="link-btn" data-id="${r.id}">View / Update</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => openDetailModal(btn.dataset.id));
  });
}

function downloadReportPdf() {
  if (!currentReport) return;
  const { year, month, rows, monthDeductions, approvedCount, declinedCount, pendingCount, totalRequested, totalExpenses, byType } = currentReport;
  const label = monthYearLabel(year, month);

  document.getElementById('printable-title').textContent = `Monthly Report — ${label}`;

  const sorted = [...rows].sort((a, b) => (a.requestDate || '').localeCompare(b.requestDate || ''));
  const tableRows = sorted.map(r => `
    <tr>
      <td>${escapeHtml(formatDateAU(r.requestDate))}</td>
      <td>${escapeHtml(r.requestedBy)}</td>
      <td>${escapeHtml(r.supplier)}</td>
      <td>${escapeHtml(r.itemName)}</td>
      <td>${escapeHtml(formatCurrency(r.amount))}</td>
      <td>${escapeHtml(r.frequency)}</td>
      <td>${escapeHtml(formatDateAU(r.startDate))}</td>
      <td>${escapeHtml(r.approvalStatus)}</td>
      <td>${escapeHtml(r.paymentStatus || 'Unpaid')}</td>
      <td>${(r.attachments || []).length ? `${r.attachments.length} attached` : 'No documents'}</td>
    </tr>
  `).join('');

  const body = document.getElementById('printable-body');
  body.innerHTML = `
    <div class="print-section-title">Summary</div>
    ${printRow('Requests this month', String(rows.length))}
    ${printRow('Approved / Declined / Pending', `${approvedCount} / ${declinedCount} / ${pendingCount}`)}
    ${printRow('Total requested', formatCurrency(totalRequested))}
    ${printRow('Total expenses paid', formatCurrency(totalExpenses))}
    ${printRow('By type (One-off / Monthly / Annual)', `${byType['One-off']} / ${byType['Monthly']} / ${byType['Annual']}`)}

    <div class="print-section-title">Purchase Requests</div>
    <table class="print-table">
      <thead>
        <tr>
          <th>Request Date</th>
          <th>Requested By</th>
          <th>Supplier</th>
          <th>Item</th>
          <th>Amount</th>
          <th>Type</th>
          <th>Start Date</th>
          <th>Status</th>
          <th>Payment</th>
          <th>Documents</th>
        </tr>
      </thead>
      <tbody>${tableRows || '<tr><td colspan="10">No purchase requests this month.</td></tr>'}</tbody>
    </table>

    <div class="print-section-title">Fund Deductions This Month</div>
    <table class="print-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Item</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>${
        monthDeductions.length
          ? [...monthDeductions].sort((a, b) => a.date.localeCompare(b.date)).map(d => `
            <tr>
              <td>${escapeHtml(formatDateAU(d.date))}</td>
              <td>${escapeHtml(d.label)}</td>
              <td>${escapeHtml(formatCurrency(d.amount))}</td>
            </tr>
          `).join('')
          : '<tr><td colspan="3">No fund deductions this month.</td></tr>'
      }</tbody>
    </table>
  `;

  const previousTitle = document.title;
  document.title = `Monthly Report - ${label.replace(/\s+/g, '-')}`;

  window.print();

  document.title = previousTitle;
}

/* ---------- Fund Balance tab ---------- */

function initFundTab() {
  document.getElementById('fund-date').value = todayISO();

  document.getElementById('fund-form').addEventListener('submit', (e) => {
    e.preventDefault();

    const entry = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      date: document.getElementById('fund-date').value,
      type: document.getElementById('fund-type').value,
      amount: parseFloat(document.getElementById('fund-amount').value) || 0,
      note: document.getElementById('fund-note').value.trim(),
      createdAt: new Date().toISOString()
    };

    fundTransactions.push(entry);
    saveFundTransactions(fundTransactions);

    e.target.reset();
    document.getElementById('fund-date').value = todayISO();

    refreshAll();
  });

  renderFundSummary();
  renderFundLedger();
}

function renderFundSummary() {
  const allDeductions = computeAllDeductions();
  const summary = computeFundSummary(allDeductions);

  document.getElementById('fund-stat-starting').textContent = formatCurrency(STARTING_BALANCE);
  document.getElementById('fund-stat-deposits').textContent = formatCurrency(summary.deposits);
  document.getElementById('fund-stat-refunds').textContent = formatCurrency(summary.refunds);
  document.getElementById('fund-stat-deductions').textContent = formatCurrency(summary.deductionsTotal);
  document.getElementById('fund-stat-balance').textContent = formatCurrency(summary.balance);
}

function buildLedgerEntries() {
  const entries = [{
    date: null,
    type: 'Starting Balance',
    description: 'Opening balance',
    amount: STARTING_BALANCE,
    isStarting: true
  }];

  fundTransactions.forEach(t => {
    entries.push({
      id: t.id,
      date: t.date,
      type: t.type,
      description: t.note || t.type,
      amount: Number(t.amount) || 0,
      manual: true
    });
  });

  computeAllDeductions().forEach(d => {
    entries.push({
      date: d.date,
      type: 'Purchase Deduction',
      description: d.label,
      amount: -d.amount,
      requestId: d.requestId
    });
  });

  computeRequestRefunds().forEach(r => {
    entries.push({
      date: r.date,
      type: 'Refund',
      description: r.label,
      amount: r.amount,
      requestId: r.requestId
    });
  });

  entries.sort((a, b) => {
    if (a.isStarting) return -1;
    if (b.isStarting) return 1;
    return (a.date || '').localeCompare(b.date || '');
  });

  let running = 0;
  entries.forEach(e => {
    running += e.amount;
    e.runningBalance = running;
  });

  return entries;
}

function renderFundLedger() {
  const tbody = document.getElementById('fund-ledger-tbody');
  tbody.innerHTML = '';

  buildLedgerEntries().forEach(e => {
    const amountClass = e.amount > 0 ? 'amount-positive' : e.amount < 0 ? 'amount-negative' : '';
    const amountText = (e.amount > 0 ? '+' : '') + formatCurrency(e.amount);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.date ? formatDateAU(e.date) : '—'}</td>
      <td>${escapeHtml(e.type)}</td>
      <td>${escapeHtml(e.description)}</td>
      <td class="${amountClass}">${amountText}</td>
      <td>${formatCurrency(e.runningBalance)}</td>
      <td>${e.manual ? `<button class="link-btn" data-id="${e.id}">Delete</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this fund entry?')) {
        fundTransactions = fundTransactions.filter(t => t.id !== btn.dataset.id);
        saveFundTransactions(fundTransactions);
        refreshAll();
      }
    });
  });
}

/* ---------- Refresh orchestration ---------- */

function refreshAll() {
  renderTable();
  renderDashboard();
  renderFundSummary();
  renderFundLedger();
}

/* ---------- Init ---------- */

// Stops the browser from navigating away to show the raw file if a drag
// misses the dropzone and lands elsewhere on the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('req-date').value = todayISO();

  backfillBookkeepingReferences();

  initTabs();
  initPurchaseForm();
  initModal();
  initReportTab();
  initFundTab();
  renderTable();
  renderDashboard();
});
