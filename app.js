// ── DATA STORE ──────────────────────────────────────────────────
let currentUser = null; // { id, username, name, role, active }

// User accounts — persisted in the store table under key 'users'
// Real accounts (and password hashes) live server-side in data.json — this is
// only a placeholder shown before the first /api/data load completes.
let users = [
  { id: 'u1', username: 'admin', name: 'Admin', role: 'Admin', active: true },
];

// Escapes user-supplied text before it's interpolated into innerHTML.
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => _escMap[c]); }

function isAdmin()          { return currentUser?.role === 'Admin'; }
function isManager()        { return currentUser?.role === 'Manager'; }
function isAdminOrManager() { return isAdmin() || isManager(); }
function isTech()           { return currentUser?.role === 'Tech'; }

// TECHS list is built from active Tech + Manager accounts + Unassigned
function getTechs() {
  const names = users.filter(u => u.active && (u.role === 'Tech' || u.role === 'Manager')).map(u => u.name);
  return [...names, 'Unassigned'];
}

// ── CLOCK IN / OUT ───────────────────────────────────────────────
let clockEntries = []; // { id, userId, userName, role, clockIn, clockOut }

function getActiveClockEntry(userId) {
  return clockEntries.find(e => e.userId === userId && !e.clockOut);
}

function clockIn() {
  if (!currentUser) return;
  if (getActiveClockEntry(currentUser.id)) { notify('Already clocked in.'); return; }
  clockEntries.push({
    id: 'clk-' + Date.now(),
    userId: currentUser.id,
    userName: currentUser.name,
    role: currentUser.role,
    clockIn: new Date().toISOString(),
    clockOut: null,
  });
  saveData();
  notify('Clocked in ✓');
  renderClockBtn();
}

function clockOut() {
  const entry = getActiveClockEntry(currentUser.id);
  if (!entry) { notify('Not clocked in.'); return; }
  entry.clockOut = new Date().toISOString();
  saveData();
  notify('Clocked out · ' + formatElapsed(entry.clockIn, entry.clockOut));
  renderClockBtn();
}

function formatElapsed(start, end) {
  const ms = new Date(end || new Date()) - new Date(start);
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderClockBtn() {
  const wrap = document.getElementById('clock-btn-wrap');
  if (!wrap || !currentUser) return;
  const active = getActiveClockEntry(currentUser.id);
  if (active) {
    const elapsed = formatElapsed(active.clockIn);
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--surface2);border:1px solid var(--accent-dim);margin:4px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);">● Clocked In</span>
          <span id="clock-elapsed" style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-muted);">${elapsed}</span>
        </div>
        <button onclick="clockOut()" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:5px;cursor:pointer;width:100%;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--red)';this.style.color='var(--red)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Clock Out</button>
      </div>`;
    // tick elapsed every minute
    clearInterval(window._clockTick);
    window._clockTick = setInterval(() => {
      const el = document.getElementById('clock-elapsed');
      if (el && active) el.textContent = formatElapsed(active.clockIn);
    }, 30000);
  } else {
    clearInterval(window._clockTick);
    wrap.innerHTML = `
      <div style="padding:4px 10px 8px;">
        <button onclick="clockIn()" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:7px;cursor:pointer;width:100%;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Clock In</button>
      </div>`;
  }
}

const STATUS_MAP = {
  'Repair Queue':        's-queue',
  'Diag In Progress':    's-diag',
  'Repair In Progress':  's-repair',
  'Ordering Parts':      's-parts',
  'Parts Ordered':       's-ordered',
  'Awaiting Parts':      's-awaiting',
  'Repaired':            's-repaired',
  'Unrepairable':        's-unrepair',
  'Client Declined':     's-declined',
  'Completed':           's-complete',
};
const STATUS_LIST = Object.keys(STATUS_MAP);

// ── PARTS / INVENTORY DATA ───────────────────────────────────────
let inventory = [];

// Product line registry: code → description
let productLines = [];

// Global ever-incrementing serial — never resets, never reused
let skuSerialCounter = 0;

function nextSerial() {
  skuSerialCounter++;
  return String(skuSerialCounter).padStart(8, '0');
}

// Generate one SKU for a given product line code: XXXX-XXXXXXXX
function generateSKU(productLineCode) {
  const code = (productLineCode || '0000').toString().replace(/\D/g,'').slice(0,4).padStart(4,'0');
  return code + '-' + nextSerial();
}

// Generate N SKUs for a product line (for bulk receiving)
function generateBulkSKUs(productLineCode, qty) {
  const skus = [];
  for (let i = 0; i < qty; i++) skus.push(generateSKU(productLineCode));
  return skus;
}

// Find or prompt to create product line
function productLineByCode(code) {
  return productLines.find(pl => pl.code === code);
}

let purchaseOrders = [];

const PART_CATEGORIES = ['Screen', 'Battery', 'Port', 'Keyboard', 'Housing', 'Camera', 'Speaker', 'Button', 'Cable', 'Other'];
const SUPPLIERS = ['iFixit Supply', 'Mobile Parts Warehouse', 'TechParts Direct', 'Amazon Business', 'Other'];

let activePartsTab = 'inventory';
let invSearchQ = '';
let poSearchQ = '';

function nextPONum() {
  const nums = purchaseOrders.map(p => parseInt(p.id.replace('PO-','')));
  return 'PO-' + (Math.max(...nums, 2000) + 1);
}

// ── PARTS PAGE ROUTING ───────────────────────────────────────────
function switchPartsTab(tab) {
  activePartsTab = tab;
  document.querySelectorAll('.parts-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('ptab-' + (tab==='po'?'po':tab==='receiving'?'receiving':'inventory')).classList.add('active');
  renderPartsTab();
}

function renderPartsTab() {
  const actEl = document.getElementById('parts-page-actions');
  const content = document.getElementById('parts-tab-content');
  // Show/hide admin/manager-only tabs and notice
  ['ptab-po','ptab-receiving'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdminOrManager() ? '' : 'none';
  });
  const notice = document.getElementById('parts-admin-notice');
  if (notice) notice.style.display = isAdminOrManager() ? 'none' : 'block';
  if (activePartsTab === 'inventory') {
    actEl.innerHTML = isAdminOrManager() ? `
      <button class="btn btn-ghost" onclick="openProductLineManager()">Product Lines</button>
      <button class="btn btn-ghost" onclick="openAddPartModal()">+ Add Part</button>
    ` : '';
    renderInventoryTab(content);
  } else if (activePartsTab === 'po') {
    if (!isAdminOrManager()) { notify('Manager access required.'); switchPartsTab('inventory'); return; }
    actEl.innerHTML = `<button class="btn btn-accent" onclick="openNewPOModal()">+ New Purchase Order</button>`;
    renderPOTab(content);
  } else {
    if (!isAdminOrManager()) { notify('Manager access required.'); switchPartsTab('inventory'); return; }
    actEl.innerHTML = '';
    renderReceivingTab(content);
  }
}

// ── INVENTORY TAB ────────────────────────────────────────────────
function renderInventoryTab(container) {
  const low  = inventory.filter(p => p.qty > 0 && p.qty <= p.minQty).length;
  const out  = inventory.filter(p => p.qty === 0).length;
  const ok   = inventory.filter(p => p.qty > p.minQty).length;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px;">
      <div style="background:var(--surface);padding:16px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--green)">${ok}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">In Stock</div>
      </div>
      <div style="background:var(--surface);padding:16px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--orange)">${low}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Low Stock</div>
      </div>
      <div style="background:var(--surface);padding:16px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--red)">${out}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Out of Stock</div>
      </div>
    </div>

    <div class="search-bar" style="margin-bottom:16px;">
      <input type="text" class="search-input" placeholder="Search by name, SKU, category…" oninput="invSearchQ=this.value;renderInventoryTab(document.getElementById('parts-tab-content'))">
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Part Name</th>
            <th>Category</th>
            <th>Brand</th>
                    ${isAdminOrManager() ? '<th>Cost</th>' : ''}
            <th>Price</th>
            <th>Qty</th>
            <th>Location</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${inventory.filter(p => {
            if (!invSearchQ) return true;
            const q = invSearchQ.toLowerCase();
            return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q);
          }).map(p => {
            const qtyClass = p.qty === 0 ? 'qty-out' : p.qty <= p.minQty ? 'qty-low' : 'qty-ok';
            const qtyLabel = p.qty === 0 ? '⚠ Out' : p.qty <= p.minQty ? '↓ Low' : p.qty;
            return `<tr>
              <td class="td-mono" style="color:var(--accent)">${p.sku}</td>
              <td class="td-primary">${p.name}</td>
              <td class="td-mono">${p.category}</td>
              <td style="color:var(--text-muted)">${p.brand}</td>
              ${isAdminOrManager() ? `<td class="td-mono">$${p.cost.toFixed(2)}</td>` : ''}
              <td class="td-mono" style="color:var(--accent)">$${p.price.toFixed(2)}</td>
              <td><span class="${qtyClass}" style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;font-weight:700;">${qtyLabel}</span></td>
              <td class="td-mono" style="color:var(--text-dim)">${p.location}</td>
              <td>
                <div style="display:flex;gap:4px;">
                  <button class="btn btn-ghost btn-sm" onclick="openEditPartModal('${p.id}')">Edit</button>
                  <button class="btn btn-ghost btn-sm" onclick="openAdjustQtyModal('${p.id}')" title="Remove or correct stock — adding requires a PO">Correct Qty</button>
                </div>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="9"><div class="empty"><div class="empty-text">No parts found</div></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function openAddPartModal() {
  if (!isAdminOrManager()) { notify('Manager access required.'); return; }
  const plOptions = productLines.map(pl =>
    `<option value="${pl.code}">${pl.code} — ${pl.description}</option>`
  ).join('');
  openModal('Register New Part', `
    <div style="background:var(--bg);border:1px solid var(--orange);padding:12px 14px;margin-bottom:16px;display:flex;gap:10px;align-items:flex-start;">
      <span style="font-size:16px;flex-shrink:0;">⚠</span>
      <div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--orange);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">Stock comes in through Purchase Orders only</div>
        <div style="font-size:13px;color:var(--text-muted);line-height:1.5;">This creates the part record at <strong style="color:var(--text);">zero quantity</strong>. To add stock, create a Purchase Order and receive it in the Receiving tab.</div>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-group span2" style="background:var(--bg);border:1px solid var(--border);padding:12px 14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;">Product Line SKU — format: XXXX-XXXXXXXX</div>
          <button onclick="openProductLineManager()" style="background:none;border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;cursor:pointer;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Manage Product Lines</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px auto;gap:8px;align-items:flex-end;">
          <div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Product Line</div>
            <select class="form-select" id="np-pl" style="font-family:\'IBM Plex Mono\',monospace;">
              <option value="">— Select product line —</option>
              ${plOptions}
            </select>
          </div>
          <div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Or custom</div>
            <input class="form-input" id="np-pl-custom" maxlength="4" placeholder="0000" style="font-family:\'IBM Plex Mono\',monospace;color:var(--accent);font-size:14px;letter-spacing:2px;" oninput="this.value=this.value.replace(/\\D/g,'')">
          </div>
          <button class="btn btn-accent" onclick="genPartSKU()" style="height:36px;white-space:nowrap;">⚡ Generate SKU</button>
        </div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:10px;">
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">SKU:</div>
          <input class="form-input" id="np-sku" placeholder="Will appear here after generating" style="flex:1;font-family:\'IBM Plex Mono\',monospace;color:var(--accent);font-size:14px;letter-spacing:1px;">
        </div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-top:6px;">Example: product line <span style="color:var(--accent);">5555</span> → generates <span style="color:var(--accent);">5555-00000007</span></div>
      </div>
      <div class="form-group span2">
        <label class="form-label">Part Name</label>
        <input class="form-input" id="np-name" placeholder="e.g. iPhone 8 Screen Standard Quality">
      </div>
      <div class="form-group">
        <label class="form-label">Brand</label>
        <input class="form-input" id="np-brand" placeholder="Apple, Samsung, Generic…">
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-select" id="np-cat">
          ${PART_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Cost (Your Price $)</label>
        <input class="form-input" id="np-cost" type="number" placeholder="0.00">
      </div>
      <div class="form-group">
        <label class="form-label">Sell Price ($)</label>
        <input class="form-input" id="np-price" type="number" placeholder="0.00">
      </div>
      <div class="form-group">
        <label class="form-label">Min Qty Alert</label>
        <input class="form-input" id="np-minqty" type="number" value="2">
      </div>
      <div class="form-group">
        <label class="form-label">Bin / Location</label>
        <input class="form-input" id="np-loc" placeholder="e.g. Bin A1, Shelf 3…">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Create Part Record', cls: 'btn-accent', action: saveNewPart }
  ]);
}

function genPartSKU() {
  const select = document.getElementById('np-pl');
  const custom = document.getElementById('np-pl-custom');
  let code = (custom?.value.trim() || select?.value || '').replace(/\D/g,'').slice(0,4);
  if (!code || code.length < 4) {
    alert('Select a product line or enter a 4-digit custom code first.');
    return;
  }
  code = code.padStart(4,'0');
  if (!productLineByCode(code)) {
    const desc = prompt('New product line code ' + code + ' — enter a description:');
    if (!desc) return;
    productLines.push({ code, description: desc });
  }
  document.getElementById('np-sku').value = generateSKU(code);
}

function autoSKUOnInput() {
  // no-op in new system — SKU is generated at receive time only
}

function autoSKU() {
  // no-op in new system — kept so old references don't break
}

// ── PRODUCT LINE MANAGER ─────────────────────────────────────────
function openProductLineManager() {
  if (!isAdminOrManager()) { notify('Manager access required.'); return; }
  const rows = productLines.map((pl, i) => `
    <div style="display:grid;grid-template-columns:90px 1fr 36px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);font-weight:700;">${pl.code}</span>
      <span style="font-size:13px;">${pl.description}</span>
      <button onclick="removeProductLine(${i})" style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">×</button>
    </div>`).join('') || '<div style="color:var(--text-dim);font-size:12px;padding:12px 0;">No product lines yet.</div>';

  openModal('Product Line Registry', `
    <div style="margin-bottom:16px;">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">How it works</div>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.6;">The first <strong style="color:var(--text);">4 digits</strong> of every SKU identify the product line (e.g. <span style="font-family:\'IBM Plex Mono\',monospace;color:var(--accent);">5555</span> = Standard iPhone 8 Screen). The last <strong style="color:var(--text);">8 digits</strong> are a unique serial that never resets — each individual unit gets its own number.</div>
    </div>
    <div style="border:1px solid var(--border);padding:0 14px;margin-bottom:16px;max-height:220px;overflow-y:auto;" id="pl-list">
      ${rows}
    </div>
    <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">Add New Product Line</div>
    <div style="display:grid;grid-template-columns:110px 1fr auto;gap:8px;align-items:flex-end;">
      <div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">4-Digit Code</div>
        <input class="form-input" id="pl-code" maxlength="4" placeholder="e.g. 5555" style="font-family:\'IBM Plex Mono\',monospace;color:var(--accent);font-size:15px;letter-spacing:2px;">
      </div>
      <div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Description</div>
        <input class="form-input" id="pl-desc" placeholder="e.g. iPhone 8 Screen - Standard Quality">
      </div>
      <button class="btn btn-accent" onclick="addProductLine()" style="height:36px;">Add</button>
    </div>
    <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-top:8px;">Example: code <span style="color:var(--accent);">5555</span> → "iPhone 8 Screen Standard" → SKUs will be <span style="color:var(--accent);">5555-00000001</span>, <span style="color:var(--accent);">5555-00000002</span>…</div>
  `, [
    { label: 'Done', cls: 'btn-accent', action: closeModalDirect }
  ]);
}

function addProductLine() {
  const code = document.getElementById('pl-code').value.replace(/\D/g,'').slice(0,4).padStart(4,'0');
  const desc = document.getElementById('pl-desc').value.trim();
  if (code.length !== 4) { alert('Code must be exactly 4 digits.'); return; }
  if (!desc) { alert('Description is required.'); return; }
  if (productLines.find(pl => pl.code === code)) { alert('Product line code ' + code + ' already exists.'); return; }
  productLines.push({ code, description: desc });
  notify('Product line ' + code + ' added');
  // Re-render list inside modal
  const list = document.getElementById('pl-list');
  if (list) {
    list.innerHTML = productLines.map((pl, i) => `
      <div style="display:grid;grid-template-columns:90px 1fr 36px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);font-weight:700;">${pl.code}</span>
        <span style="font-size:13px;">${pl.description}</span>
        <button onclick="removeProductLine(${i})" style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">×</button>
      </div>`).join('');
  }
  document.getElementById('pl-code').value = '';
  document.getElementById('pl-desc').value = '';
}

function removeProductLine(idx) {
  productLines.splice(idx, 1);
  saveData();
  const list = document.getElementById('pl-list');
  if (list) list.innerHTML = productLines.map((pl, i) => `
    <div style="display:grid;grid-template-columns:90px 1fr 36px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);font-weight:700;">${pl.code}</span>
      <span style="font-size:13px;">${pl.description}</span>
      <button onclick="removeProductLine(${i})" style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">×</button>
    </div>`).join('');
}

// Render a SKU generator widget for use inside receive modal
// Returns HTML string for line index i, with qty pre-filled
function skuGeneratorWidget(lineIdx, partName, qty) {
  const plOptions = productLines.map(pl =>
    `<option value="${pl.code}">${pl.code} — ${pl.description}</option>`
  ).join('');
  return `
    <div style="background:var(--surface);border:1px solid var(--border);padding:12px 14px;margin-top:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);letter-spacing:1.5px;text-transform:uppercase;">⚡ Generate SKUs for This Receiving</span>
        <button onclick="openProductLineManager()" style="background:none;border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;cursor:pointer;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Manage Product Lines</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:flex-end;margin-bottom:10px;">
        <div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Product Line (4-digit code)</div>
          <select class="form-select" id="recv-pl-${lineIdx}" style="font-family:\'IBM Plex Mono\',monospace;">
            <option value="">— Select or type below —</option>
            ${plOptions}
          </select>
        </div>
        <div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Or custom code</div>
          <input class="form-input" id="recv-pl-custom-${lineIdx}" maxlength="4" placeholder="0000" style="width:80px;font-family:\'IBM Plex Mono\',monospace;color:var(--accent);font-size:14px;letter-spacing:2px;" oninput="this.value=this.value.replace(/\\D/g,'')">
        </div>
      </div>
      <button onclick="previewSKUs(${lineIdx},${qty})" class="btn btn-accent" style="width:100%;margin-bottom:10px;">⚡ Generate ${qty} SKU${qty!==1?'s':''}</button>
      <div id="recv-sku-preview-${lineIdx}" style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);min-height:20px;"></div>
    </div>
  `;
}

function previewSKUs(lineIdx, qty) {
  const select = document.getElementById('recv-pl-' + lineIdx);
  const custom = document.getElementById('recv-pl-custom-' + lineIdx);
  let code = (custom?.value.trim() || select?.value || '').replace(/\D/g,'').slice(0,4);
  if (!code || code.length < 4) { 
    document.getElementById('recv-sku-preview-' + lineIdx).innerHTML = '<span style="color:var(--red);">⚠ Enter or select a valid 4-digit product line code</span>';
    return;
  }
  code = code.padStart(4,'0');
  // Check if product line exists, if not auto-add it
  if (!productLineByCode(code)) {
    const desc = prompt('New product line code ' + code + ' — enter a description for it:');
    if (!desc) { return; }
    productLines.push({ code, description: desc });
  }
  // Generate the SKUs (preview only — commit on confirm receipt)
  const skus = generateBulkSKUs(code, qty);
  // Store on the line element for confirmReceipt to pick up
  document.getElementById('recv-sku-preview-' + lineIdx).innerHTML = `
    <div style="margin-bottom:6px;color:var(--green);font-size:10px;letter-spacing:1px;text-transform:uppercase;">✓ ${skus.length} SKU${skus.length!==1?'s':''} generated — will be assigned on confirm</div>
    ${skus.map(s => `<div style="color:var(--accent);padding:1px 0;">${s}</div>`).join('')}
  `;
  // Store generated SKUs as a data attribute on the preview div
  document.getElementById('recv-sku-preview-' + lineIdx).dataset.skus = JSON.stringify(skus);
  document.getElementById('recv-sku-preview-' + lineIdx).dataset.code = code;
}

function saveNewPart() {
  const name = document.getElementById('np-name').value.trim();
  const sku  = document.getElementById('np-sku').value.trim();
  if (!name) { alert('Part name is required.'); return; }
  if (!sku)  { alert('SKU is required — use ⚡ Generate SKU first.'); return; }
  if (!/^\d{4}-\d{8}$/.test(sku)) { alert('SKU must be in format XXXX-XXXXXXXX (e.g. 5555-00000001).'); return; }
  if (inventory.find(p => p.sku === sku)) { alert('A part with SKU "' + sku + '" already exists.'); return; }
  const code = sku.split('-')[0];
  inventory.push({
    id: 'p' + Date.now(),
    sku,
    productLine: code,
    name,
    brand:    document.getElementById('np-brand').value.trim() || 'Generic',
    category: document.getElementById('np-cat').value,
    cost:     parseFloat(document.getElementById('np-cost').value)   || 0,
    price:    parseFloat(document.getElementById('np-price').value)  || 0,
    qty:      0,
    minQty:   parseInt(document.getElementById('np-minqty').value)   || 2,
    location: document.getElementById('np-loc').value.trim()         || '—',
  });
  closeModalDirect();
  notify('Part record created — SKU ' + sku);
  renderInventoryTab(document.getElementById('parts-tab-content'));
}

function openEditPartModal(partId) {
  if (!isAdminOrManager()) { notify('Manager access required.'); return; }
  const p = inventory.find(x => x.id === partId);
  if (!p) return;
  openModal('Edit Part — ' + p.sku, `
    <div class="form-grid">
      <div class="form-group span2">
        <label class="form-label">SKU</label>
        <div style="display:flex;gap:8px;">
          <input class="form-input" id="ep-sku" value="${p.sku}" style="flex:1;">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('ep-sku').value=generateSKU(document.getElementById('ep-brand').value,document.getElementById('ep-cat').value)">⚡ Regen</button>
        </div>
      </div>
      <div class="form-group span2">
        <label class="form-label">Part Name</label>
        <input class="form-input" id="ep-name" value="${p.name}">
      </div>
      <div class="form-group">
        <label class="form-label">Brand</label>
        <input class="form-input" id="ep-brand" value="${p.brand}">
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-select" id="ep-cat">${PART_CATEGORIES.map(c=>`<option ${p.category===c?'selected':''}>${c}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Cost ($)</label>
        <input class="form-input" id="ep-cost" type="number" value="${p.cost}">
      </div>
      <div class="form-group">
        <label class="form-label">Sell Price ($)</label>
        <input class="form-input" id="ep-price" type="number" value="${p.price}">
      </div>
      <div class="form-group">
        <label class="form-label">Min Qty Alert</label>
        <input class="form-input" id="ep-minqty" type="number" value="${p.minQty}">
      </div>
      <div class="form-group">
        <label class="form-label">Bin / Location</label>
        <input class="form-input" id="ep-loc" value="${p.location}">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Save', cls: 'btn-accent', action: () => {
      p.sku      = document.getElementById('ep-sku').value.trim() || p.sku;
      p.name     = document.getElementById('ep-name').value.trim() || p.name;
      p.brand    = document.getElementById('ep-brand').value.trim() || p.brand;
      p.category = document.getElementById('ep-cat').value;
      p.cost     = parseFloat(document.getElementById('ep-cost').value) || p.cost;
      p.price    = parseFloat(document.getElementById('ep-price').value) || p.price;
      p.minQty   = parseInt(document.getElementById('ep-minqty').value) || p.minQty;
      p.location = document.getElementById('ep-loc').value.trim() || p.location;
      closeModalDirect();
      notify('Part updated');
      renderInventoryTab(document.getElementById('parts-tab-content'));
    }}
  ]);
}

function openAdjustQtyModal(partId) {
  const p = inventory.find(x => x.id === partId);
  openModal('Adjust Quantity — ' + p.name, `
    <div style="background:var(--bg);border:1px solid var(--border);padding:12px 14px;margin-bottom:16px;display:flex;gap:10px;align-items:flex-start;">
      <span style="font-size:16px;flex-shrink:0;">⚠</span>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.5;">
        Use this to correct stock for <strong style="color:var(--text);">damage, loss, or miscounts only</strong>. To add stock, receive it through a Purchase Order.
      </div>
    </div>
    <div style="margin-bottom:16px;">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);margin-bottom:4px;">Current Qty</div>
      <div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;${p.qty===0?'color:var(--red)':p.qty<=p.minQty?'color:var(--orange)':'color:var(--green)'}">${p.qty}</div>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Adjustment Type</label>
        <select class="form-select" id="adj-type">
          <option value="remove">Remove Stock (damage / loss)</option>
          <option value="set">Set Exact Qty (recount)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Quantity</label>
        <input class="form-input" id="adj-qty" type="number" value="1" min="0">
      </div>
      <div class="form-group span2">
        <label class="form-label">Reason</label>
        <input class="form-input" id="adj-reason" placeholder="e.g. Damaged during repair, recount, stolen…">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Apply Adjustment', cls: 'btn-accent', action: () => {
      const type = document.getElementById('adj-type').value;
      const qty  = parseInt(document.getElementById('adj-qty').value) || 0;
      if (type === 'remove') p.qty = Math.max(0, p.qty - qty);
      if (type === 'set')    p.qty = Math.max(0, qty);
      closeModalDirect();
      notify('Quantity adjusted → ' + p.qty);
      updateLowStockBadge();
      renderInventoryTab(document.getElementById('parts-tab-content'));
    }}
  ]);
}

// ── PURCHASE ORDERS TAB ──────────────────────────────────────────
function renderPOTab(container) {
  container.innerHTML = `
    <div class="search-bar" style="margin-bottom:16px;">
      <input type="text" class="search-input" placeholder="Search by PO #, supplier…" oninput="poSearchQ=this.value;renderPOTab(document.getElementById('parts-tab-content'))">
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>PO #</th>
            <th>Supplier</th>
            <th>Created</th>
            <th>Expected</th>
            <th>Lines</th>
            <th>Total Cost</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${purchaseOrders.filter(po => {
            if (!poSearchQ) return true;
            const q = poSearchQ.toLowerCase();
            return po.id.toLowerCase().includes(q) || po.supplier.toLowerCase().includes(q);
          }).map(po => {
            const total = po.lines.reduce((s,l) => s + l.qtyOrdered * l.unitCost, 0);
            const poStatusCls = { Open:'po-open', Partial:'po-partial', Received:'po-received', Cancelled:'po-cancelled' }[po.status] || 'po-open';
            return `<tr style="cursor:pointer" onclick="openPODetail('${po.id}')">
              <td class="td-mono" style="color:var(--accent)">${po.id}</td>
              <td class="td-primary">${po.supplier}</td>
              <td class="td-mono">${formatDate(po.created)}</td>
              <td class="td-mono">${formatDate(po.expectedDate)}</td>
              <td class="td-mono">${po.lines.length}</td>
              <td class="td-mono">$${total.toFixed(2)}</td>
              <td><span class="po-status ${poStatusCls}">${po.status}</span></td>
              <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openPODetail('${po.id}')">View</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="8"><div class="empty"><div class="empty-text">No purchase orders</div></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function openNewPOModal() {
  openModal('New Purchase Order', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Supplier</label>
        <select class="form-select" id="npo-supplier">
          ${SUPPLIERS.map(s=>`<option>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Expected Delivery Date</label>
        <input class="form-input" id="npo-date" type="date" value="${new Date(Date.now()+7*86400000).toISOString().slice(0,10)}">
      </div>
      <div class="form-group span2">
        <label class="form-label">Notes <span class="opt">(optional)</span></label>
        <input class="form-input" id="npo-notes" placeholder="Order notes…">
      </div>
    </div>
    <div class="form-section" style="margin-top:20px;">Line Items</div>
    <div id="npo-lines"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%;" onclick="addPOLine()">+ Add Line Item</button>
    <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);margin-top:12px;text-align:right;">
      Total: <span id="npo-total" style="color:var(--accent);font-size:13px;">$0.00</span>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Create PO', cls: 'btn-accent', action: saveNewPO }
  ]);
  addPOLine();
}

let npoLineCount = 0;
function addPOLine() {
  npoLineCount++;
  const id = 'npoline-' + npoLineCount;
  const container = document.getElementById('npo-lines');
  const invOptions = inventory.map(p => `<option value="${p.id}" data-cost="${p.cost}" data-sku="${p.sku}">${p.name} (${p.sku})</option>`).join('');
  const div = document.createElement('div');
  div.id = id;
  div.style.cssText = 'display:grid;grid-template-columns:1fr 100px 110px 30px;gap:8px;margin-bottom:8px;align-items:end;';
  div.innerHTML = `
    <div class="form-group" style="margin:0;">
      <label class="form-label">Part</label>
      <select class="form-select" onchange="updatePOLineCost(this,'${id}')">
        <option value="">— Select part or type new —</option>
        ${invOptions}
        <option value="__new__">+ New part (not in inventory)</option>
      </select>
    </div>
    <div class="form-group" style="margin:0;">
      <label class="form-label">Qty</label>
      <input class="form-input" type="number" value="1" min="1" onchange="calcPOTotal()">
    </div>
    <div class="form-group" style="margin:0;">
      <label class="form-label">Unit Cost ($)</label>
      <input class="form-input" id="${id}-cost" type="number" value="0.00" onchange="calcPOTotal()">
    </div>
    <button onclick="document.getElementById('${id}').remove();calcPOTotal()" style="background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;padding-bottom:4px;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">×</button>
  `;
  container.appendChild(div);
}

function updatePOLineCost(sel, lineId) {
  const opt = sel.options[sel.selectedIndex];
  const cost = opt.dataset.cost;
  if (cost) document.getElementById(lineId+'-cost').value = parseFloat(cost).toFixed(2);
  calcPOTotal();
}

function calcPOTotal() {
  let total = 0;
  document.querySelectorAll('#npo-lines > div').forEach(row => {
    const qty  = parseFloat(row.querySelector('input[type="number"]')?.value) || 0;
    const cost = parseFloat(row.querySelector('input[type="number"]:last-of-type')?.value) || 0;
    total += qty * cost;
  });
  const el = document.getElementById('npo-total');
  if (el) el.textContent = '$' + total.toFixed(2);
}

function saveNewPO() {
  const supplier = document.getElementById('npo-supplier').value;
  const lines = [];
  document.querySelectorAll('#npo-lines > div').forEach(row => {
    const sel  = row.querySelector('select');
    const inputs = row.querySelectorAll('input[type="number"]');
    const partId = sel?.value;
    const qty  = parseInt(inputs[0]?.value) || 1;
    const cost = parseFloat(inputs[1]?.value) || 0;
    if (partId && partId !== '__new__') {
      const part = inventory.find(p => p.id === partId);
      lines.push({ partId, partName: part?.name || '—', sku: part?.sku || '—', qtyOrdered: qty, qtyReceived: 0, unitCost: cost });
    } else if (partId === '__new__') {
      lines.push({ partId: null, partName: 'New Part (TBD)', sku: '—', qtyOrdered: qty, qtyReceived: 0, unitCost: cost });
    }
  });
  if (!lines.length) { alert('Add at least one line item.'); return; }
  purchaseOrders.unshift({
    id: nextPONum(),
    supplier,
    created: new Date().toISOString().slice(0,10),
    expectedDate: document.getElementById('npo-date').value,
    status: 'Open',
    notes: document.getElementById('npo-notes').value.trim(),
    lines,
  });
  closeModalDirect();
  notify('Purchase Order created');
  renderPOTab(document.getElementById('parts-tab-content'));
}

function openPODetail(poId) {
  const po = purchaseOrders.find(p => p.id === poId);
  const total = po.lines.reduce((s,l) => s + l.qtyOrdered * l.unitCost, 0);
  const poStatusCls = { Open:'po-open', Partial:'po-partial', Received:'po-received', Cancelled:'po-cancelled' }[po.status] || 'po-open';

  openModal(po.id + ' — ' + po.supplier, `
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
      <div><div class="form-label">Status</div><span class="po-status ${poStatusCls}" style="margin-top:4px;display:inline-block;">${po.status}</span></div>
      <div><div class="form-label">Supplier</div><div style="font-size:13px;margin-top:4px;">${po.supplier}</div></div>
      <div><div class="form-label">Created</div><div style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;margin-top:4px;">${formatDate(po.created)}</div></div>
      <div><div class="form-label">Expected</div><div style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;margin-top:4px;">${formatDate(po.expectedDate)}</div></div>
      ${po.notes ? `<div style="width:100%;"><div class="form-label">Notes</div><div style="font-size:13px;color:var(--text-muted);margin-top:4px;">${po.notes}</div></div>` : ''}
    </div>
    <div style="border:1px solid var(--border);">
      <div style="display:grid;grid-template-columns:auto 1fr 80px 80px 90px 90px;gap:0;background:var(--surface2);padding:8px 14px;">
        <span class="form-label" style="margin-right:14px;">SKU</span>
        <span class="form-label">Part</span>
        <span class="form-label" style="text-align:right;">Ordered</span>
        <span class="form-label" style="text-align:right;">Received</span>
        <span class="form-label" style="text-align:right;">Unit Cost</span>
        <span class="form-label" style="text-align:right;">Line Total</span>
      </div>
      ${po.lines.map(l => `
        <div style="display:grid;grid-template-columns:auto 1fr 80px 80px 90px 90px;gap:0;padding:10px 14px;border-top:1px solid var(--border);align-items:center;">
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);margin-right:14px;">${l.sku}</span>
          <span style="font-size:13px;">${l.partName}</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;text-align:right;">${l.qtyOrdered}</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;text-align:right;color:${l.qtyReceived>=l.qtyOrdered?'var(--green)':l.qtyReceived>0?'var(--orange)':'var(--text-muted)'};">${l.qtyReceived}</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;text-align:right;">$${l.unitCost.toFixed(2)}</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;text-align:right;color:var(--accent);">$${(l.qtyOrdered*l.unitCost).toFixed(2)}</span>
        </div>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 90px;padding:10px 14px;border-top:1px solid var(--border);background:var(--bg);">
        <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">PO Total</span>
        <span style="font-family:\'IBM Plex Mono\',monospace;font-size:15px;font-weight:700;color:var(--accent);text-align:right;">$${total.toFixed(2)}</span>
      </div>
    </div>
    ${po.status !== 'Received' && po.status !== 'Cancelled' ? `
    <div style="margin-top:14px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">Ready to receive parts from this order?</span>
      <button class="btn btn-accent btn-sm" onclick="closeModalDirect();switchPartsTab('receiving');setTimeout(()=>openReceiveModal('${poId}'),100);">Receive Parts →</button>
    </div>` : ''}
  `, [
    { label: 'Close', cls: 'btn-ghost', action: closeModalDirect },
    ...(po.status !== 'Cancelled' && po.status !== 'Received' ? [{ label: 'Cancel PO', cls: 'btn-danger', action: () => { po.status='Cancelled'; closeModalDirect(); notify('PO cancelled'); renderPOTab(document.getElementById('parts-tab-content')); } }] : [])
  ]);
}

// ── RECEIVING TAB ────────────────────────────────────────────────
function renderReceivingTab(container) {
  const openPOs = purchaseOrders.filter(po => po.status === 'Open' || po.status === 'Partial');
  container.innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">Open Purchase Orders — Ready to Receive</div>
      ${openPOs.length ? openPOs.map(po => {
        const remaining = po.lines.reduce((s,l) => s + (l.qtyOrdered - l.qtyReceived), 0);
        const poStatusCls = po.status === 'Partial' ? 'po-partial' : 'po-open';
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--surface);border:1px solid var(--border);margin-bottom:1px;cursor:pointer;" onclick="openReceiveModal('${po.id}')" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='var(--surface)'">
            <div>
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);">${po.id}</span>
                <span class="po-status ${poStatusCls}">${po.status}</span>
              </div>
              <div style="font-size:14px;font-weight:500;">${po.supplier}</div>
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-top:3px;">Expected ${formatDate(po.expectedDate)} · ${po.lines.length} line${po.lines.length!==1?'s':''} · ${remaining} unit${remaining!==1?'s':''} outstanding</div>
            </div>
            <button class="btn btn-accent" onclick="event.stopPropagation();openReceiveModal('${po.id}')">Receive Parts →</button>
          </div>
        `;
      }).join('') : '<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">No open purchase orders to receive</div></div>'}
    </div>

    <div>
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">Recently Received</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>PO #</th><th>Supplier</th><th>Parts Received</th><th>Date</th><th>Status</th></tr></thead>
          <tbody>
            ${purchaseOrders.filter(po => po.status === 'Received').map(po => `
              <tr>
                <td class="td-mono" style="color:var(--accent)">${po.id}</td>
                <td class="td-primary">${po.supplier}</td>
                <td class="td-mono">${po.lines.reduce((s,l)=>s+l.qtyReceived,0)} units</td>
                <td class="td-mono">${formatDate(po.created)}</td>
                <td><span class="po-status po-received">Received</span></td>
              </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-dim);font-size:12px;">No completed receipts yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openReceiveModal(poId) {
  const po = purchaseOrders.find(p => p.id === poId);

  const linesHtml = po.lines.map((l, i) => {
    const outstanding = l.qtyOrdered - l.qtyReceived;
    const isNew = !l.partId;
    const existingPart = l.partId ? inventory.find(p => p.id === l.partId) : null;

    if (outstanding === 0) return `
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);opacity:0.4;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:13px;font-weight:500;">${l.partName}</div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);margin-top:2px;">${l.sku}</div>
          </div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--green);">✓ Fully received</div>
        </div>
      </div>`;

    return `
      <div id="recv-line-${i}" style="padding:14px;border-bottom:1px solid var(--border);background:var(--bg);">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;">
          <div>
            <div style="font-size:14px;font-weight:500;">${l.partName}</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:${isNew?'var(--orange)':'var(--accent)'};">${isNew ? '⚠ New part — no inventory record yet' : l.sku}</span>
              ${existingPart ? `<span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">Current stock: ${existingPart.qty}</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">
            Ordered: ${l.qtyOrdered}&nbsp;·&nbsp;Received: ${l.qtyReceived}&nbsp;·&nbsp;<span style="color:var(--orange);">Outstanding: ${outstanding}</span>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${isNew?'4px':'0'};">
          <label style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Receiving now:</label>
          <input type="number" id="recv-${i}" min="0" max="${outstanding}" value="${outstanding}"
            style="width:80px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-family:\'IBM Plex Mono\',monospace;font-size:13px;padding:6px 10px;outline:none;"
            onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"
            oninput="updateSKUPreviewQty(${i},this.value)">
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-dim);">of ${outstanding} outstanding</span>
        </div>

        ${isNew ? `
        <div style="margin-top:12px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;">
            <input type="checkbox" id="recv-create-${i}" checked onchange="toggleNewPartFields(${i})">
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Create inventory record for this part</span>
          </label>
          <div id="recv-newpart-fields-${i}">
            <!-- SKU Generator Widget -->
            <div style="background:var(--surface);border:1px solid var(--border);padding:12px 14px;margin-bottom:10px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);letter-spacing:1.5px;text-transform:uppercase;">⚡ Assign SKUs — Format: XXXX-XXXXXXXX</span>
                <button onclick="openProductLineManager()" style="background:none;border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;cursor:pointer;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Manage Product Lines</button>
              </div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">
                The <strong style="color:var(--text);">first 4 digits</strong> identify the product line (e.g. <span style="font-family:\'IBM Plex Mono\',monospace;color:var(--accent);">5555</span> = Standard iPhone 8 Screen).
                The <strong style="color:var(--text);">last 8 digits</strong> are unique serials that never repeat — each unit gets its own number.
              </div>
              <div style="display:grid;grid-template-columns:1fr 90px auto;gap:8px;align-items:flex-end;margin-bottom:10px;">
                <div>
                  <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Product Line</div>
                  <select class="form-select" id="recv-pl-${i}" style="font-family:\'IBM Plex Mono\',monospace;">
                    <option value="">— Select product line —</option>
                    ${productLines.map(pl=>`<option value="${pl.code}">${pl.code} — ${pl.description}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Or new code</div>
                  <input class="form-input" id="recv-pl-custom-${i}" maxlength="4" placeholder="0000"
                    style="font-family:\'IBM Plex Mono\',monospace;color:var(--accent);font-size:15px;letter-spacing:3px;text-align:center;"
                    oninput="this.value=this.value.replace(/\\D/g,'')">
                </div>
                <button onclick="previewSKUs(${i}, parseInt(document.getElementById('recv-${i}').value)||${outstanding})" class="btn btn-accent" style="height:36px;white-space:nowrap;">
                  ⚡ Generate SKUs
                </button>
              </div>
              <!-- SKU preview list -->
              <div id="recv-sku-preview-${i}" style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;min-height:16px;"></div>
            </div>
            <!-- Part details -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Cost ($)</div>
                <input class="form-input" id="recv-cost-${i}" type="number" placeholder="0.00" value="${l.unitCost||''}" style="width:100%;">
              </div>
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Sell Price ($)</div>
                <input class="form-input" id="recv-price-${i}" type="number" placeholder="0.00" style="width:100%;">
              </div>
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Min Qty Alert</div>
                <input class="form-input" id="recv-minqty-${i}" type="number" value="2" style="width:100%;">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Category</div>
                <select class="form-select" id="recv-cat-${i}" style="width:100%;">
                  ${PART_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}
                </select>
              </div>
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Bin / Location</div>
                <input class="form-input" id="recv-loc-${i}" placeholder="e.g. Bin A1" style="width:100%;">
              </div>
            </div>
          </div>
        </div>` : ''}
      </div>
    `;
  }).join('');

  openModal('Receive Parts — ' + poId, `
    <div style="margin-bottom:12px;padding:10px 14px;background:var(--bg);border:1px solid var(--border);display:flex;gap:20px;align-items:center;flex-wrap:wrap;">
      <div><span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Supplier </span><span style="font-size:13px;font-weight:500;">${po.supplier}</span></div>
      <div><span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Expected </span><span style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;">${formatDate(po.expectedDate)}</span></div>
    </div>
    <div style="border:1px solid var(--border);">
      <div style="background:var(--surface2);padding:8px 14px;font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;">
        Enter qty · Generate SKUs for new parts · Confirm
      </div>
      ${linesHtml}
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: '✓ Confirm Receipt', cls: 'btn-accent', action: () => confirmReceipt(poId) }
  ]);
}

function updateSKUPreviewQty(lineIdx, newQty) {
  // If SKUs were already generated, clear preview so user re-generates with correct qty
  const preview = document.getElementById('recv-sku-preview-' + lineIdx);
  if (preview && preview.dataset.skus) {
    preview.innerHTML = `<span style="color:var(--orange);font-size:10px;">⚠ Qty changed — click Generate SKUs again to update</span>`;
    delete preview.dataset.skus;
    delete preview.dataset.code;
  }
}

function toggleNewPartFields(lineIdx) {
  const cb = document.getElementById('recv-create-' + lineIdx);
  const fields = document.getElementById('recv-newpart-fields-' + lineIdx);
  if (fields) fields.style.display = cb.checked ? 'block' : 'none';
}

function confirmReceipt(poId) {
  const po = purchaseOrders.find(p => p.id === poId);
  let totalReceived = 0;
  let newPartsCreated = 0;

  po.lines.forEach((l, i) => {
    const qtyInput = document.getElementById('recv-' + i);
    if (!qtyInput) return;
    const qty = Math.min(parseInt(qtyInput.value) || 0, l.qtyOrdered - l.qtyReceived);
    if (qty <= 0) return;

    l.qtyReceived += qty;
    totalReceived += qty;

    if (l.partId) {
      // Existing part — just increment qty
      const part = inventory.find(p => p.id === l.partId);
      if (part) part.qty += qty;
    } else {
      // New part
      const createCb = document.getElementById('recv-create-' + i);
      if (!createCb || !createCb.checked) return;

      const preview  = document.getElementById('recv-sku-preview-' + i);
      const skusRaw  = preview?.dataset.skus;
      const plCode   = preview?.dataset.code;

      // Validate SKUs were generated
      if (!skusRaw || !plCode) {
        alert(`Line ${i+1} (${l.partName}): Please generate SKUs before confirming.`);
        // Roll back what we've done so far
        l.qtyReceived -= qty;
        totalReceived -= qty;
        return;
      }

      const skus     = JSON.parse(skusRaw);
      const cost     = parseFloat(document.getElementById('recv-cost-' + i)?.value)   || l.unitCost || 0;
      const price    = parseFloat(document.getElementById('recv-price-' + i)?.value)  || 0;
      const minQty   = parseInt(document.getElementById('recv-minqty-' + i)?.value)   || 2;
      const cat      = document.getElementById('recv-cat-' + i)?.value               || 'Other';
      const location = document.getElementById('recv-loc-' + i)?.value.trim()        || '—';
      const newId    = 'p' + Date.now() + i;

      // Use the first generated SKU as the "product SKU" for the inventory record
      // (the rest are individual unit serials under the same product line)
      const primarySKU = skus[0];

      const newPart = {
        id: newId,
        sku: primarySKU,
        productLine: plCode,
        name: l.partName,
        brand: 'Generic',
        category: cat,
        cost, price, qty, minQty, location,
        unitSkus: skus, // all individual unit serials
      };
      inventory.push(newPart);

      l.partId = newId;
      l.sku    = primarySKU;
      newPartsCreated++;
    }
  });

  const allReceived = po.lines.every(l => l.qtyReceived >= l.qtyOrdered);
  const anyReceived = po.lines.some(l => l.qtyReceived > 0);
  po.status = allReceived ? 'Received' : anyReceived ? 'Partial' : po.status;

  closeModalDirect();
  let msg = `✓ ${totalReceived} unit${totalReceived!==1?'s':''} received`;
  if (newPartsCreated) msg += ` · ${newPartsCreated} new part${newPartsCreated!==1?'s':''} added to inventory`;
  notify(msg);
  updateLowStockBadge();
  renderReceivingTab(document.getElementById('parts-tab-content'));
}

const SAMPLE_PARTS = inventory; // alias so WO parts search still works

let customers = [];

let workOrders = [];

let checkinStep = 1;
let checkinData = { customer: null, device: {}, issue: {}, estimate: {}, newCust: {} };
let viewingWO = null;
let viewingCust = null;

// ── UTILITIES ───────────────────────────────────────────────────
function notify(msg) {
  const n = document.getElementById('notif');
  n.textContent = msg;
  n.classList.add('show');
  setTimeout(() => n.classList.remove('show'), 2500);
  saveData();
}

function nextTicketNum() {
  const nums = workOrders.map(w => parseInt(w.id.replace('WO-','')));
  return 'WO-' + (Math.max(...nums, 1000) + 1);
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'});
}

function statusBadge(s) {
  const cls = STATUS_MAP[s] || 's-queue';
  return `<span class="status ${cls}">${s}</span>`;
}

function custName(id) {
  const c = customers.find(x => x.id === id);
  return c ? `${c.first} ${c.last}` : '—';
}

function custById(id) { return customers.find(x => x.id === id); }
function woById(id) { return workOrders.find(x => x.id === id); }

function woForCust(cid) { return workOrders.filter(w => w.customerId === cid); }

// ── LOGIN ───────────────────────────────────────────────────────
async function _activateSession(user) {
  currentUser = user;
  const rd = document.getElementById('role-display-topbar');
  if (rd) rd.textContent = user.name + ' · ' + user.role;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  applyRoleUI();
  await loadData();
  loadSettings();
  renderDashboard();
  renderStats();
  renderWOTable();
  updateLowStockBadge();
  if (user.forcePasswordChange) {
    notify('Please set a new admin password before continuing.');
    openChangeAdminPasswordModal();
  }
}

async function doLogin() {
  const username = (document.getElementById('login-user').value || '').trim();
  const password = document.getElementById('login-pass').value;
  const errEl    = document.getElementById('login-error');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errEl.textContent = err.error || 'Invalid username or password.';
      document.getElementById('login-pass').value = '';
      return;
    }
    const { user } = await res.json();
    errEl.textContent = '';
    await _activateSession(user);
  } catch (e) {
    errEl.textContent = 'Connection error — please try again.';
  }
}

function doLogout() {
  if (currentUser && getActiveClockEntry(currentUser.id)) {
    if (!confirm('You are still clocked in. Clock out before logging out?')) {
      // user said no — log out without clocking out (shift stays open)
    } else {
      clockOut();
    }
  }
  clearInterval(window._clockTick);
  currentUser = null;
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').textContent = '';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

// Hide / show nav items and features based on role
function applyRoleUI() {
  const admin = isAdmin();
  const mgr   = isAdminOrManager();
  // Settings: admin only
  const settingsBtn = document.getElementById('nav-settings-btn');
  if (settingsBtn) settingsBtn.style.display = admin ? '' : 'none';
  // Drawer + Reports: admin or manager
  ['nav-drawer-btn','nav-reports-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = mgr ? '' : 'none';
  });
  // Show clock button for all staff
  renderClockBtn();
}

// Admin PIN prompt — verified server-side via /api/auth/verify-pin.
// (storeSettings.adminPin from the API is a masked placeholder, never the real value.)
function requireAdminPIN(cb, actionLabel) {
  if (!storeSettings.adminPin) { cb(); return; } // no PIN configured — allow through
  openModal('Admin PIN Required', `
    <div style="text-align:center;padding:8px 0 16px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;">${actionLabel || 'Enter admin PIN to continue'}</div>
      <input type="password" id="admin-pin-input" maxlength="8" placeholder="PIN"
        style="width:120px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:22px;letter-spacing:8px;padding:10px;"
        oninput="document.getElementById('admin-pin-error').textContent=''"
        onkeydown="if(event.key==='Enter')confirmAdminPIN()">
      <div id="admin-pin-error" style="color:var(--red);font-family:'IBM Plex Mono',monospace;font-size:11px;margin-top:10px;min-height:16px;"></div>
    </div>
  `);
  window._adminPinCallback = cb;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
    <button class="btn btn-accent" onclick="confirmAdminPIN()">Confirm</button>
  `;
  setTimeout(() => { const el = document.getElementById('admin-pin-input'); if(el) el.focus(); }, 50);
}

async function confirmAdminPIN() {
  const entered = (document.getElementById('admin-pin-input')?.value || '').trim();
  let ok = false;
  try {
    const res = await fetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entered }),
    });
    const data = await res.json().catch(() => ({}));
    ok = !!data.ok;
  } catch (e) { ok = false; }

  if (!ok) {
    document.getElementById('admin-pin-error').textContent = 'Incorrect PIN.';
    document.getElementById('admin-pin-input').value = '';
    document.getElementById('admin-pin-input').focus();
    return;
  }
  closeModalDirect();
  if (typeof window._adminPinCallback === 'function') {
    window._adminPinCallback();
    window._adminPinCallback = null;
  }
}

// ── REFUND ──────────────────────────────────────────────────────
function openRefundModal(woId) {
  if (!isAdmin()) { notify('Admin access required.'); return; }
  const wo = woById(woId);
  if (!wo) return;
  requireAdminPIN(() => {
    const paid = wo.payment?.amount || 0;
    openModal('Issue Refund — ' + woId, `
      <div style="margin-bottom:16px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-muted);margin-bottom:4px;">Original Payment</div>
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--green);">$${paid.toFixed(2)} <span style="font-size:14px;font-weight:400;color:var(--text-muted);">${wo.payment?.method||''}</span></div>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Refund Amount ($)</label>
          <input class="form-input" id="ref-amount" type="number" min="0" step="0.01" value="${paid.toFixed(2)}">
        </div>
        <div class="form-group">
          <label class="form-label">Refund Method</label>
          <select class="form-select" id="ref-method">
            <option>Cash</option><option>Card</option><option>Venmo</option><option>Zelle</option><option>Other</option>
          </select>
        </div>
        <div class="form-group span2">
          <label class="form-label">Reason</label>
          <input class="form-input" id="ref-reason" placeholder="e.g. Customer complaint, repair unsuccessful…">
        </div>
      </div>
    `);
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
      <button class="btn btn-accent" style="border-color:var(--red);background:transparent;color:var(--red);" onclick="confirmRefund('${woId}')">Issue Refund</button>
    `;
  }, 'Issue refund requires admin PIN');
}

function confirmRefund(woId) {
  const wo = woById(woId);
  if (!wo) return;
  const amount  = parseFloat(document.getElementById('ref-amount').value) || 0;
  const method  = document.getElementById('ref-method').value;
  const reason  = document.getElementById('ref-reason').value.trim() || 'Refund';
  if (amount <= 0) { alert('Enter a valid refund amount.'); return; }
  const cust = custById(wo.customerId);
  cashEntries.push({
    id: 'refund-'+Date.now(), woId, customer: cust ? cust.first+' '+cust.last : '—',
    device: wo.device, method, amount: -amount, time: now(), type: 'refund',
    date: new Date().toISOString().slice(0,10),
  });
  wo.log.push({ time: now(), user: currentUser?.name||'Admin', type:'note', text:`Refund issued: $${amount.toFixed(2)} via ${method}. Reason: ${reason}` });
  closeModalDirect();
  saveData();
  notify('Refund of $' + amount.toFixed(2) + ' recorded ✓');
  renderWODetail();
}

// ── VOID / REOPEN WO ────────────────────────────────────────────
function openVoidWOModal(woId) {
  if (!isAdmin()) { notify('Admin access required.'); return; }
  const wo = woById(woId);
  if (!wo) return;
  requireAdminPIN(() => {
    openModal('Reopen / Void — ' + woId, `
      <div style="margin-bottom:16px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-muted);">Choose an action for this completed ticket.</div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button onclick="reopenWO('${woId}')" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:14px 18px;cursor:pointer;text-align:left;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
          ↺ Reopen — return to Repair In Progress
        </button>
        <button onclick="voidWO('${woId}')" style="background:var(--surface2);border:1px solid var(--border);color:var(--red);font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:14px 18px;cursor:pointer;text-align:left;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--red)'" onmouseout="this.style.borderColor='var(--border)'">
          ✕ Void — mark as voided (keeps record)
        </button>
      </div>
    `);
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
    `;
  }, 'Reopen/void requires admin PIN');
}

function reopenWO(woId) {
  const wo = woById(woId);
  if (!wo) return;
  wo.status = 'Repair In Progress';
  wo.payment = null;
  wo.log.push({ time: now(), user: currentUser?.name||'Admin', type:'status', text:'Ticket reopened by admin' });
  closeModalDirect();
  saveData();
  notify('Ticket reopened ✓');
  renderWODetail();
}

function voidWO(woId) {
  const wo = woById(woId);
  if (!wo) return;
  wo.status = 'Client Declined';
  wo.log.push({ time: now(), user: currentUser?.name||'Admin', type:'status', text:'Ticket voided by admin' });
  closeModalDirect();
  saveData();
  notify('Ticket voided ✓');
  renderWODetail();
}

// ── SIDEBAR ─────────────────────────────────────────────────────
let sidebarCollapsed = false;
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('collapsed', sidebarCollapsed);
  try { localStorage.setItem('smr_sidebar', sidebarCollapsed ? '1' : '0'); } catch(e){}
}
function loadSidebarState() {
  try {
    if (localStorage.getItem('smr_sidebar') === '1') {
      sidebarCollapsed = true;
      document.getElementById('sidebar').classList.add('collapsed');
    }
  } catch(e){}
}

// ── PAGE NAVIGATION ─────────────────────────────────────────────
const PAGE_LABELS = {
  'home': 'Dashboard',
  'work-orders': 'Work Orders',
  'customers': 'Customers',
  'checkin': 'Check-In',
  'parts': 'Parts',
  'drawer': 'Cash Drawer',
  'reports': 'Reports & Analytics',
  'settings': 'Store Settings',
};
function showPage(name, btn) {
  if (name === 'settings' && !isAdmin()) { notify('Admin access required.'); return; }
  if ((name === 'drawer' || name === 'reports') && !isAdminOrManager()) { notify('Manager access required.'); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  const lbl = document.getElementById('topbar-page-label');
  if (lbl) lbl.textContent = PAGE_LABELS[name] || name;

  if (name === 'work-orders') { renderStats(); renderWOTable(); }
  if (name === 'customers') renderCustomerTable();
  if (name === 'checkin') initCheckin();
  if (name === 'parts') { activePartsTab='inventory'; switchPartsTab('inventory'); }
  if (name === 'drawer') renderDrawerPage();
  if (name === 'home') renderDashboard();
  if (name === 'reports') renderReportsPage();
  if (name === 'settings') renderSettingsPage();
}

function showWODetail(woId) {
  viewingWO = woId;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const woBtn = document.getElementById('nav-wo-btn'); if(woBtn) woBtn.classList.add('active');
  document.getElementById('page-wo-detail').classList.add('active');
  const lbl = document.getElementById('topbar-page-label');
  if (lbl) lbl.textContent = 'Work Order Detail';
  renderWODetail();
}

function showCustDetail(custId) {
  viewingCust = custId;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.nav-btn:nth-child(2)').classList.add('active');
  document.getElementById('page-cust-detail').classList.add('active');
  const lbl = document.getElementById('topbar-page-label');
  if (lbl) lbl.textContent = 'Customer Detail';
  renderCustDetail();
}

// ── STATS ───────────────────────────────────────────────────────
function renderStats() {
  const open = workOrders.filter(w => w.status !== 'Completed').length;
  const ready = workOrders.filter(w => w.status === 'Repaired').length;
  const inProg = workOrders.filter(w => ['Repair In Progress','Diag In Progress'].includes(w.status)).length;
  const done = workOrders.filter(w => w.status === 'Completed').length;
  document.getElementById('stats-row').innerHTML = `
    <div class="stat-card">
      <div class="stat-num" style="color:var(--cyan)">${open}</div>
      <div class="stat-label">Open Repairs</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:var(--green)">${ready}</div>
      <div class="stat-label">Ready for Pickup</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:var(--accent)">${inProg}</div>
      <div class="stat-label">In Progress</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:var(--text-muted)">${done}</div>
      <div class="stat-label">Completed</div>
    </div>
  `;

  // Render filter slots
  renderFilterButtons();
}

// ── FILTER SYSTEM — 4 configurable slots ────────────────────────
// Each slot shows a specific status group. Click a slot to swap
// what it shows using a dropdown. One slot is "active" (highlighted)
// — that determines what the table displays.

// All available options for the picker
const SLOT_OPTIONS = [
  { label: 'Awaiting Repair',     statuses: ['Repair Queue'] },
  { label: 'Repair in Progress',  statuses: ['Diag In Progress', 'Repair In Progress'] },
  { label: 'Need to Order Parts', statuses: ['Ordering Parts', 'Parts Ordered', 'Awaiting Parts'] },
  { label: 'Updated Today',       statuses: '__today__' },
  // individual statuses users can swap in
  { label: 'Repair Queue',        statuses: ['Repair Queue'] },
  { label: 'Diag In Progress',    statuses: ['Diag In Progress'] },
  { label: 'Repair In Progress',  statuses: ['Repair In Progress'] },
  { label: 'Ordering Parts',      statuses: ['Ordering Parts'] },
  { label: 'Parts Ordered',       statuses: ['Parts Ordered'] },
  { label: 'Awaiting Parts',      statuses: ['Awaiting Parts'] },
  { label: 'Repaired',            statuses: ['Repaired'] },
  { label: 'Unrepairable',        statuses: ['Unrepairable'] },
  { label: 'Client Declined',     statuses: ['Client Declined'] },
  { label: 'Completed',           statuses: ['Completed'] },
];

// The 4 active slots — label must match a SLOT_OPTIONS entry
let filterSlots = [
  'Awaiting Repair',
  'Repair in Progress',
  'Need to Order Parts',
  'Updated Today',
];

let activeSlot    = 0;      // which slot is currently selected (drives table)
let openSlotIdx   = null;   // which slot's dropdown is open
let activeFilter  = 'All';  // kept for renderWOTable compat
let moreFiltersOpen = false; // kept so old refs don't break

function renderFilterButtons() {
  const el = document.getElementById('filter-chips');
  if (!el) return;
  el.innerHTML = filterSlots.map((label, i) => `
    <div style="position:relative;display:inline-block;">
      <button
        class="filter-btn ${activeSlot === i ? 'active' : ''}"
        onclick="selectSlot(${i}, event)"
        oncontextmenu="openSlotPicker(${i}, event);return false;"
        style="display:flex;align-items:center;gap:6px;padding-right:10px;"
      >
        <span>${label}</span>
        <span onclick="openSlotPicker(${i}, event)" style="opacity:0.5;font-size:10px;margin-left:2px;cursor:pointer;" title="Change this slot">▾</span>
      </button>
    </div>
  `).join('');
}

function selectSlot(idx, event) {
  // If clicking the chevron, open picker instead
  if (event && event.target.tagName === 'SPAN' && event.target.textContent === '▾') return;
  activeSlot = idx;
  activeFilter = filterSlots[idx];
  closeSlotDropdown();
  renderFilterButtons();
  renderWOTable();
}

function openSlotPicker(idx, event) {
  event.stopPropagation();
  // If same slot already open, close it
  if (openSlotIdx === idx) { closeSlotDropdown(); return; }
  openSlotIdx = idx;

  const dropdown = document.getElementById('slot-dropdown');
  const opts     = document.getElementById('slot-dropdown-options');
  const current  = filterSlots[idx];

  opts.innerHTML = SLOT_OPTIONS.map(opt => {
    const isCurrent = opt.label === current;
    const inUse     = filterSlots.includes(opt.label) && !isCurrent;
    return `
      <div onclick="${inUse ? '' : `assignSlot(${idx},'${opt.label}')`}"
        style="padding:9px 16px;cursor:${inUse?'default':'pointer'};display:flex;align-items:center;justify-content:space-between;gap:12px;
               background:${isCurrent?'var(--surface2)':'transparent'};
               opacity:${inUse?'0.35':'1'};
               transition:background 0.1s;"
        ${inUse?'':'onmouseover="this.style.background=\'var(--surface2)\'"'}
        onmouseout="this.style.background='${isCurrent?'var(--surface2)':'transparent'}'">
        <span style="font-size:13px;${isCurrent?'color:var(--accent);font-weight:600;':''}">${opt.label}</span>
        ${isCurrent ? '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--accent);">current</span>' : ''}
        ${inUse ? '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-dim);">in use</span>' : ''}
      </div>`;
  }).join('');

  // Position the dropdown under the clicked button
  const btn = document.querySelectorAll('#filter-chips .filter-btn')[idx];
  if (btn) {
    const rect = btn.getBoundingClientRect();
    dropdown.style.top  = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
  }
  dropdown.style.display = 'block';
}

function assignSlot(idx, label) {
  filterSlots[idx] = label;
  // If the active slot was changed, update what the table shows
  if (activeSlot === idx) activeFilter = label;
  closeSlotDropdown();
  renderFilterButtons();
  renderWOTable();
}

function closeSlotDropdown() {
  openSlotIdx = null;
  const d = document.getElementById('slot-dropdown');
  if (d) d.style.display = 'none';
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const d = document.getElementById('slot-dropdown');
  if (d && d.style.display !== 'none' && !d.contains(e.target)) {
    closeSlotDropdown();
  }
});

function toggleMoreFilters() {} // no-op, kept so old refs don't break
function setFilter(s) { activeFilter = s; renderFilterButtons(); renderWOTable(); }

// ── WORK ORDER TABLE ─────────────────────────────────────────────
function renderWOTable() {
  const q     = (document.getElementById('wo-search')?.value || '').toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  let rows    = workOrders;

  // Find the option for the active slot
  const slotLabel  = filterSlots[activeSlot];
  const slotOption = SLOT_OPTIONS.find(o => o.label === slotLabel);

  if (slotOption) {
    if (slotOption.statuses === '__today__') {
      rows = rows.filter(w => w.log.some(l => l.time.startsWith(today)));
    } else {
      rows = rows.filter(w => slotOption.statuses.includes(w.status));
    }
  }

  if (q) rows = rows.filter(w =>
    w.id.toLowerCase().includes(q) ||
    custName(w.customerId).toLowerCase().includes(q) ||
    w.device.toLowerCase().includes(q)
  );

  const tbody = document.getElementById('wo-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-icon">📋</div><div class="empty-text">No work orders found</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(w => {
    const partsTotal = w.parts.reduce((s,p) => s + p.cost, 0);
    const partsInfo = w.parts.length
      ? `<span style="color:var(--accent);font-family:\'IBM Plex Mono\',monospace;">${w.parts.length} · $${partsTotal.toFixed(2)}</span>`
      : `<span style="color:var(--text-dim);">—</span>`;
    return `
    <tr onclick="showWODetail('${esc(w.id)}')">
      <td class="td-mono">${esc(w.id)}</td>
      <td class="td-primary">${esc(custName(w.customerId))}</td>
      <td>${esc(w.device)}</td>
      <td>${statusBadge(w.status)}</td>
      <td class="td-mono" style="color:var(--text-muted)">${esc(w.tech)}</td>
      <td style="font-size:12px;">${partsInfo}</td>
      <td class="td-mono">${formatDate(w.created)}</td>
    </tr>`;
  }).join('');
}

// ── WORK ORDER DETAIL ────────────────────────────────────────────
function renderWODetail() {
  const wo = woById(viewingWO);
  if (!wo) return;
  const cust = custById(wo.customerId);
  const partsTotal = wo.parts.reduce((s, p) => s + p.cost, 0);

  const partsList = wo.parts.length
    ? wo.parts.map((p, i) => `
        <div class="part-row">
          <span class="part-name">${p.name}</span>
          <span class="part-cost">$${p.cost.toFixed(2)}</span>
          <button class="part-remove" title="Remove part" onclick="removePart('${wo.id}',${i})">×</button>
        </div>`).join('')
    : '<div style="color:var(--text-dim);font-size:12px;padding:12px 0 4px;">No parts added yet.</div>';

  const logHtml = [...wo.log].reverse().map(e => `
    <div class="log-entry">
      <div class="log-dot ${e.type==='status'?'accent':'blue'}"></div>
      <div>
        <div class="log-meta">${e.time} · ${e.user}</div>
        <div class="log-text">${e.text}</div>
      </div>
    </div>`).join('');

  const statusOptions = STATUS_LIST.filter(s => s !== 'Completed').map(s =>
    `<option ${wo.status===s?'selected':''} value="${s}">${s}</option>`
  ).join('');

  const techOptions = getTechs().map(t =>
    `<option ${wo.tech===t?'selected':''} value="${t}">${t}</option>`
  ).join('');

  document.getElementById('wo-detail-content').innerHTML = `
    ${wo.status === 'Completed' ? `
    <div style="background:#0d1a00;border:1px solid var(--accent-dim);padding:12px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <div>
          <span style="font-family:'Syne',sans-serif;font-weight:700;font-size:14px;color:var(--accent);">COMPLETED — This ticket is locked</span>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent-dim);margin-top:2px;">
            ${wo.payment ? `Payment: $${wo.payment.amount.toFixed(2)} via ${wo.payment.method} · ` : ''}
            ${wo.warranty?.hasWarranty && wo.warranty?.startDate ? `Warranty: ${wo.warranty.days} days · expires ${formatDate(warrantyExpiry(wo))}` : 'No warranty'}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="openWarrantyRepair('${wo.id}')" style="background:var(--surface2);border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:8px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--orange)';this.style.color='var(--orange)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Create Warranty Repair
        </button>
        ${isAdmin() ? `
        <button onclick="openRefundModal('${wo.id}')" style="background:var(--surface2);border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:8px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--red)';this.style.color='var(--red)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          ↩ Refund
        </button>
        <button onclick="openVoidWOModal('${wo.id}')" style="background:var(--surface2);border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:8px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--orange)';this.style.color='var(--orange)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          ↺ Reopen / Void
        </button>` : ''}
      </div>
    </div>` : ''}

    <!-- TOP BAR -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;letter-spacing:-0.3px;">
          ${wo.id} <span style="font-weight:400;color:var(--text-muted);font-size:16px">· ${wo.device}</span>
        </div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);letter-spacing:1.5px;text-transform:uppercase;margin-top:3px;">
          Created ${formatDate(wo.created)}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${statusBadge(wo.status)}
      </div>
    </div>

    <!-- TOP ROW: Info panel (left) + Actions panel (right) -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:1px;">

      <!-- TOP-LEFT: Customer name, device info, email button -->
      <div style="background:var(--surface);padding:20px 22px;display:flex;flex-direction:column;gap:0;">
        <!-- Customer name + edit icon -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.3px;">${cust ? cust.first+' '+cust.last : '—'}</div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;margin-top:2px;">${cust?.phone||'—'}</div>
          </div>
          <!-- Customer icon / edit -->
          <button onclick="openEditCustModal('${cust?.id}')" title="Edit customer info" style="background:var(--surface2);border:1px solid var(--border);color:var(--text-muted);width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;transition:all 0.15s;border-radius:2px;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
            👤
          </button>
        </div>

        <!-- Device info -->
        <div style="background:var(--bg);border:1px solid var(--border);padding:12px 14px;margin-bottom:14px;">
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">Device Info</div>
          <div class="info-row" style="padding:5px 0;"><span class="info-key">Model</span><span class="info-val">${wo.device}</span></div>
          <div class="info-row" style="padding:5px 0;"><span class="info-key">Type</span><span class="info-val">${wo.device.toLowerCase().includes('macbook')||wo.device.toLowerCase().includes('laptop')?'Laptop':wo.device.toLowerCase().includes('ipad')||wo.device.toLowerCase().includes('tablet')?'Tablet':'Phone'}</span></div>
          <div class="info-row" style="padding:5px 0;"><span class="info-key">IMEI/Serial</span><span class="info-val mono">${wo.imei||'—'}</span></div>
          <div class="info-row" style="padding:5px 0;border-bottom:none;">
            <span class="info-key">Passcode</span>
            <span class="info-val" style="display:flex;align-items:center;gap:8px;">
              <span id="passcode-val" style="font-family:\'IBM Plex Mono\',monospace;letter-spacing:2px;">${wo.passcode ? '••••••' : '—'}</span>
              ${wo.passcode ? `<button onclick="togglePasscode('${wo.passcode}')" id="passcode-toggle" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;border:1px solid var(--border);" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-dim)'">Show</button>` : ''}
            </span>
          </div>
        </div>

        <!-- Issue summary -->
        <div style="background:var(--bg);border:1px solid var(--border);padding:10px 14px;margin-bottom:14px;">
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">Issue</div>
          <div style="font-size:13px;color:var(--text);line-height:1.5;">${wo.issue}</div>
          ${wo.damage && wo.damage !== 'None' && wo.damage !== 'None noted' ? `<div style="margin-top:8px;font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--orange);">⚠ Pre-existing: ${wo.damage}</div>` : ''}
        </div>

        <!-- Send email button -->
        <button onclick="openEmailModal('${wo.id}')" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;cursor:pointer;text-align:left;transition:all 0.15s;display:flex;align-items:center;gap:10px;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          <span style="font-size:16px;">✉</span> Send Email to Client
        </button>
      </div>

      <!-- TOP-RIGHT: Status, tech, icon action buttons -->
      <div style="background:var(--surface);padding:20px 22px;display:flex;flex-direction:column;gap:20px;">

        <!-- Status + Tech row — locked if Completed -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <label class="form-label">Status</label>
            ${wo.status === 'Completed'
              ? `<div style="background:var(--bg);border:1px solid var(--border);padding:9px 12px;font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:var(--text-dim);cursor:not-allowed;">🔒 Completed</div>`
              : `<select class="form-select" onchange="updateStatus('${wo.id}',this.value)">${statusOptions}</select>`
            }
          </div>
          <div class="form-group">
            <label class="form-label">Technician</label>
            ${wo.status === 'Completed'
              ? `<div style="background:var(--bg);border:1px solid var(--border);padding:9px 12px;font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:var(--text-dim);cursor:not-allowed;">${wo.tech}</div>`
              : `<select class="form-select" onchange="updateTech('${wo.id}',this.value)">${techOptions}</select>`
            }
          </div>
        </div>

        <!-- Warranty panel (always visible) -->
        ${(() => {
          const w = wo.warranty || { hasWarranty: false, days: 0, startDate: null };
          const expired = w.hasWarranty && w.startDate && new Date() > new Date(warrantyExpiry(wo));
          const active  = w.hasWarranty && w.startDate && !expired;
          const pending = w.hasWarranty && !w.startDate;
          return `
          <div style="background:var(--bg);border:1px solid ${active?'var(--green)':expired?'var(--red)':pending?'var(--border)':'var(--border)'};padding:12px 14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${w.hasWarranty?'8px':'0'};">
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;display:flex;align-items:center;gap:6px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Warranty
              </div>
              ${wo.status !== 'Completed' ? `<button onclick="openEditWarranty('${wo.id}')" style="background:none;border:1px solid var(--border);color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;cursor:pointer;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Edit</button>` : ''}
            </div>
            ${w.hasWarranty ? `
              <div style="font-size:13px;font-weight:600;color:${active?'var(--green)':expired?'var(--red)':'var(--text-muted)'};">
                ${active ? '✓ Active' : expired ? '✗ Expired' : '⏳ Starts on completion'} · ${w.days} days
              </div>
              ${w.startDate ? `<div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-top:3px;">
                ${formatDate(w.startDate)} → ${formatDate(warrantyExpiry(wo))}
              </div>` : ''}
            ` : `<div style="font-size:12px;color:var(--text-dim);">No warranty on this repair</div>`}
          </div>`;
        })()}

        <!-- Icon action buttons grid — some locked if Completed -->
        <div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">Actions</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">

            <!-- Notes & Log -->
            <button onclick="openNotesPopup('${wo.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;position:relative;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Notes</span>
              ${wo.log.length ? `<span style="position:absolute;top:8px;right:8px;background:var(--accent);color:#000;font-family:\'IBM Plex Mono\',monospace;font-size:9px;font-weight:700;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;">${wo.log.length}</span>` : ''}
            </button>

            <!-- Status History -->
            <button onclick="openHistoryPopup('${wo.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">History</span>
            </button>

            <!-- Edit Customer -->
            <button onclick="openEditCustModal('${cust?.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Customer</span>
            </button>

            <!-- Send Email -->
            <button onclick="openEmailModal('${wo.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Email</span>
            </button>

            <!-- Print / Receipt -->
            <button onclick="openPrintTicket('${wo.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Print</span>
            </button>

            <!-- Sale Complete / Locked -->
            ${wo.status === 'Completed'
              ? `<button onclick="openWarrantyRepair('${wo.id}')" style="background:var(--bg);border:1px solid var(--orange);color:var(--orange);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.background='#1a0f00'" onmouseout="this.style.background='var(--bg)'">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Warranty</span>
              </button>`
              : `<button onclick="markSaleComplete('${wo.id}')" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;">Sale Done</span>
              </button>`
            }

          </div>
        </div>
      </div>
    </div>

    <!-- BOTTOM: Parts panel — locked if Completed -->
    <div style="background:var(--surface);border:1px solid var(--border);border-top:none;padding:20px 22px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;">Repair Parts</div>
        ${wo.status !== 'Completed' ? `
        <div style="display:flex;gap:6px;flex:1;">
          <input type="text" id="part-search-input" placeholder="Search parts to add…" style="flex:1;max-width:320px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:\'IBM Plex Mono\',monospace;font-size:12px;padding:7px 12px;outline:none;" onkeyup="showPartSuggestions(this.value)" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'">
          <button class="btn btn-ghost btn-sm" onclick="addPartFromInput('${wo.id}')">+ Add</button>
        </div>` : `<div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">🔒 Locked — ticket closed</div>`}
        <div style="margin-left:auto;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">
          Est. Cost: <span style="color:var(--accent);font-size:13px;font-weight:600;">$${wo.estimate.toFixed(2)}</span>
          &nbsp;·&nbsp; Deposit: <span style="color:var(--text)">$${wo.deposit.toFixed(2)}</span>
          &nbsp;·&nbsp; Turnaround: <span style="color:var(--text)">${wo.turnaround}</span>
        </div>
      </div>

      <div id="part-suggestions" style="margin-bottom:6px;"></div>

      <div style="border:1px solid var(--border);">
        <div style="display:grid;grid-template-columns:1fr 140px ${wo.status!=='Completed'?'40px':''};background:var(--surface2);border-bottom:1px solid var(--border);padding:7px 14px;">
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;">Part Name</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;text-align:right;">Price</span>
          ${wo.status!=='Completed'?'<span></span>':''}
        </div>
        ${wo.parts.length ? wo.parts.map((p, i) => `
          <div style="display:grid;grid-template-columns:1fr 140px ${wo.status!=='Completed'?'40px':''};padding:10px 14px;border-bottom:1px solid var(--border);align-items:center;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
            <span style="font-size:13px;">${p.name}</span>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);text-align:right;">$${p.cost.toFixed(2)}</span>
            ${wo.status!=='Completed'?`<button onclick="removePart('${wo.id}',${i})" title="Remove" style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;text-align:center;line-height:1;transition:color 0.15s;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">×</button>`:''}
          </div>`).join('')
        : `<div style="padding:20px 14px;color:var(--text-dim);font-size:13px;text-align:center;">No parts on this repair</div>`}
        <div style="display:grid;grid-template-columns:1fr 140px ${wo.status!=='Completed'?'40px':''};padding:10px 14px;background:var(--bg);border-top:1px solid var(--border);">
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Total Parts Cost</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:15px;color:var(--accent);font-weight:700;text-align:right;">$${partsTotal.toFixed(2)}</span>
          ${wo.status!=='Completed'?'<span></span>':''}
        </div>
      </div>
    </div>
  `;
}

function showPartSuggestions(q) {
  const el = document.getElementById('part-suggestions');
  if (!q || q.length < 2) { el.innerHTML=''; return; }
  const matches = inventory.filter(p => p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase()));
  el.innerHTML = matches.map(p => {
    const qtyColor = p.qty === 0 ? 'var(--red)' : p.qty <= p.minQty ? 'var(--orange)' : 'var(--green)';
    return `
    <div onclick="selectPart('${p.name}',${p.price})" style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);cursor:pointer;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;gap:12px;transition:background 0.1s;" onmouseover="this.style.background='#222'" onmouseout="this.style.background='var(--bg)'">
      <div>
        <div style="font-size:13px;">${p.name}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);margin-top:2px;">${p.sku}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--accent);">$${p.price.toFixed(2)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:${qtyColor};">Qty: ${p.qty}</div>
      </div>
    </div>`;
  }).join('') || `<div style="padding:8px 12px;color:var(--text-dim);font-size:12px;font-family:\'IBM Plex Mono\',monospace;">No matching parts in inventory</div>`;
}

function openNotesPopup(woId) {
  const wo = woById(woId);
  const logHtml = [...wo.log].reverse().map(e => `
    <div class="log-entry">
      <div class="log-dot ${e.type==='status'?'accent':'blue'}"></div>
      <div>
        <div class="log-meta">${e.time} · ${e.user}</div>
        <div class="log-text">${e.text}</div>
      </div>
    </div>`).join('') || '<div style="padding:16px 0;color:var(--text-dim);font-size:12px;text-align:center;">No notes yet.</div>';

  openModal('Notes — ' + woId, `
    <div style="margin-bottom:14px;">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">Add Note</div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="popup-note-input" placeholder="Type a note…" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:'IBM Plex Sans',sans-serif;font-size:13px;padding:9px 12px;outline:none;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'" onkeydown="if(event.key==='Enter')addNoteFromPopup('${woId}')">
        <button class="btn btn-accent" onclick="addNoteFromPopup('${woId}')">Post</button>
      </div>
    </div>
    <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">Activity Log</div>
    <div id="notes-popup-log" style="max-height:340px;overflow-y:auto;border:1px solid var(--border);background:var(--bg);padding:4px 14px;">
      ${logHtml}
    </div>
  `, [
    { label: 'Close', cls: 'btn-ghost', action: closeModalDirect }
  ]);
}

function addNoteFromPopup(woId) {
  const wo = woById(woId);
  const input = document.getElementById('popup-note-input');
  const text = input.value.trim();
  if (!text) return;
  wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'note', text });
  input.value = '';
  // Re-render log inside popup
  const logHtml = [...wo.log].reverse().map(e => `
    <div class="log-entry">
      <div class="log-dot ${e.type==='status'?'accent':'blue'}"></div>
      <div>
        <div class="log-meta">${e.time} · ${e.user}</div>
        <div class="log-text">${e.text}</div>
      </div>
    </div>`).join('');
  document.getElementById('notes-popup-log').innerHTML = logHtml;
  // Update badge on detail page without closing modal
  renderStats();
  notify('Note added');
}

function openHistoryPopup(woId) {
  const wo = woById(woId);
  const statusEvents = [...wo.log].filter(e => e.type === 'status').reverse();
  const rows = statusEvents.length
    ? statusEvents.map(e => `
        <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);margin-top:5px;flex-shrink:0;"></div>
          <div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-bottom:2px;">${e.time} · ${e.user}</div>
            <div style="font-size:13px;">${e.text}</div>
          </div>
        </div>`).join('')
    : '<div style="padding:20px 0;color:var(--text-dim);font-size:12px;text-align:center;">No status changes recorded yet.</div>';

  openModal('Status History — ' + woId, `
    <div style="max-height:420px;overflow-y:auto;">
      ${rows}
    </div>
  `, [
    { label: 'Close', cls: 'btn-ghost', action: closeModalDirect }
  ]);
}

// ── PASSCODE TOGGLE ──────────────────────────────────────────────
function togglePasscode(code) {
  const val = document.getElementById('passcode-val');
  const btn = document.getElementById('passcode-toggle');
  if (!val || !btn) return;
  if (val.textContent === '••••••') {
    val.textContent = code;
    val.style.color = 'var(--accent)';
    btn.textContent = 'Hide';
  } else {
    val.textContent = '••••••';
    val.style.color = '';
    btn.textContent = 'Show';
  }
}

// ── PRINT TICKET ─────────────────────────────────────────────────
function openPrintTicket(woId) {
  const wo = woById(woId);
  const cust = custById(wo.customerId);
  const partsTotal = wo.parts.reduce((s,p) => s + p.cost, 0);
  const balance = Math.max(0, wo.estimate - wo.deposit);
  const custFullName = cust ? cust.first + ' ' + cust.last : '—';

  openModal('Print — ' + wo.id, `
    <div style="display:flex;gap:10px;margin-bottom:16px;">
      <button onclick="switchPrintTab('receipt')" id="ptab-receipt" style="flex:1;padding:10px;background:var(--accent);color:#000;border:none;font-family:\'IBM Plex Mono\',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-weight:700;">🖨 Receipt</button>
      <button onclick="switchPrintTab('sticker')" id="ptab-sticker" style="flex:1;padding:10px;background:var(--surface2);color:var(--text-muted);border:1px solid var(--border);font-family:\'IBM Plex Mono\',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;">🏷 Device Sticker</button>
    </div>

    <!-- RECEIPT TAB -->
    <div id="print-tab-receipt">
      <div style="background:var(--bg);border:1px solid var(--border);padding:8px 12px;margin-bottom:10px;font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);">
        ↳ Formatted for 80mm thermal receipt printer (3.15 in width)
      </div>
      <div style="display:flex;justify-content:center;">
        <div id="receipt-area" style="background:#fff;color:#000;width:302px;padding:14px 16px;font-family:'Courier New',Courier,monospace;font-size:11.5px;line-height:1.55;border:1px dashed #ccc;">
          <div style="text-align:center;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:900;letter-spacing:1px;">STONE MTN DEVICE REPAIR</div>
            <div style="font-size:9px;letter-spacing:2px;color:#666;margin-top:1px;">REPAIR RECEIPT</div>
            <div style="border-bottom:1px dashed #999;margin:8px 0;"></div>
          </div>

          <div style="font-size:10px;color:#555;margin-bottom:2px;">TICKET</div>
          <div style="font-weight:bold;font-size:13px;margin-bottom:6px;">${wo.id}</div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#555;margin-bottom:8px;">
            <span>${formatDate(wo.created)}</span><span>Tech: ${wo.tech}</span>
          </div>

          <div style="border-top:1px dashed #ccc;padding-top:7px;margin-bottom:7px;">
            <div style="font-size:10px;color:#555;margin-bottom:2px;">CUSTOMER</div>
            <div style="font-weight:bold;">${custFullName}</div>
            <div style="font-size:10px;">${cust?.phone||'—'}</div>
            ${cust?.email ? `<div style="font-size:10px;">${cust.email}</div>` : ''}
          </div>

          <div style="border-top:1px dashed #ccc;padding-top:7px;margin-bottom:7px;">
            <div style="font-size:10px;color:#555;margin-bottom:2px;">DEVICE</div>
            <div style="font-weight:bold;">${wo.device}</div>
            <div style="font-size:10px;">IMEI/SN: ${wo.imei||'—'}</div>
          </div>

          <div style="border-top:1px dashed #ccc;padding-top:7px;margin-bottom:7px;">
            <div style="font-size:10px;color:#555;margin-bottom:2px;">ISSUE</div>
            <div style="font-size:10.5px;line-height:1.4;">${wo.issue}</div>
            ${wo.damage && wo.damage !== 'None' && wo.damage !== 'None noted' ? `<div style="font-size:10px;color:#c00;margin-top:3px;">⚠ Pre-existing: ${wo.damage}</div>` : ''}
          </div>

          ${wo.parts.length ? `
          <div style="border-top:1px dashed #ccc;padding-top:7px;margin-bottom:7px;">
            <div style="font-size:10px;color:#555;margin-bottom:4px;">PARTS</div>
            ${wo.parts.map(p => `
            <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:2px;">
              <span style="flex:1;padding-right:8px;">${p.name}</span>
              <span>$${p.cost.toFixed(2)}</span>
            </div>`).join('')}
            <div style="display:flex;justify-content:space-between;font-size:10.5px;font-weight:bold;border-top:1px dashed #ccc;margin-top:4px;padding-top:4px;">
              <span>Parts Total</span><span>$${partsTotal.toFixed(2)}</span>
            </div>
          </div>` : ''}

          <div style="border-top:1px dashed #ccc;padding-top:7px;margin-bottom:4px;">
            <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:2px;">
              <span>Estimate</span><span>$${wo.estimate.toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:2px;">
              <span>Deposit Paid</span><span>-$${wo.deposit.toFixed(2)}</span>
            </div>
          </div>

          <div style="border-top:2px solid #000;padding-top:6px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:900;">
              <span>BALANCE DUE</span><span>$${balance.toFixed(2)}</span>
            </div>
          </div>

          <div style="border-top:1px dashed #ccc;padding-top:8px;text-align:center;">
            <div style="font-size:9px;color:#666;">Est. Turnaround: ${wo.turnaround}</div>
            <div style="font-size:9px;color:#666;margin-top:2px;">Thank you for choosing Stone MTN!</div>
            <div style="font-size:9px;color:#666;">Questions? Call us anytime.</div>
            <!-- Simulated barcode -->
            <div style="margin:8px auto 0;display:flex;justify-content:center;gap:1px;height:28px;align-items:flex-end;">
              ${generateBarcodeBars(wo.id)}
            </div>
            <div style="font-size:8px;letter-spacing:2px;margin-top:2px;">${wo.id}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- STICKER TAB -->
    <div id="print-tab-sticker" style="display:none;">
      <div style="background:var(--bg);border:1px solid var(--border);padding:8px 12px;margin-bottom:10px;font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);">
        ↳ Formatted for 2" × 1" label sticker · goes on back of device
      </div>
      <div style="display:flex;justify-content:center;">
        <div id="sticker-area" style="background:#fff;color:#000;width:192px;height:96px;padding:8px 10px;font-family:'Courier New',Courier,monospace;border:1px dashed #ccc;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:7px;color:#666;letter-spacing:1px;text-transform:uppercase;">Stone MTN Repair</div>
              <div style="font-size:13px;font-weight:900;letter-spacing:0.5px;margin-top:1px;">${wo.id}</div>
              <div style="font-size:8.5px;font-weight:bold;margin-top:1px;">${custFullName}</div>
              <div style="font-size:7px;color:#444;margin-top:1px;">${wo.device.length > 22 ? wo.device.slice(0,22)+'…' : wo.device}</div>
            </div>
          </div>
          <!-- Barcode bottom -->
          <div style="text-align:center;">
            <div style="display:flex;justify-content:center;gap:0.8px;height:20px;align-items:flex-end;margin-bottom:1px;">
              ${generateBarcodeBars(wo.id, true)}
            </div>
            <div style="font-size:6px;letter-spacing:1.5px;">${wo.id}</div>
          </div>
        </div>
      </div>
    </div>
  `, [
    { label: 'Close', cls: 'btn-ghost', action: closeModalDirect },
    { label: '🖨 Print', cls: 'btn-accent', action: () => printCurrentTab(wo.id, custFullName, wo.device) }
  ]);
}

function switchPrintTab(tab) {
  document.getElementById('print-tab-receipt').style.display = tab === 'receipt' ? 'block' : 'none';
  document.getElementById('print-tab-sticker').style.display = tab === 'sticker' ? 'block' : 'none';
  document.getElementById('ptab-receipt').style.background   = tab === 'receipt' ? 'var(--accent)' : 'var(--surface2)';
  document.getElementById('ptab-receipt').style.color        = tab === 'receipt' ? '#000' : 'var(--text-muted)';
  document.getElementById('ptab-receipt').style.border       = tab === 'receipt' ? 'none' : '1px solid var(--border)';
  document.getElementById('ptab-sticker').style.background   = tab === 'sticker' ? 'var(--accent)' : 'var(--surface2)';
  document.getElementById('ptab-sticker').style.color        = tab === 'sticker' ? '#000' : 'var(--text-muted)';
  document.getElementById('ptab-sticker').style.border       = tab === 'sticker' ? 'none' : '1px solid var(--border)';
}

// Generates visual barcode bars from a string (Code 39 style visual sim)
function generateBarcodeBars(str, compact) {
  const barH = compact ? '20px' : '28px';
  const minW = compact ? '1px' : '1.5px';
  const maxW = compact ? '2px' : '3px';
  // Seed bars from char codes for consistent output per WO id
  let bars = '';
  const chars = (str + '00000000').replace(/\W/g,'');
  for (let i = 0; i < (compact ? 52 : 68); i++) {
    const code = chars.charCodeAt(i % chars.length);
    const wide = (code + i) % 3 === 0;
    const gap  = (code + i) % 5 === 0;
    bars += `<div style="background:${gap?'transparent':'#000'};width:${wide ? maxW : minW};height:${barH};flex-shrink:0;"></div>`;
  }
  return bars;
}

function printCurrentTab(woId, custName, device) {
  const receiptVisible = document.getElementById('print-tab-receipt').style.display !== 'none';
  if (receiptVisible) {
    // Receipt — 80mm thermal: open 302px wide window
    const content = document.getElementById('receipt-area').outerHTML;
    const w = window.open('', '_blank', 'width=360,height=720');
    w.document.write(`<!DOCTYPE html><html><head><title>Receipt ${woId}</title><style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{background:#fff;display:flex;justify-content:center;padding:12px;font-family:'Courier New',monospace;}
      @page{size:80mm auto;margin:4mm;}
      @media print{.no-print{display:none!important;}body{padding:0;}}
    </style></head><body>
      ${content}
      <div class="no-print" style="text-align:center;margin-top:12px;">
        <button onclick="window.print()" style="padding:8px 24px;font-size:13px;cursor:pointer;background:#e8ff47;border:none;font-weight:700;">Print Receipt</button>
      </div>
    </body></html>`);
    w.document.close();
  } else {
    // Sticker — 2×1 inch label
    const content = document.getElementById('sticker-area').outerHTML;
    const w = window.open('', '_blank', 'width=320,height=240');
    w.document.write(`<!DOCTYPE html><html><head><title>Sticker ${woId}</title><style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:12px;font-family:'Courier New',monospace;}
      @page{size:2in 1in;margin:0;}
      @media print{.no-print{display:none!important;}body{padding:0;min-height:unset;}}
    </style></head><body>
      ${content}
      <div class="no-print" style="position:fixed;bottom:12px;left:0;right:0;text-align:center;">
        <button onclick="window.print()" style="padding:8px 24px;font-size:13px;cursor:pointer;background:#e8ff47;border:none;font-weight:700;">Print Sticker</button>
      </div>
    </body></html>`);
    w.document.close();
  }
}

// ── WARRANTY HELPERS ─────────────────────────────────────────────
function warrantyExpiry(wo) {
  if (!wo.warranty?.startDate) return null;
  const d = new Date(wo.warranty.startDate);
  d.setDate(d.getDate() + (wo.warranty.days || 0));
  return d.toISOString().slice(0,10);
}

function isUnderWarranty(wo) {
  if (!wo.warranty?.hasWarranty || !wo.warranty?.startDate) return false;
  return new Date() <= new Date(warrantyExpiry(wo));
}

function openEditWarranty(woId) {
  const wo = woById(woId);
  const w = wo.warranty || { hasWarranty: false, days: 30, startDate: null };
  openModal('Warranty — ' + woId, `
    <div class="form-grid">
      <div class="form-group span2">
        <label class="form-label">Warranty Coverage</label>
        <select class="form-select" id="wty-has" onchange="document.getElementById('wty-days-row').style.display=this.value==='true'?'grid':'none'">
          <option value="true" ${w.hasWarranty?'selected':''}>Yes — this repair has a warranty</option>
          <option value="false" ${!w.hasWarranty?'selected':''}>No warranty</option>
        </select>
      </div>
      <div class="form-group span2" id="wty-days-row" style="display:${w.hasWarranty?'grid':'none'}">
        <label class="form-label">Warranty Period (days)</label>
        <select class="form-select" id="wty-days">
          ${[7,14,30,60,90,180,365].map(d=>`<option value="${d}" ${w.days===d?'selected':''}>${d} days</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-top:10px;">Warranty start date is set automatically when the sale is completed.</div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Save', cls: 'btn-accent', action: () => {
      wo.warranty = {
        hasWarranty: document.getElementById('wty-has').value === 'true',
        days: parseInt(document.getElementById('wty-days')?.value) || 30,
        startDate: wo.warranty?.startDate || null,
      };
      closeModalDirect();
      notify('Warranty updated');
      renderWODetail();
    }}
  ]);
}

function openWarrantyRepair(originalWoId) {
  const orig = woById(originalWoId);
  const cust = custById(orig.customerId);
  const underWarranty = isUnderWarranty(orig);
  const expiry = warrantyExpiry(orig);

  openModal('Warranty Repair — ' + originalWoId, `
    <div style="background:${underWarranty?'#0d1a00':'#1a0a00'};border:1px solid ${underWarranty?'var(--green)':'var(--orange)'};padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${underWarranty?'var(--green)':'var(--orange)'}" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;font-weight:700;color:${underWarranty?'var(--green)':'var(--orange)'};">
          ${underWarranty ? `WARRANTY ACTIVE — expires ${formatDate(expiry)}` : `WARRANTY EXPIRED — expired ${formatDate(expiry)}`}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${orig.device} · ${cust ? cust.first+' '+cust.last : '—'}</div>
      </div>
    </div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px;line-height:1.6;">
      This will create a new work order linked to <strong style="color:var(--text);">${originalWoId}</strong>. The new WO will be flagged as a warranty repair and the customer will not be charged.
    </div>
    <div class="form-grid cols1">
      <div class="form-group">
        <label class="form-label">Issue Description</label>
        <textarea class="form-textarea" id="wty-issue" placeholder="What is the customer reporting now?">${orig.issue}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Assigned Technician</label>
        <select class="form-select" id="wty-tech">
          ${getTechs().map(t=>`<option ${orig.tech===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: '+ Create Warranty WO', cls: 'btn-accent', action: () => {
      const id = nextTicketNum();
      const newWO = {
        id,
        customerId: orig.customerId,
        device: orig.device,
        imei: orig.imei,
        passcode: orig.passcode || '',
        issue: document.getElementById('wty-issue').value.trim() || orig.issue,
        damage: 'Warranty repair — see ' + originalWoId,
        status: 'Repair Queue',
        tech: document.getElementById('wty-tech').value,
        estimate: 0,
        deposit: 0,
        turnaround: 'TBD',
        created: new Date().toISOString().slice(0,10),
        warranty: { hasWarranty: false, days: 0, startDate: null },
        warrantyOf: originalWoId,
        parts: [],
        isWarrantyRepair: true,
        log: [{ time: now(), user: (currentUser?.name||'Admin'), type: 'status', text: `Warranty repair created from ${originalWoId} · Status → Repair Queue` }]
      };
      workOrders.unshift(newWO);
      closeModalDirect();
      notify('Warranty WO ' + id + ' created');
      showWODetail(id);
    }}
  ]);
}

// ── SALE COMPLETE — PAYMENT SUMMARY ──────────────────────────────
function markSaleComplete(woId) {
  const wo = woById(woId);
  if (wo.status === 'Completed') { notify('Already marked as Completed'); return; }
  const cust = custById(wo.customerId);
  const partsTotal = wo.parts.reduce((s,p) => s + p.cost, 0);
  const balance = Math.max(0, wo.estimate - wo.deposit);
  const w = wo.warranty || { hasWarranty: false, days: 30, startDate: null };

  openModal('Complete Sale — ' + wo.id, `
    <div style="background:#0d1a00;border:1px solid var(--accent-dim);padding:14px 16px;margin-bottom:18px;display:flex;align-items:center;gap:12px;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <div>
        <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:14px;color:var(--accent);">Mark repair as complete &amp; collect payment</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent-dim);margin-top:2px;">${cust ? cust.first+' '+cust.last : '—'} · ${wo.device}</div>
      </div>
    </div>

    <div style="border:1px solid var(--border);margin-bottom:16px;">
      <div style="background:var(--surface2);padding:8px 14px;font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;">Payment Summary</div>
      <div style="padding:14px;">
        <div class="info-row"><span class="info-key">Estimate</span><span class="info-val mono">$${wo.estimate.toFixed(2)}</span></div>
        <div class="info-row"><span class="info-key">Parts Total</span><span class="info-val mono">$${partsTotal.toFixed(2)}</span></div>
        <div class="info-row"><span class="info-key">Deposit Collected</span><span class="info-val mono">-$${wo.deposit.toFixed(2)}</span></div>
        <div class="info-row" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
          <span class="info-key" style="font-size:13px;font-weight:700;color:var(--text);">Balance Due</span>
          <span class="info-val mono" style="font-size:20px;font-weight:800;color:var(--accent);">$${balance.toFixed(2)}</span>
        </div>
      </div>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Payment Method</label>
        <select class="form-select" id="sc-method">
          <option>Cash</option>
          <option>Credit Card</option>
          <option>Debit Card</option>
          <option>Zelle</option>
          <option>CashApp</option>
          <option>Check</option>
          <option>No Charge</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Amount Collected ($)</label>
        <input class="form-input" id="sc-amount" type="number" value="${balance.toFixed(2)}" style="font-family:\'IBM Plex Mono\',monospace;font-size:15px;color:var(--accent);">
      </div>
    </div>

    <div style="border:1px solid var(--border);margin-top:14px;padding:12px 14px;background:var(--bg);">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;">Warranty</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-group">
          <label class="form-label">Offer Warranty?</label>
          <select class="form-select" id="sc-wty-has" onchange="document.getElementById('sc-wty-days-row').style.display=this.value==='true'?'block':'none'">
            <option value="true" ${w.hasWarranty?'selected':''}>Yes</option>
            <option value="false" ${!w.hasWarranty?'selected':''}>No</option>
          </select>
        </div>
        <div class="form-group" id="sc-wty-days-row" style="display:${w.hasWarranty?'block':'none'}">
          <label class="form-label">Period</label>
          <select class="form-select" id="sc-wty-days">
            ${[7,14,30,60,90,180,365].map(d=>`<option value="${d}" ${(w.days||30)===d?'selected':''}>${d} days</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="form-group" style="margin-top:12px;">
      <label class="form-label">Notes <span class="opt">(optional)</span></label>
      <input class="form-input" id="sc-notes" placeholder="e.g. Customer happy, warranty given, follow up in 30 days…">
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: '✓ Confirm & Close Ticket', cls: 'btn-accent', action: () => {
      const method  = document.getElementById('sc-method').value;
      const amount  = parseFloat(document.getElementById('sc-amount').value) || 0;
      const notes   = document.getElementById('sc-notes').value.trim();
      const hasWty  = document.getElementById('sc-wty-has').value === 'true';
      const wtyDays = parseInt(document.getElementById('sc-wty-days')?.value) || 30;
      const today   = new Date().toISOString().slice(0,10);

      wo.status  = 'Completed';
      wo.payment = { method, amount };
      wo.warranty = { hasWarranty: hasWty, days: wtyDays, startDate: hasWty ? today : null };
      wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'status',
        text: `Status → Completed · Payment: $${amount.toFixed(2)} via ${method}${hasWty?' · Warranty: '+wtyDays+' days':''}${notes?' · '+notes:''}` });

      // Record to cash drawer
      cashEntries.push({
        id: 'pay-' + Date.now(),
        woId: wo.id,
        customer: custName(wo.customerId),
        device: wo.device,
        method, amount,
        time: now(),
        type: 'payment',
        date: today,
      });

      closeModalDirect();
      notify('✓ Sale complete — $' + amount.toFixed(2) + ' via ' + method);
      renderWODetail();
      renderStats();
    }}
  ]);
}

function openEditCustModal(custId) {
  const c = custById(custId);
  if (!c) return;
  openModal('Edit Customer — ' + c.first + ' ' + c.last, `
    <div class="form-section">Contact Info</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">First Name</label>
        <input class="form-input" id="ec-first" value="${c.first}">
      </div>
      <div class="form-group">
        <label class="form-label">Last Name</label>
        <input class="form-input" id="ec-last" value="${c.last}">
      </div>
      <div class="form-group">
        <label class="form-label">Primary Phone</label>
        <input class="form-input" id="ec-phone" value="${c.phone}">
      </div>
      <div class="form-group">
        <label class="form-label">Secondary Phone <span class="opt">(optional)</span></label>
        <input class="form-input" id="ec-phone2" value="${c.phone2||''}">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="ec-email" value="${c.email||''}">
      </div>
      <div class="form-group">
        <label class="form-label">Birthday</label>
        <input class="form-input" id="ec-birthday" type="date" value="${c.birthday||''}">
      </div>
      <div class="form-group span2">
        <label class="form-label">Address</label>
        <input class="form-input" id="ec-address" value="${c.address||''}" placeholder="Street, City, State ZIP">
      </div>
    </div>
    <div class="form-section">Marketing</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Source</label>
        <select class="form-select" id="ec-source">
          ${['Walk-in','Google','Instagram','Facebook','Referral','Yelp','TikTok','Other'].map(s=>`<option ${c.source===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Preferred Contact</label>
        <select class="form-select" id="ec-contact">
          ${['Text','Call','Email'].map(s=>`<option ${c.preferredContact===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">SMS Opt-in</label>
        <select class="form-select" id="ec-sms">
          <option value="true" ${c.optInSMS?'selected':''}>Yes — opted in</option>
          <option value="false" ${!c.optInSMS?'selected':''}>No — opted out</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Email Opt-in</label>
        <select class="form-select" id="ec-emailopt">
          <option value="true" ${c.optInEmail?'selected':''}>Yes — opted in</option>
          <option value="false" ${!c.optInEmail?'selected':''}>No — opted out</option>
        </select>
      </div>
      <div class="form-group span2">
        <label class="form-label">Tags <span class="opt">(comma separated)</span></label>
        <input class="form-input" id="ec-tags" value="${(c.tags||[]).join(', ')}" placeholder="VIP, Repeat, Business, Newsletter…">
      </div>
    </div>
    <div class="form-section">Notes</div>
    <div class="form-grid cols1">
      <div class="form-group">
        <textarea class="form-textarea" id="ec-notes">${c.notes||''}</textarea>
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Save Changes', cls: 'btn-accent', action: () => {
      const rawTags = document.getElementById('ec-tags').value.trim();
      c.first           = document.getElementById('ec-first').value.trim()    || c.first;
      c.last            = document.getElementById('ec-last').value.trim()     || c.last;
      c.phone           = document.getElementById('ec-phone').value.trim()    || c.phone;
      c.phone2          = document.getElementById('ec-phone2').value.trim();
      c.email           = document.getElementById('ec-email').value.trim();
      c.birthday        = document.getElementById('ec-birthday').value;
      c.address         = document.getElementById('ec-address').value.trim();
      c.source          = document.getElementById('ec-source').value;
      c.preferredContact= document.getElementById('ec-contact').value;
      c.optInSMS        = document.getElementById('ec-sms').value === 'true';
      c.optInEmail      = document.getElementById('ec-emailopt').value === 'true';
      c.tags            = rawTags ? rawTags.split(',').map(t=>t.trim()).filter(Boolean) : [];
      c.notes           = document.getElementById('ec-notes').value.trim();
      closeModalDirect();
      notify('Customer updated');
      renderCustDetail();
      renderCustomerTable();
    }}
  ]);
}

function openEmailModal(woId) {
  const wo = woById(woId);
  const cust = custById(wo.customerId);
  const email = cust?.email || '';
  openModal('Send Email to Client', `
    <div class="form-grid cols1">
      <div class="form-group">
        <label class="form-label">To</label>
        <input class="form-input" id="em-to" value="${email}" placeholder="client@email.com">
      </div>
      <div class="form-group">
        <label class="form-label">Subject</label>
        <input class="form-input" id="em-subject" value="Update on your repair — ${wo.id}">
      </div>
      <div class="form-group">
        <label class="form-label">Message</label>
        <textarea class="form-textarea" id="em-body" style="min-height:120px;">Hi ${cust?.first||''},\n\nYour ${wo.device} repair (${wo.id}) is now: ${wo.status}.\n\nPlease don't hesitate to reach out with any questions.\n\n— Stone MTN Device Repair</textarea>
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: '✉ Send Email', cls: 'btn-accent', action: () => { closeModalDirect(); notify('Email sent to client ✓'); } }
  ]);
}

function selectPart(name, cost) {
  document.getElementById('part-search-input').value = name;
  document.getElementById('part-suggestions').innerHTML = '';
}

function addPartFromInput(woId) {
  const wo = woById(woId);
  const input = document.getElementById('part-search-input');
  const name = input.value.trim();
  if (!name) return;
  const match = inventory.find(p => p.name === name);
  const cost = match ? match.price : 0.00;
  const sku  = match ? match.sku : '—';
  wo.parts.push({ name, cost, sku });
  wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'note', text: `Part added: ${name} (${sku}) — $${cost.toFixed(2)}` });
  // Decrement inventory
  if (match && match.qty > 0) {
    match.qty--;
    notify('Part added · Inventory updated (' + match.qty + ' remaining)');
  } else {
    notify('Part added' + (match ? ' ⚠ Out of stock in inventory' : ''));
  }
  updateLowStockBadge();
  input.value = '';
  document.getElementById('part-suggestions').innerHTML = '';
  renderWODetail();
}

function removePart(woId, idx) {
  const wo = woById(woId);
  const p = wo.parts[idx];
  wo.parts.splice(idx, 1);
  wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'note', text: `Part removed: ${p.name}` });
  // Restore inventory qty
  const invPart = inventory.find(ip => ip.name === p.name);
  if (invPart) invPart.qty++;
  notify('Part removed');
  updateLowStockBadge();
  renderWODetail();
}

function updateStatus(woId, newStatus) {
  if (newStatus === 'Completed') {
    notify('Use "Complete Sale" to mark as Completed after collecting payment');
    renderWODetail();
    return;
  }
  const wo = woById(woId);
  wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'status', text: `Status → ${newStatus}` });
  wo.status = newStatus;
  notify('Status updated');
  renderWODetail();
  renderStats();
}

function updateTech(woId, tech) {
  const wo = woById(woId);
  wo.tech = tech;
  notify('Technician assigned');
}

function addNote(woId) {
  const wo = woById(woId);
  const input = document.getElementById('note-input');
  const text = input.value.trim();
  if (!text) return;
  wo.log.push({ time: now(), user: (currentUser?.name||'Admin'), type: 'note', text });
  input.value = '';
  notify('Note added');
  renderWODetail();
}

function now() {
  return new Date().toLocaleString('sv').slice(0,16).replace('T',' ');
}

// ── CUSTOMER TABLE ───────────────────────────────────────────────
function renderCustomerTable() {
  const q = (document.getElementById('cust-search')?.value || '').toLowerCase();
  let rows = customers;
  if (q) rows = rows.filter(c =>
    (c.first+' '+c.last).toLowerCase().includes(q) ||
    c.phone.includes(q) ||
    (c.email||'').toLowerCase().includes(q) ||
    (c.source||'').toLowerCase().includes(q) ||
    (c.tags||[]).some(t => t.toLowerCase().includes(q))
  );

  const tbody = document.getElementById('cust-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-icon">👤</div><div class="empty-text">No customers found</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(c => {
    const wos = woForCust(c.id);
    const spent = wos.filter(w=>w.status==='Completed').reduce((s,w)=>s+w.estimate,0);
    const tagsHtml = (c.tags||[]).slice(0,2).map(t=>`<span style="background:var(--surface2);border:1px solid var(--border);font-family:\'IBM Plex Mono\',monospace;font-size:9px;padding:1px 6px;color:var(--text-muted);">${esc(t)}</span>`).join(' ');
    return `
    <tr onclick="showCustDetail('${esc(c.id)}')">
      <td class="td-primary">${esc(c.first)} ${esc(c.last)}</td>
      <td class="td-mono">${esc(c.phone)}</td>
      <td style="color:var(--text-muted);font-size:12px;">${esc(c.email) || '—'}</td>
      <td class="td-mono">${wos.length}</td>
      <td class="td-mono" style="color:var(--accent);">$${spent.toFixed(0)}</td>
      <td style="font-size:11px;color:var(--text-muted);">${esc(c.source)||'—'}</td>
      <td>${tagsHtml || '<span style="color:var(--text-dim);">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── CUSTOMER DETAIL ──────────────────────────────────────────────
function renderCustDetail() {
  const c = custById(viewingCust);
  if (!c) return;
  const wos = woForCust(c.id);
  const totalSpent = wos.filter(w => w.status === 'Completed').reduce((s, w) => s + w.estimate, 0);
  const lastVisit  = wos.length ? wos[0].created : null;
  const deviceSet  = [...new Set(wos.map(w => w.device))];

  const tagColors = { VIP:'var(--accent)', Repeat:'var(--cyan)', Business:'var(--purple)', Newsletter:'var(--blue)', Inactive:'var(--text-dim)' };

  const tagsHtml = (c.tags||[]).length
    ? (c.tags).map(t => `<span style="background:var(--surface2);border:1px solid var(--border);font-family:\'IBM Plex Mono\',monospace;font-size:10px;padding:2px 8px;color:${tagColors[t]||'var(--text-muted)'};">${esc(t)}</span>`).join(' ')
    : '<span style="color:var(--text-dim);font-size:12px;">No tags</span>';

  const woRows = wos.length
    ? wos.map(w => `
        <div class="wo-history-row" onclick="showWODetail('${esc(w.id)}')">
          <span class="td-mono" style="color:var(--text-muted);flex-shrink:0;">${esc(w.id)}</span>
          <span style="flex:1;">${esc(w.device)}</span>
          ${statusBadge(w.status)}
          <span class="td-mono" style="color:var(--accent);flex-shrink:0;">$${w.estimate.toFixed(2)}</span>
          <span class="td-mono" style="color:var(--text-dim);flex-shrink:0;">${formatDate(w.created)}</span>
        </div>`).join('')
    : '<div style="color:var(--text-dim);font-size:12px;padding:12px 0;">No work orders on file.</div>';

  document.getElementById('cust-detail-content').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${esc(c.first)} ${esc(c.last)}
          ${(c.tags||[]).includes('VIP') ? '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;background:var(--accent);color:#000;padding:2px 8px;margin-left:10px;vertical-align:middle;font-weight:700;">VIP</span>' : ''}
        </div>
        <div class="page-subtitle">Customer since ${formatDate(c.createdAt)} · ${wos.length} repair${wos.length!==1?'s':''} · $${totalSpent.toFixed(2)} total spent</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="openEditCustModal('${esc(c.id)}')">Edit Profile</button>
        <button class="btn btn-accent" onclick="showPage('checkin', document.querySelector('.nav-btn:nth-child(3)'));checkinData.customer='${esc(c.id)}';checkinStep=2;renderCheckin();">+ New Check-In</button>
      </div>
    </div>

    <!-- STATS ROW -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px;">
      <div style="background:var(--surface);padding:14px 18px;">
        <div style="font-family:'Syne',sans-serif;font-size:26px;font-weight:800;color:var(--cyan);">${wos.length}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Total Repairs</div>
      </div>
      <div style="background:var(--surface);padding:14px 18px;">
        <div style="font-family:'Syne',sans-serif;font-size:26px;font-weight:800;color:var(--accent);">$${totalSpent.toFixed(0)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Lifetime Spend</div>
      </div>
      <div style="background:var(--surface);padding:14px 18px;">
        <div style="font-family:'Syne',sans-serif;font-size:26px;font-weight:800;color:var(--green);">${deviceSet.length}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Devices Serviced</div>
      </div>
      <div style="background:var(--surface);padding:14px 18px;">
        <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--text);margin-top:4px;">${lastVisit ? formatDate(lastVisit) : '—'}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:6px;">Last Visit</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:320px 1fr;gap:16px;align-items:start;">

      <!-- LEFT SIDEBAR -->
      <div style="display:flex;flex-direction:column;gap:14px;">

        <!-- Contact Info -->
        <div class="card">
          <div class="card-label">Contact</div>
          <div class="info-row"><span class="info-key">Phone</span><span class="info-val mono">${esc(c.phone)||'—'}</span></div>
          ${c.phone2 ? `<div class="info-row"><span class="info-key">Phone 2</span><span class="info-val mono">${esc(c.phone2)}</span></div>` : ''}
          <div class="info-row"><span class="info-key">Email</span><span class="info-val" style="word-break:break-all;">${esc(c.email)||'—'}</span></div>
          <div class="info-row" style="${!c.address?'':''}"><span class="info-key">Address</span><span class="info-val" style="text-align:right;font-size:12px;">${esc(c.address)||'—'}</span></div>
          <div class="info-row"><span class="info-key">Birthday</span><span class="info-val">${c.birthday ? formatDate(c.birthday) : '—'}</span></div>
        </div>

        <!-- Marketing Info -->
        <div class="card">
          <div class="card-label">Marketing</div>
          <div class="info-row"><span class="info-key">Source</span><span class="info-val">${esc(c.source)||'—'}</span></div>
          <div class="info-row"><span class="info-key">Pref. Contact</span><span class="info-val">${esc(c.preferredContact)||'—'}</span></div>
          <div class="info-row">
            <span class="info-key">SMS Opt-in</span>
            <span class="info-val" style="color:${c.optInSMS?'var(--green)':'var(--red)'};">${c.optInSMS ? '✓ Yes' : '✗ No'}</span>
          </div>
          <div class="info-row">
            <span class="info-key">Email Opt-in</span>
            <span class="info-val" style="color:${c.optInEmail?'var(--green)':'var(--red)'};">${c.optInEmail ? '✓ Yes' : '✗ No'}</span>
          </div>
          <div class="info-row" style="border-bottom:none;align-items:flex-start;padding-top:10px;">
            <span class="info-key">Tags</span>
            <span class="info-val" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;">${tagsHtml}</span>
          </div>
        </div>

        <!-- Notes -->
        <div class="card">
          <div class="card-label">Notes</div>
          <div style="font-size:13px;color:${c.notes?'var(--text)':'var(--text-dim)'};line-height:1.6;min-height:40px;">${esc(c.notes)||'No notes on file.'}</div>
          <button onclick="openEditCustModal('${esc(c.id)}')" class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%;">Edit Notes</button>
        </div>

        <!-- Devices owned -->
        ${deviceSet.length ? `
        <div class="card">
          <div class="card-label">Devices on File</div>
          ${deviceSet.map(d => `<div style="font-size:13px;padding:5px 0;border-bottom:1px solid var(--border);color:var(--text-muted);">${esc(d)}</div>`).join('')}
        </div>` : ''}
      </div>

      <!-- RIGHT: Repair history -->
      <div>
        <div class="card">
          <div class="card-label">Repair History (${wos.length})</div>
          ${woRows}
        </div>
      </div>
    </div>
  `;
}

// ── NEW CUSTOMER MODAL ───────────────────────────────────────────
function openNewCustomerModal(prefill, onSuccess) {
  openModal('New Customer', `
    <div class="form-section">Contact Info</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">First Name</label>
        <input class="form-input" id="nc-first" value="${prefill?.first||''}" placeholder="First">
      </div>
      <div class="form-group">
        <label class="form-label">Last Name</label>
        <input class="form-input" id="nc-last" value="${prefill?.last||''}" placeholder="Last">
      </div>
      <div class="form-group">
        <label class="form-label">Primary Phone</label>
        <input class="form-input" id="nc-phone" value="${prefill?.phone||''}" placeholder="404-555-0000" oninput="checkDupPhone(this.value)">
        <span class="form-warn" id="nc-dup-warn" style="display:none">⚠ Possible duplicate — customer with this phone exists</span>
      </div>
      <div class="form-group">
        <label class="form-label">Secondary Phone <span class="opt">(optional)</span></label>
        <input class="form-input" id="nc-phone2" value="${prefill?.phone2||''}" placeholder="Secondary number">
      </div>
      <div class="form-group">
        <label class="form-label">Email <span class="opt">(optional)</span></label>
        <input class="form-input" id="nc-email" value="${prefill?.email||''}" placeholder="email@example.com">
      </div>
      <div class="form-group">
        <label class="form-label">Birthday <span class="opt">(optional)</span></label>
        <input class="form-input" id="nc-birthday" type="date" value="${prefill?.birthday||''}">
      </div>
      <div class="form-group span2">
        <label class="form-label">Address <span class="opt">(optional)</span></label>
        <input class="form-input" id="nc-address" value="${prefill?.address||''}" placeholder="Street, City, State ZIP">
      </div>
    </div>

    <div class="form-section">Marketing</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">How did they find us?</label>
        <select class="form-select" id="nc-source">
          ${['Walk-in','Google','Instagram','Facebook','Referral','Yelp','TikTok','Other'].map(s=>`<option ${(prefill?.source||'Walk-in')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Preferred Contact</label>
        <select class="form-select" id="nc-contact">
          ${['Text','Call','Email'].map(s=>`<option ${(prefill?.preferredContact||'Text')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">SMS Opt-in</label>
        <select class="form-select" id="nc-sms">
          <option value="true" ${prefill?.optInSMS!==false?'selected':''}>Yes — opted in</option>
          <option value="false" ${prefill?.optInSMS===false?'selected':''}>No — opted out</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Email Opt-in</label>
        <select class="form-select" id="nc-emailopt">
          <option value="true" ${prefill?.optInEmail!==false?'selected':''}>Yes — opted in</option>
          <option value="false" ${prefill?.optInEmail===false?'selected':''}>No — opted out</option>
        </select>
      </div>
      <div class="form-group span2">
        <label class="form-label">Tags <span class="opt">(comma separated — e.g. VIP, Business, Newsletter)</span></label>
        <input class="form-input" id="nc-tags" value="${(prefill?.tags||[]).join(', ')}" placeholder="VIP, Repeat, Business…">
      </div>
    </div>

    <div class="form-section">Notes</div>
    <div class="form-grid cols1">
      <div class="form-group">
        <textarea class="form-textarea" id="nc-notes" placeholder="Any general notes about this customer…">${prefill?.notes||''}</textarea>
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Create Customer', cls: 'btn-accent', action: () => saveNewCustomer(onSuccess) }
  ]);
}

function checkDupPhone(val) {
  const warn = document.getElementById('nc-dup-warn');
  const exists = customers.find(c => c.phone === val);
  if (exists) { warn.style.display='block'; document.getElementById('nc-phone').classList.add('warn'); }
  else { warn.style.display='none'; document.getElementById('nc-phone').classList.remove('warn'); }
}

function saveNewCustomer(callback) {
  const first = document.getElementById('nc-first').value.trim();
  const last  = document.getElementById('nc-last').value.trim();
  const phone = document.getElementById('nc-phone').value.trim();
  if (!first || !last || !phone) { alert('First name, last name, and phone are required.'); return; }
  const id = 'c' + Date.now();
  const rawTags = document.getElementById('nc-tags').value.trim();
  const c = {
    id, first, last, phone,
    phone2:           document.getElementById('nc-phone2').value.trim(),
    email:            document.getElementById('nc-email').value.trim(),
    birthday:         document.getElementById('nc-birthday').value,
    address:          document.getElementById('nc-address').value.trim(),
    source:           document.getElementById('nc-source').value,
    preferredContact: document.getElementById('nc-contact').value,
    optInSMS:         document.getElementById('nc-sms').value === 'true',
    optInEmail:       document.getElementById('nc-emailopt').value === 'true',
    tags:             rawTags ? rawTags.split(',').map(t=>t.trim()).filter(Boolean) : [],
    notes:            document.getElementById('nc-notes').value.trim(),
    createdAt:        new Date().toISOString().slice(0,10),
  };
  customers.push(c);
  closeModalDirect();
  notify('Customer created: ' + first + ' ' + last);
  if (callback) callback(c);
  else renderCustomerTable();
}

// ── MODAL SYSTEM ─────────────────────────────────────────────────
// Modal action registry — avoids serializing functions into HTML attributes
const _modalActions = {};
let _modalActionIdx = 0;

function openModal(title, bodyHtml, buttons = []) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-footer').innerHTML = buttons.map(b => {
    const key = 'ma_' + (_modalActionIdx++);
    _modalActions[key] = b.action;
    return `<button class="btn ${b.cls}" onclick="_modalActions['${key}']()">${b.label}</button>`;
  }).join('');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ── CHECK-IN FLOW ────────────────────────────────────────────────
function initCheckin() {
  checkinStep = 1;
  checkinData = { customer: null, device: {}, issue: {}, estimate: {}, newCust: {} };
  renderCheckin();
}

function renderCheckin() {
  document.getElementById('checkin-step-content').innerHTML = getStepContent(checkinStep);
}

function getStepContent(step) {
  if (step === 1) {
    const selected = checkinData.customer ? customers.find(c => c.id === checkinData.customer) : null;
    return `
      <div class="card">
        <div class="card-label" style="margin-bottom:20px;">Step 1 — Find or Create Customer</div>
        ${selected ? `
          <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--bg);border:1px solid var(--accent);margin-bottom:16px;">
            <div style="width:38px;height:38px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:800;font-size:14px;color:#000;flex-shrink:0;">${selected.first[0]}${selected.last[0]}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:14px;">${selected.first} ${selected.last}</div>
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">${selected.phone}${selected.email ? ' · ' + selected.email : ''}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="checkinData.customer=null;renderCheckin()">Change</button>
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-accent" onclick="ciStep(2)">Continue to Device →</button>
          </div>
        ` : `
          <div style="position:relative;margin-bottom:8px;">
            <svg style="position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input class="form-input" id="ci-search" style="padding-left:34px;" placeholder="Search by name, phone, or email…" oninput="ciFilterResults(this.value)" autocomplete="off" autofocus>
          </div>
          <div id="ci-results" style="display:flex;flex-direction:column;gap:2px;margin-bottom:16px;max-height:300px;overflow-y:auto;"></div>
          <div style="display:flex;align-items:center;gap:12px;margin:4px 0 14px;color:var(--text-dim);font-family:\'IBM Plex Mono\',monospace;font-size:11px;letter-spacing:1px;">
            <div style="flex:1;height:1px;background:var(--border)"></div>NEW CUSTOMER<div style="flex:1;height:1px;background:var(--border)"></div>
          </div>
          <button class="btn btn-ghost" style="width:100%" onclick="ciNewCust()">+ Create New Customer</button>
        `}
      </div>
    `;
  }

  if (step === 2) return `
    <div class="card">
      <div class="card-label">Step 2 — Device Details</div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Device Type</label>
          <select class="form-select" id="ci-dtype">
            <option ${checkinData.device.type==='Phone'?'selected':''}>Phone</option>
            <option ${checkinData.device.type==='Tablet'?'selected':''}>Tablet</option>
            <option ${checkinData.device.type==='Laptop'?'selected':''}>Laptop</option>
            <option ${checkinData.device.type==='Other'?'selected':''}>Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Make & Model</label>
          <input class="form-input" id="ci-model" value="${checkinData.device.model||''}" placeholder="e.g. Apple iPhone 15 Pro">
        </div>
        <div class="form-group">
          <label class="form-label">IMEI / Serial</label>
          <input class="form-input" id="ci-imei" value="${checkinData.device.imei||''}" placeholder="IMEI or serial number">
        </div>
        <div class="form-group">
          <label class="form-label">Device Passcode <span class="opt">(optional)</span></label>
          <input class="form-input" id="ci-pass" value="${checkinData.device.passcode||''}" placeholder="Passcode or PIN">
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:20px;">
        <button class="btn btn-ghost" onclick="ciStep(1)">← Back</button>
        <button class="btn btn-accent" onclick="ciSaveDevice()">Next →</button>
      </div>
    </div>
  `;

  if (step === 3) return `
    <div class="card">
      <div class="card-label">Step 3 — Issue Description</div>
      <div class="form-grid cols1">
        <div class="form-group">
          <label class="form-label">Customer's Description of Issue</label>
          <textarea class="form-textarea" id="ci-issue" style="min-height:90px" placeholder="What does the customer say is wrong?">${checkinData.issue.description||''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Pre-Existing Damage <span class="opt">(noted at check-in)</span></label>
          <textarea class="form-textarea" id="ci-damage" placeholder="Any scratches, cracks, or damage present before repair…">${checkinData.issue.damage||''}</textarea>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:20px;">
        <button class="btn btn-ghost" onclick="ciStep(2)">← Back</button>
        <button class="btn btn-accent" onclick="ciSaveIssue()">Next →</button>
      </div>
    </div>
  `;

  if (step === 4) {
    const mult = parseFloat(storeSettings.laborMultiplier) || 2.5;
    const dep  = parseFloat(storeSettings.depositAmount) || 25;
    const nonRefund = storeSettings.depositNonRefundable !== false;
    const savedParts = checkinData.estimate.parts || [];
    const partsCost = savedParts.reduce((s,p) => s+(parseFloat(p.cost)||0), 0);
    const labor = partsCost * mult;
    const total = partsCost + labor;

    const partsRows = savedParts.map((p,i) => {
      if (p.inventoryId) {
        // Inventory part row — name locked, price locked
        return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);" id="ci-part-row-${i}">
          <div style="flex:2;font-size:13px;font-weight:500;">${p.name}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--accent);min-width:70px;text-align:right;">$${parseFloat(p.cost).toFixed(2)}</div>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:2px 5px;flex-shrink:0;">STOCK</span>
          <button onclick="ciRemovePart(${i})" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:2px 6px;font-size:13px;flex-shrink:0;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">✕</button>
        </div>`;
      } else {
        // Non-inventory part row — both editable
        return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;" id="ci-part-row-${i}">
          <input class="form-input" style="flex:2;" placeholder="Part name" value="${p.name}" oninput="ciUpdatePart(${i},'name',this.value)">
          <input class="form-input" style="flex:1;max-width:100px;" type="number" placeholder="Cost $" value="${p.cost||''}" oninput="ciUpdatePart(${i},'cost',this.value)" step="0.01" min="0">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:2px 5px;flex-shrink:0;white-space:nowrap;">NON-INV</span>
          <button onclick="ciRemovePart(${i})" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:2px 6px;font-size:13px;flex-shrink:0;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text-dim)'">✕</button>
        </div>`;
      }
    }).join('');

    // Inventory search results
    const invQ = checkinData.estimate._invSearch || '';
    const invResults = invQ.length >= 1
      ? inventory.filter(p => p.name.toLowerCase().includes(invQ.toLowerCase()) || p.sku.includes(invQ)).slice(0,6)
      : [];
    const invResultsHtml = invResults.map(p => `
      <div onclick="ciPickInvPart('${p.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.1s;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);">${p.sku} · ${p.qty} in stock</div>
        </div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--accent);flex-shrink:0;">$${p.price.toFixed(2)}</div>
        ${p.qty === 0 ? '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;background:var(--red);color:#fff;padding:2px 5px;border-radius:2px;">OUT</span>' : ''}
      </div>`).join('');

    return `
    <div class="card">
      <div class="card-label" style="margin-bottom:18px;">Step 4 — Estimate</div>

      <!-- Parts section -->
      <div style="margin-bottom:4px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Parts Required</div>

        <!-- Added parts list -->
        <div id="ci-parts-list" style="margin-bottom:12px;">
          ${partsRows || '<div style="font-size:12px;color:var(--text-muted);padding:4px 0 8px;">No parts added yet</div>'}
        </div>

        <!-- Inventory search -->
        <div style="position:relative;margin-bottom:6px;">
          <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="form-input" id="ci-inv-search" style="padding-left:32px;" placeholder="Search inventory by name or SKU…" value="${invQ}" oninput="ciInvSearch(this.value)" autocomplete="off">
        </div>

        <!-- Search results dropdown -->
        ${invQ.length >= 1 ? `
        <div style="border:1px solid var(--border);background:var(--surface);margin-bottom:8px;${invResults.length === 0 ? 'padding:10px 12px;' : ''}">
          ${invResults.length > 0 ? invResultsHtml : '<div style="font-size:12px;color:var(--text-muted);">No matching parts in inventory</div>'}
        </div>` : ''}

        <!-- Non-inventory fallback -->
        <button class="btn btn-ghost btn-sm" onclick="ciAddNonInvPart()" style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.5px;">+ Non-Inventory Part</button>
      </div>

      <!-- Divider -->
      <div style="height:1px;background:var(--border);margin:16px 0;"></div>

      <!-- Estimate breakdown -->
      <div style="background:var(--bg);border:1px solid var(--border);padding:14px 16px;margin-bottom:16px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);margin-bottom:12px;">Estimate Breakdown</div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
          <span style="color:var(--text-muted);">Parts cost</span>
          <span id="ci-parts-cost" style="font-family:'IBM Plex Mono',monospace;">$${partsCost.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
          <span style="color:var(--text-muted);">Labor (×${mult.toFixed(1)} of parts)</span>
          <span id="ci-labor-cost" style="font-family:'IBM Plex Mono',monospace;">$${labor.toFixed(2)}</span>
        </div>
        <div style="height:1px;background:var(--border);margin:8px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;">
          <span>Total Estimate</span>
          <span id="ci-total-cost" style="font-family:'IBM Plex Mono',monospace;color:var(--accent);">$${total.toFixed(2)}</span>
        </div>
      </div>

      <!-- Deposit locked -->
      <div style="background:var(--surface2);border:1px solid var(--border);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:13px;font-weight:600;">Deposit Required: <span style="font-family:'IBM Plex Mono',monospace;color:var(--accent);">$${dep.toFixed(2)}</span></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
            ${nonRefund ? '⚠ Non-refundable if client declines or device unrepairable' : 'Refundable if repair is declined'}
            &nbsp;·&nbsp; Set in Store Settings
          </div>
        </div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:3px 8px;">LOCKED</div>
      </div>

      <!-- Turnaround + Tech -->
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Turnaround Time</label>
          <input class="form-input" id="ci-turnaround" value="${checkinData.estimate.turnaround || storeSettings.defaultTurnaround}" placeholder="e.g. 2-3 days">
        </div>
        <div class="form-group">
          <label class="form-label">Assigned Tech</label>
          <select class="form-select" id="ci-tech">
            ${getTechs().map(t => `<option ${checkinData.estimate.tech===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;margin-top:20px;">
        <button class="btn btn-ghost" onclick="ciStep(3)">← Back</button>
        <button class="btn btn-accent" onclick="ciSaveEstimate()">Next →</button>
      </div>
    </div>
  `; }

  if (step === 5) {
    const c = custById(checkinData.customer);
    const dep = parseFloat(checkinData.estimate.deposit || 0);
    const depositRequired = checkinData.estimate.depositRequired !== false && dep > 0;
    const nonRefund = checkinData.estimate.depositNonRefundable;
    const payMethod = checkinData.estimate._payMethod || 'Cash';
    const methods = ['Cash','Credit Card','Debit Card','Zelle','CashApp','Check'];
    const depPaid = checkinData.estimate._depositPaid || false;
    const deviceType = checkinData.device.type || 'Other';
    const canCreate = !depositRequired || depPaid;

    return `
      <div class="card">
        <div class="card-label" style="margin-bottom:18px;">Step 5 — ${depositRequired ? 'Collect Deposit & ' : ''}Confirm</div>

        <!-- Order summary -->
        <div style="background:var(--bg);border:1px solid var(--border);padding:14px 16px;margin-bottom:18px;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Order Summary</div>
          <div class="info-row"><span class="info-key">Customer</span><span class="info-val">${c ? c.first+' '+c.last : '—'}</span></div>
          <div class="info-row"><span class="info-key">Device</span><span class="info-val">${checkinData.device.model||'—'} <span style="font-size:10px;color:var(--text-muted);">(${deviceType})</span></span></div>
          <div class="info-row"><span class="info-key">Issue</span><span class="info-val" style="max-width:240px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${checkinData.issue.description||'—'}</span></div>
          <div style="height:1px;background:var(--border);margin:8px 0;"></div>
          <div class="info-row"><span class="info-key">Parts</span><span class="info-val mono">$${parseFloat(checkinData.estimate.partsCost||0).toFixed(2)}</span></div>
          <div class="info-row"><span class="info-key">Labor</span><span class="info-val mono">$${parseFloat(checkinData.estimate.labor||0).toFixed(2)}</span></div>
          <div class="info-row" style="font-weight:700;"><span class="info-key">Total Estimate</span><span class="info-val mono" style="color:var(--accent);">$${parseFloat(checkinData.estimate.cost||0).toFixed(2)}</span></div>
          <div class="info-row"><span class="info-key">Turnaround</span><span class="info-val">${checkinData.estimate.turnaround||'—'}</span></div>
          <div class="info-row"><span class="info-key">Technician</span><span class="info-val">${checkinData.estimate.tech||'Unassigned'}</span></div>
        </div>

        ${depositRequired ? `
        <!-- Deposit collection — required before WO can be created -->
        <div style="border:2px solid ${depPaid ? 'var(--green)' : 'var(--accent)'};padding:16px;margin-bottom:18px;transition:border-color 0.3s;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <div style="font-size:14px;font-weight:700;">Deposit Required</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                ${nonRefund ? '⚠ Non-refundable if client declines or device is unrepairable' : 'Refundable if repair is declined'}
              </div>
            </div>
            <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--accent);">$${dep.toFixed(2)}</div>
          </div>
          ${depPaid ? `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg);border:1px solid var(--green);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span style="font-size:13px;font-weight:600;color:var(--green);">Collected via ${checkinData.estimate._payMethod}</span>
              <button onclick="checkinData.estimate._depositPaid=false;renderCheckin()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;margin-left:auto;font-size:11px;text-decoration:underline;">Undo</button>
            </div>
          ` : `
            <div style="margin-bottom:12px;">
              <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Payment Method</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${methods.map(m => `<button onclick="checkinData.estimate._payMethod='${m}';renderCheckin()" style="padding:6px 14px;border:1px solid ${payMethod===m?'var(--accent)':'var(--border)'};background:${payMethod===m?'var(--accent)':'none'};color:${payMethod===m?'#000':'var(--text-muted)'};cursor:pointer;font-family:'IBM Plex Mono',monospace;font-size:11px;border-radius:2px;transition:all 0.15s;">${m}</button>`).join('')}
              </div>
            </div>
            <button class="btn btn-accent" style="width:100%;font-size:14px;padding:12px;" onclick="ciCollectDeposit()">
              Collect $${dep.toFixed(2)} · ${payMethod}
            </button>
          `}
        </div>
        ` : `
        <!-- No deposit for this device type -->
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--surface2);border:1px solid var(--border);margin-bottom:18px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span style="font-size:12px;color:var(--text-muted);">No deposit required for <strong>${deviceType}</strong> — set in Store Settings → Tax & Pricing</span>
        </div>
        `}

        <div style="display:flex;justify-content:space-between;">
          <button class="btn btn-ghost" onclick="ciStep(4)">← Back</button>
          <button class="btn btn-accent" onclick="ciCreateWO()" ${canCreate ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>
            ${canCreate ? '✓ Create Work Order' : 'Collect Deposit First'}
          </button>
        </div>
      </div>
    `;
  }
}

function ciFilterResults(q) {
  const box = document.getElementById('ci-results');
  if (!box) return;
  const query = q.trim().toLowerCase();
  if (!query) { box.innerHTML = ''; return; }
  const matches = customers.filter(c => {
    const name = (c.first + ' ' + c.last).toLowerCase();
    return name.includes(query) ||
      (c.phone || '').replace(/\D/g,'').includes(query.replace(/\D/g,'')) ||
      (c.email || '').toLowerCase().includes(query);
  });
  if (matches.length === 0) {
    box.innerHTML = `<div style="padding:12px 14px;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-dim);">No customers found — create a new one below</div>`;
    return;
  }
  box.innerHTML = matches.map(c => {
    const woCount = workOrders.filter(w => w.customerId === c.id).length;
    const initials = (c.first||'?')[0] + (c.last||'?')[0];
    return `
      <div onclick="ciPickCust('${c.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 12px;cursor:pointer;border:1px solid var(--border);background:var(--surface);transition:all 0.12s;" onmouseover="this.style.borderColor='var(--accent)';this.style.background='var(--surface2)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--surface)'">
        <div style="width:34px;height:34px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:800;font-size:12px;color:var(--accent);flex-shrink:0;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;">${c.first} ${c.last}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">${c.phone}${c.email ? ' · ' + c.email : ''}</div>
        </div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);text-align:right;flex-shrink:0;">${woCount} repair${woCount !== 1 ? 's' : ''}</div>
      </div>
    `;
  }).join('');
}

function ciPickCust(id) {
  checkinData.customer = id;
  renderCheckin();
}

function ciNewCust() {
  openNewCustomerModal(null, (c) => {
    checkinData.customer = c.id;
    renderCheckin();
  });
}

function ciStep(n) {
  checkinStep = n;
  renderCheckin();
}

function ciSaveDevice() {
  const model = document.getElementById('ci-model').value.trim();
  if (!model) { alert('Model is required.'); return; }
  checkinData.device = {
    type: document.getElementById('ci-dtype').value,
    model,
    imei: document.getElementById('ci-imei').value.trim(),
    passcode: document.getElementById('ci-pass').value.trim(),
  };
  ciStep(3);
}

function ciSaveIssue() {
  const desc = document.getElementById('ci-issue').value.trim();
  if (!desc) { alert('Please describe the issue.'); return; }
  checkinData.issue = {
    description: desc,
    damage: document.getElementById('ci-damage').value.trim() || 'None noted',
  };
  ciStep(4);
}

function ciInvSearch(q) {
  if (!checkinData.estimate) checkinData.estimate = {};
  checkinData.estimate._invSearch = q;
  renderCheckin();
  // Restore focus to search input
  setTimeout(() => {
    const el = document.getElementById('ci-inv-search');
    if (el) { el.focus(); el.value = q; el.setSelectionRange(q.length, q.length); }
  }, 30);
}

function ciPickInvPart(partId) {
  const part = inventory.find(p => p.id === partId);
  if (!part) return;
  if (!checkinData.estimate.parts) checkinData.estimate.parts = [];
  checkinData.estimate.parts.push({ inventoryId: part.id, name: part.name, cost: part.price });
  checkinData.estimate._invSearch = '';
  renderCheckin();
}

function ciAddNonInvPart() {
  if (!checkinData.estimate.parts) checkinData.estimate.parts = [];
  checkinData.estimate.parts.push({ name: '', cost: '' });
  checkinData.estimate._invSearch = '';
  renderCheckin();
  setTimeout(() => {
    const rows = document.querySelectorAll('[id^="ci-part-row-"]');
    if (rows.length) {
      const last = rows[rows.length - 1];
      const inp = last.querySelector('input');
      if (inp) inp.focus();
    }
  }, 50);
}

function ciRemovePart(i) {
  if (!checkinData.estimate.parts) return;
  checkinData.estimate.parts.splice(i, 1);
  renderCheckin();
}

function ciUpdatePart(i, field, val) {
  if (!checkinData.estimate.parts) return;
  checkinData.estimate.parts[i][field] = val;
  const mult = parseFloat(storeSettings.laborMultiplier) || 2.5;
  const partsCost = checkinData.estimate.parts.reduce((s,p) => s+(parseFloat(p.cost)||0), 0);
  const labor = partsCost * mult;
  const total = partsCost + labor;
  const pc = document.getElementById('ci-parts-cost');
  const lc = document.getElementById('ci-labor-cost');
  const tc = document.getElementById('ci-total-cost');
  if (pc) pc.textContent = '$' + partsCost.toFixed(2);
  if (lc) lc.textContent = '$' + labor.toFixed(2);
  if (tc) tc.textContent = '$' + total.toFixed(2);
}

function ciSaveEstimate() {
  const parts = checkinData.estimate.parts || [];
  const mult = parseFloat(storeSettings.laborMultiplier) || 2.5;
  const dep  = parseFloat(storeSettings.depositAmount) || 25;
  const partsCost = parts.reduce((s,p) => s+(parseFloat(p.cost)||0), 0);
  const labor = partsCost * mult;
  const total = partsCost + labor;
  const deviceType = checkinData.device.type || 'Other';
  const allowedTypes = storeSettings.depositDeviceTypes || ['Phone','Tablet','Laptop','Other'];
  const depositRequired = allowedTypes.includes(deviceType);
  checkinData.estimate = {
    parts,
    partsCost,
    labor,
    cost: total,
    deposit: depositRequired ? dep : 0,
    depositRequired,
    turnaround: document.getElementById('ci-turnaround').value.trim() || storeSettings.defaultTurnaround,
    tech: document.getElementById('ci-tech').value,
    depositNonRefundable: storeSettings.depositNonRefundable !== false,
  };
  ciStep(5);
}

function ciCreateWO() {
  const id = nextTicketNum();
  const wo = {
    id,
    customerId: checkinData.customer,
    device: checkinData.device.model,
    imei: checkinData.device.imei,
    passcode: checkinData.device.passcode || '',
    issue: checkinData.issue.description,
    damage: checkinData.issue.damage,
    status: 'Repair Queue',
    tech: checkinData.estimate.tech,
    estimate: checkinData.estimate.cost,
    deposit: checkinData.estimate.deposit,
    depositNonRefundable: checkinData.estimate.depositNonRefundable || false,
    turnaround: checkinData.estimate.turnaround,
    created: new Date().toISOString().slice(0,10),
    parts: [],
    log: [{ time: now(), user: (currentUser?.name||'Admin'), type: 'status', text: 'Status → Repair Queue · Work order created' }]
  };
  workOrders.unshift(wo);
  notify(`Work order ${id} created!`);
  showWODetail(id);
}

// ── CASH DRAWER DATA ─────────────────────────────────────────────
let drawerFloat = 200.00;
let drawerSessions = [];
let cashEntries = [];

let drawerOpen = false;
let currentSessionDate = new Date().toISOString().slice(0,10);

function renderDrawerPage() {
  const today = new Date().toISOString().slice(0,10);
  const todayEntries = cashEntries.filter(e => e.date === today);

  // Totals by method
  const byMethod = {};
  todayEntries.forEach(e => {
    byMethod[e.method] = (byMethod[e.method] || 0) + e.amount;
  });
  const totalToday = todayEntries.reduce((s,e) => s+e.amount, 0);
  const cashToday  = byMethod['Cash'] || 0;
  const cardTotal  = (byMethod['Credit Card']||0) + (byMethod['Debit Card']||0);
  const digitalTotal = (byMethod['Zelle']||0) + (byMethod['CashApp']||0);

  const methods = ['Cash','Credit Card','Debit Card','Zelle','CashApp','Check','No Charge'];
  const methodColors = { Cash:'var(--green)', 'Credit Card':'var(--blue)', 'Debit Card':'var(--cyan)', Zelle:'var(--purple)', CashApp:'var(--orange)', Check:'var(--text-muted)', 'No Charge':'var(--text-dim)' };

  document.getElementById('drawer-content').innerHTML = `
    <!-- TODAY STATS -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px;">
      <div style="background:var(--surface);padding:18px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--accent);">$${totalToday.toFixed(2)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Today's Revenue</div>
      </div>
      <div style="background:var(--surface);padding:18px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--green);">$${cashToday.toFixed(2)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Cash In</div>
      </div>
      <div style="background:var(--surface);padding:18px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--blue);">$${cardTotal.toFixed(2)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Card</div>
      </div>
      <div style="background:var(--surface);padding:18px 20px;">
        <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--purple);">$${digitalTotal.toFixed(2)}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Digital</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:260px 1fr;gap:16px;align-items:start;">
      <!-- LEFT: Breakdown + float -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="card-label">By Payment Method</div>
          ${methods.map(m => {
            const amt = byMethod[m] || 0;
            const pct = totalToday > 0 ? (amt/totalToday*100) : 0;
            return `
            <div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:12px;">${m}</span>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:${amt>0?'var(--accent)':'var(--text-dim)'};">$${amt.toFixed(2)}</span>
              </div>
              <div style="height:4px;background:var(--surface2);border-radius:2px;">
                <div style="height:4px;background:${methodColors[m]||'var(--accent)'};width:${pct.toFixed(1)}%;border-radius:2px;transition:width 0.3s;"></div>
              </div>
            </div>`;
          }).join('')}
        </div>

        <div class="card">
          <div class="card-label">Cash Drawer Float</div>
          <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--green);margin-bottom:4px;">$${(drawerFloat + cashToday).toFixed(2)}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">Float $${drawerFloat.toFixed(2)} + Cash $${cashToday.toFixed(2)}</div>
          <button onclick="openDrawerAdjust()" class="btn btn-ghost btn-sm" style="margin-top:12px;width:100%;">Adjust Float</button>
        </div>
      </div>

      <!-- RIGHT: Transaction log -->
      <div class="card">
        <div class="card-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Today's Transactions</span>
          <span style="font-size:11px;color:var(--text-dim);">${today}</span>
        </div>
        ${todayEntries.length ? `
        <div style="border:1px solid var(--border);">
          <div style="display:grid;grid-template-columns:120px 1fr 100px 100px 80px;background:var(--surface2);padding:7px 14px;border-bottom:1px solid var(--border);">
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Time</span>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Customer / WO</span>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Method</span>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;text-align:right;">Amount</span>
            <span></span>
          </div>
          ${[...todayEntries].reverse().map(e => `
            <div style="display:grid;grid-template-columns:120px 1fr 100px 100px 80px;padding:10px 14px;border-bottom:1px solid var(--border);align-items:center;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-dim);">${e.time.slice(11,16)}</span>
              <div>
                <div style="font-size:13px;">${e.customer}</div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">${e.woId} · ${e.device.slice(0,20)}</div>
              </div>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:${methodColors[e.method]||'var(--text-muted)'};">${e.method}</span>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:14px;font-weight:700;color:var(--accent);text-align:right;">$${e.amount.toFixed(2)}</span>
              ${e.woId ? `<button onclick="showWODetail('${e.woId}');showPage('work-orders',document.querySelector('.nav-btn:nth-child(1)'))" style="background:none;border:1px solid var(--border);color:var(--text-dim);font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;cursor:pointer;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-dim)'">WO</button>` : '<span></span>'}
            </div>`).join('')}
          <div style="display:grid;grid-template-columns:120px 1fr 100px 100px 80px;padding:10px 14px;background:var(--bg);border-top:1px solid var(--border);">
            <span></span><span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;">Day Total</span>
            <span></span>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:16px;font-weight:800;color:var(--accent);text-align:right;">$${totalToday.toFixed(2)}</span>
            <span></span>
          </div>
        </div>` : `
        <div class="empty" style="padding:40px 0;">
          <div class="empty-icon">💵</div>
          <div class="empty-text">No transactions recorded today</div>
        </div>`}
      </div>
    </div>

    <!-- HISTORY -->
    ${drawerSessions.length ? `
    <div class="card" style="margin-top:16px;">
      <div class="card-label">Previous Days</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Opened By</th><th>Opening Float</th><th>Closing Count</th><th>Difference</th><th>Status</th></tr></thead>
          <tbody>
            ${drawerSessions.map(s => {
              const diff = s.closingCount - (s.openingFloat + cashEntries.filter(e=>e.date===s.date&&e.method==='Cash').reduce((x,e)=>x+e.amount,0));
              return `<tr>
                <td class="td-mono">${formatDate(s.date)}</td>
                <td>${s.openedBy}</td>
                <td class="td-mono">$${s.openingFloat.toFixed(2)}</td>
                <td class="td-mono">$${s.closingCount.toFixed(2)}</td>
                <td class="td-mono" style="color:${Math.abs(diff)<0.01?'var(--green)':diff<0?'var(--red)':'var(--orange)'};">${diff>=0?'+':''}$${diff.toFixed(2)}</td>
                <td><span class="status s-complete">${s.status}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

function openDrawerAdjust() {
  if (!isAdminOrManager()) { notify('Manager access required.'); return; }
  if (isAdmin()) { requireAdminPIN(_doOpenDrawerAdjust, 'Adjust cash float requires admin PIN'); return; }
  _doOpenDrawerAdjust();
}
function _doOpenDrawerAdjust() {
  openModal('Adjust Cash Float', `
    <div style="margin-bottom:16px;">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);margin-bottom:4px;">Current Float</div>
      <div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--green);">$${drawerFloat.toFixed(2)}</div>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Adjustment Type</label>
        <select class="form-select" id="da-type">
          <option value="add">Add to Float</option>
          <option value="remove">Remove from Float</option>
          <option value="set">Set Exact Amount</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Amount ($)</label>
        <input class="form-input" id="da-amount" type="number" value="0.00">
      </div>
      <div class="form-group span2">
        <label class="form-label">Reason</label>
        <input class="form-input" id="da-reason" placeholder="e.g. Opening float, petty cash, bank run…">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Apply', cls: 'btn-accent', action: () => {
      const type   = document.getElementById('da-type').value;
      const amount = parseFloat(document.getElementById('da-amount').value) || 0;
      const reason = document.getElementById('da-reason').value.trim();
      if (type === 'add')    drawerFloat = Math.max(0, drawerFloat + amount);
      if (type === 'remove') drawerFloat = Math.max(0, drawerFloat - amount);
      if (type === 'set')    drawerFloat = Math.max(0, amount);
      cashEntries.push({ id:'adj-'+Date.now(), woId:null, customer:'— Drawer Adjustment —', device:reason||'Manual adjustment', method:'Cash', amount: type==='remove'?-amount:amount, time:now(), type:'adjustment', date:new Date().toISOString().slice(0,10) });
      closeModalDirect();
      notify('Float updated → $'+drawerFloat.toFixed(2));
      renderDrawerPage();
    }}
  ]);
}

// Denomination definitions — value in cents to avoid float issues
const DENOMS = [
  { label: '$100', cents: 10000, type: 'bill' },
  { label: '$50',  cents: 5000,  type: 'bill' },
  { label: '$20',  cents: 2000,  type: 'bill' },
  { label: '$10',  cents: 1000,  type: 'bill' },
  { label: '$5',   cents: 500,   type: 'bill' },
  { label: '$1',   cents: 100,   type: 'bill' },
  { label: '25¢',  cents: 25,    type: 'coin' },
  { label: '10¢',  cents: 10,    type: 'coin' },
  { label: '5¢',   cents: 5,     type: 'coin' },
  { label: '1¢',   cents: 1,     type: 'coin' },
];

function denomCounterHTML(prefix, initialCounts) {
  function box(d) {
    const qty = (initialCounts && initialCounts[d.label]) || 0;
    const id = `${prefix}-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    const subId = `${prefix}-sub-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    const subtotal = ((qty * d.cents) / 100).toFixed(2);
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:var(--accent);">${d.label}</div>
        <input
          id="${id}"
          type="number" min="0" step="1" value="${qty}"
          placeholder="0"
          style="width:72px;height:48px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:700;background:var(--surface);border:2px solid var(--border);color:var(--text);outline:none;border-radius:0;"
          oninput="denomRecalc('${prefix}')"
          onfocus="this.style.borderColor='var(--accent)'"
          onblur="this.style.borderColor='var(--border)'">
        <div id="${subId}" style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);">$${subtotal}</div>
      </div>`;
  }

  const bills = DENOMS.filter(d => d.type === 'bill');
  const coins  = DENOMS.filter(d => d.type === 'coin');

  // Bills: 3 per row  → row1: $100 $50 $20  |  row2: $10 $5 $1
  // Coins: 4 per row  → row3: 25¢ 10¢ 5¢ 1¢
  return `
    <div style="display:flex;flex-direction:column;gap:16px;align-items:center;padding:8px 0;">

      <div style="width:100%;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;text-align:center;">Bills</div>
        <div style="display:flex;flex-direction:column;gap:14px;align-items:center;">
          <div style="display:flex;gap:12px;justify-content:center;">
            ${bills.slice(0,3).map(box).join('')}
          </div>
          <div style="display:flex;gap:12px;justify-content:center;">
            ${bills.slice(3,6).map(box).join('')}
          </div>
        </div>
      </div>

      <div style="height:1px;width:100%;background:var(--border);"></div>

      <div style="width:100%;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;text-align:center;">Coins</div>
        <div style="display:flex;gap:12px;justify-content:center;">
          ${coins.map(box).join('')}
        </div>
      </div>

      <div style="height:1px;width:100%;background:var(--border);"></div>

      <div style="width:100%;display:flex;justify-content:center;">
        <div style="border:2px solid var(--accent);padding:10px 32px;min-width:220px;text-align:center;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Total</div>
          <div id="${prefix}-total" style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--accent);">$0.00</div>
        </div>
      </div>

    </div>`;
}

function denomRecalc(prefix) {
  let totalCents = 0;
  DENOMS.forEach(d => {
    const key = `${prefix}-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    const subKey = `${prefix}-sub-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    const qty = parseInt(document.getElementById(key)?.value || 0) || 0;
    const subtotalCents = qty * d.cents;
    totalCents += subtotalCents;
    const subEl = document.getElementById(subKey);
    if (subEl) subEl.textContent = '$' + (subtotalCents / 100).toFixed(2);
  });
  const totalEl = document.getElementById(`${prefix}-total`);
  if (totalEl) totalEl.textContent = '$' + (totalCents / 100).toFixed(2);
  return totalCents / 100;
}

function getDenomTotal(prefix) {
  let totalCents = 0;
  DENOMS.forEach(d => {
    const key = `${prefix}-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    const qty = parseInt(document.getElementById(key)?.value || 0) || 0;
    totalCents += qty * d.cents;
  });
  return totalCents / 100;
}

function getDenomCounts(prefix) {
  const counts = {};
  DENOMS.forEach(d => {
    const key = `${prefix}-${d.label.replace(/[^a-z0-9]/gi,'_')}`;
    counts[d.label] = parseInt(document.getElementById(key)?.value || 0) || 0;
  });
  return counts;
}

function openOpenDrawer() {
  openModal('Open Drawer — ' + formatDate(new Date().toISOString().slice(0,10)), `
    <div style="margin-bottom:14px;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);font-size:12px;color:var(--text-muted);">
      Count every bill and coin in the starting drawer. This becomes the opening float for today.
    </div>
    ${denomCounterHTML('od', null)}
    <div class="form-group" style="margin-top:14px;">
      <label class="form-label">Notes (optional)</label>
      <input class="form-input" id="od-notes" placeholder="e.g. Pulled from safe, verified by manager…">
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Open Drawer', cls: 'btn-accent', action: () => {
      const total = getDenomTotal('od');
      const counts = getDenomCounts('od');
      const notes = document.getElementById('od-notes').value.trim();
      drawerFloat = total;
      drawerOpen = true;
      cashEntries.push({ id:'open-'+Date.now(), woId:null, customer:'— Drawer Opened —', device: notes||'Opening count', method:'Cash', amount:0, time:now(), type:'open', date:new Date().toISOString().slice(0,10), denomCounts: counts });
      closeModalDirect();
      notify('Drawer opened · Starting float: $' + total.toFixed(2));
      renderDrawerPage();
    }}
  ]);
  // trigger initial recalc after modal renders
  setTimeout(() => denomRecalc('od'), 80);
}

function openCloseDrawer() {
  if (!isAdminOrManager()) { notify('Manager access required.'); return; }
  if (isAdmin()) { requireAdminPIN(_doOpenCloseDrawer, 'Close drawer requires admin PIN'); return; }
  _doOpenCloseDrawer();
}
function _doOpenCloseDrawer() {
  const today = new Date().toISOString().slice(0,10);
  const cashToday = cashEntries.filter(e=>e.date===today&&e.method==='Cash'&&e.type==='payment').reduce((s,e)=>s+e.amount,0);
  const expected  = drawerFloat + cashToday;

  openModal('Close Drawer — ' + formatDate(today), `
    <div style="border:1px solid var(--border);padding:12px 14px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Opening Float</div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--text);">$${drawerFloat.toFixed(2)}</div>
      </div>
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Cash Collected</div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--green);">+$${cashToday.toFixed(2)}</div>
      </div>
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Expected Total</div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--accent);">$${expected.toFixed(2)}</div>
      </div>
    </div>

    <div style="margin-bottom:6px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);">Physical Count — count every bill and coin in the drawer</div>
    ${denomCounterHTML('cd', null)}

    <div style="margin-top:16px;padding:12px 14px;border:1px solid var(--border);background:var(--bg);display:flex;justify-content:space-between;align-items:center;" id="cd-diff-row">
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);">Difference vs Expected</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">Counted Total − $${expected.toFixed(2)} expected</div>
      </div>
      <div id="cd-diff" style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--text-muted);">—</div>
    </div>

    <div class="form-grid" style="margin-top:14px;">
      <div class="form-group">
        <label class="form-label">Next Day Float ($)</label>
        <input class="form-input" id="cd-nextfloat" type="number" value="${drawerFloat.toFixed(2)}" style="font-family:'IBM Plex Mono',monospace;">
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input class="form-input" id="cd-notes" placeholder="e.g. Deposited $400 to bank…">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost', action: closeModalDirect },
    { label: 'Close Day & Save', cls: 'btn-accent', action: () => {
      const count     = getDenomTotal('cd');
      const counts    = getDenomCounts('cd');
      const nextFloat = parseFloat(document.getElementById('cd-nextfloat').value) || drawerFloat;
      const notes     = document.getElementById('cd-notes').value.trim();
      drawerSessions.unshift({ id:'session-'+Date.now(), date:today, openedBy:(currentUser?.name||'Admin'), openedAt:today+' 09:00', closedAt:now(), openingFloat:drawerFloat, closingCount:count, closingCounts:counts, status:'Closed', notes });
      drawerFloat = nextFloat;
      drawerOpen = false;
      closeModalDirect();
      const diff = count - expected;
      notify('Day closed · ' + (Math.abs(diff)<0.01 ? 'Drawer balanced ✓' : `Difference: ${diff>=0?'+':''}$${diff.toFixed(2)}`));
      renderDrawerPage();
    }}
  ]);

  // Wire up live diff update after modal renders
  setTimeout(() => {
    denomRecalc('cd');
    // patch denomRecalc to also update diff display
    const orig = window._cdOrig || denomRecalc;
    document.querySelectorAll('[id^="cd-"]').forEach(el => {
      if (el.tagName === 'INPUT' && el.type === 'number' && el.id !== 'cd-nextfloat') {
        el.addEventListener('input', () => {
          const counted = getDenomTotal('cd');
          const diff = counted - expected;
          const diffEl = document.getElementById('cd-diff');
          if (diffEl) {
            diffEl.textContent = (diff >= 0 ? '+' : '') + '$' + Math.abs(diff).toFixed(2);
            diffEl.style.color = Math.abs(diff) < 0.01 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--orange)';
          }
        });
      }
    });
  }, 80);
}

// ── APPEARANCE SYSTEM ────────────────────────────────────────────

const THEMES = [
  {
    id: 'dark',
    name: 'Dark (Default)',
    preview: ['#0f0f0f','#181818','#2e2e2e','#f0f0f0'],
    vars: { '--bg':'#0f0f0f','--surface':'#181818','--surface2':'#222222','--border':'#2e2e2e','--text':'#f0f0f0','--text-muted':'#888','--text-dim':'#555' }
  },
  {
    id: 'midnight',
    name: 'Midnight Blue',
    preview: ['#0a0e1a','#111827','#1e2a3a','#e8eef8'],
    vars: { '--bg':'#0a0e1a','--surface':'#111827','--surface2':'#1a2538','--border':'#1e2a3a','--text':'#e8eef8','--text-muted':'#7a8fa6','--text-dim':'#3d5268' }
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    preview: ['#1a1a1a','#242424','#333333','#eeeeee'],
    vars: { '--bg':'#1a1a1a','--surface':'#242424','--surface2':'#2e2e2e','--border':'#3a3a3a','--text':'#eeeeee','--text-muted':'#909090','--text-dim':'#5a5a5a' }
  },
  {
    id: 'espresso',
    name: 'Espresso',
    preview: ['#18100c','#221610','#352318','#f2e8df'],
    vars: { '--bg':'#18100c','--surface':'#221610','--surface2':'#2c1e14','--border':'#3d2a1c','--text':'#f2e8df','--text-muted':'#9e8070','--text-dim':'#5c3e30' }
  },
  {
    id: 'slate',
    name: 'Slate',
    preview: ['#0f1117','#161b27','#232d3f','#dde3ef'],
    vars: { '--bg':'#0f1117','--surface':'#161b27','--surface2':'#1e2636','--border':'#2a3448','--text':'#dde3ef','--text-muted':'#6e7f99','--text-dim':'#3d4f66' }
  },
  {
    id: 'light',
    name: 'Light',
    preview: ['#f5f5f5','#ffffff','#e8e8e8','#111111'],
    vars: { '--bg':'#f5f5f5','--surface':'#ffffff','--surface2':'#f0f0f0','--border':'#dcdcdc','--text':'#111111','--text-muted':'#666666','--text-dim':'#aaaaaa' }
  },
  {
    id: 'paper',
    name: 'Paper',
    preview: ['#faf7f2','#ffffff','#ede8df','#1a1612'],
    vars: { '--bg':'#faf7f2','--surface':'#ffffff','--surface2':'#f5f0e8','--border':'#ddd5c8','--text':'#1a1612','--text-muted':'#7a6e62','--text-dim':'#b8ad9e' }
  },
  {
    id: 'forest',
    name: 'Forest Dark',
    preview: ['#0d1a0e','#122015','#1c3020','#dff0e0'],
    vars: { '--bg':'#0d1a0e','--surface':'#122015','--surface2':'#182c1c','--border':'#243d28','--text':'#dff0e0','--text-muted':'#72996e','--text-dim':'#3a5c38' }
  },
];

const ACCENTS = [
  { id: 'yellow',  name: 'Yellow',    color: '#e8ff47', dim: '#b8cc2f' },
  { id: 'cyan',    name: 'Cyan',      color: '#00d4ff', dim: '#009dbe' },
  { id: 'green',   name: 'Green',     color: '#3dff8f', dim: '#22cc66' },
  { id: 'orange',  name: 'Orange',    color: '#ff8c3a', dim: '#cc6318' },
  { id: 'pink',    name: 'Pink',      color: '#ff5cae', dim: '#cc2e82' },
  { id: 'purple',  name: 'Purple',    color: '#b36dff', dim: '#8844cc' },
  { id: 'red',     name: 'Red',       color: '#ff4d4d', dim: '#cc2222' },
  { id: 'white',   name: 'White',     color: '#ffffff', dim: '#cccccc' },
  { id: 'sky',     name: 'Sky Blue',  color: '#60a5fa', dim: '#3b82f6' },
  { id: 'lime',    name: 'Lime',      color: '#a3e635', dim: '#65a30d' },
  { id: 'gold',    name: 'Gold',      color: '#fbbf24', dim: '#d97706' },
  { id: 'teal',    name: 'Teal',      color: '#2dd4bf', dim: '#0d9488' },
];

const BODY_FONTS = [
  { id: 'ibm',       name: 'IBM Plex Sans',      family: "'IBM Plex Sans', sans-serif",      mono: "'IBM Plex Mono', monospace" },
  { id: 'inter',     name: 'Inter',               family: "'Inter', sans-serif",               mono: "'IBM Plex Mono', monospace" },
  { id: 'dm',        name: 'DM Sans',             family: "'DM Sans', sans-serif",             mono: "'IBM Plex Mono', monospace" },
  { id: 'outfit',    name: 'Outfit',              family: "'Outfit', sans-serif",              mono: "'IBM Plex Mono', monospace" },
  { id: 'jakarta',   name: 'Plus Jakarta Sans',   family: "'Plus Jakarta Sans', sans-serif",   mono: "'IBM Plex Mono', monospace" },
  { id: 'urbanist',  name: 'Urbanist',            family: "'Urbanist', sans-serif",            mono: "'IBM Plex Mono', monospace" },
  { id: 'space',     name: 'Space Grotesk',       family: "'Space Grotesk', sans-serif",       mono: "'Geist Mono', monospace" },
  { id: 'geist',     name: 'Geist Mono (all)',    family: "'Geist Mono', monospace",           mono: "'Geist Mono', monospace" },
  { id: 'jetbrains', name: 'JetBrains Mono (all)',family: "'JetBrains Mono', monospace",       mono: "'JetBrains Mono', monospace" },
];

const DISPLAY_FONTS = [
  { id: 'syne',      name: 'Syne',               family: "'Syne', sans-serif" },
  { id: 'inter',     name: 'Inter',              family: "'Inter', sans-serif" },
  { id: 'dm',        name: 'DM Sans',            family: "'DM Sans', sans-serif" },
  { id: 'outfit',    name: 'Outfit',             family: "'Outfit', sans-serif" },
  { id: 'jakarta',   name: 'Plus Jakarta Sans',  family: "'Plus Jakarta Sans', sans-serif" },
  { id: 'urbanist',  name: 'Urbanist',           family: "'Urbanist', sans-serif" },
  { id: 'space',     name: 'Space Grotesk',      family: "'Space Grotesk', sans-serif" },
  { id: 'geist',     name: 'Geist Mono',         family: "'Geist Mono', monospace" },
];

// Current selections
let currentTheme   = 'dark';
let currentAccent  = 'yellow';
let currentFont    = 'ibm';
let currentDisplay = 'syne';

function applyTheme(themeId) {
  const t = THEMES.find(x => x.id === themeId);
  if (!t) return;
  currentTheme = themeId;
  const root = document.documentElement;
  Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
  saveAppearance();
  updateTopbarModeIcon();
}

function applyAccent(accentId) {
  const a = ACCENTS.find(x => x.id === accentId);
  if (!a) return;
  currentAccent = accentId;
  const root = document.documentElement;
  root.style.setProperty('--accent', a.color);
  root.style.setProperty('--accent-dim', a.dim);
  // Update nav active button color to match
  saveAppearance();
}

function applyFont(fontId) {
  const f = BODY_FONTS.find(x => x.id === fontId);
  if (!f) return;
  currentFont = fontId;
  document.body.style.fontFamily = f.family;
  // Update mono font via a style tag
  let monoStyle = document.getElementById('mono-font-override');
  if (!monoStyle) { monoStyle = document.createElement('style'); monoStyle.id = 'mono-font-override'; document.head.appendChild(monoStyle); }
  monoStyle.textContent = `
    .td-mono, .form-label, .log-meta, .inv-card-sku, .card-label,
    [style*="IBM Plex Mono"] { font-family: ${f.mono} !important; }
    input.form-input, select.form-select, .form-input, .form-select { font-family: ${f.mono} !important; }
  `;
  saveAppearance();
}

function applyDisplayFont(fontId) {
  const f = DISPLAY_FONTS.find(x => x.id === fontId);
  if (!f) return;
  currentDisplay = fontId;
  let dispStyle = document.getElementById('display-font-override');
  if (!dispStyle) { dispStyle = document.createElement('style'); dispStyle.id = 'display-font-override'; document.head.appendChild(dispStyle); }
  dispStyle.textContent = `
    .topbar-logo, .page-title, .stat-num, .login-logo, .modal-title,
    [style*="Syne"] { font-family: ${f.family} !important; }
  `;
  saveAppearance();
}

function saveAppearance() {
  try { localStorage.setItem('smr_appearance', JSON.stringify({ theme: currentTheme, accent: currentAccent, font: currentFont, display: currentDisplay })); } catch(e){}
  refreshAppearancePanel();
}

function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem('smr_appearance') || '{}');
    if (saved.theme)   applyTheme(saved.theme);
    if (saved.accent)  applyAccent(saved.accent);
    if (saved.font)    applyFont(saved.font);
    if (saved.display) applyDisplayFont(saved.display);
  } catch(e) {}
}

function resetAppearance() {
  currentTheme = 'dark'; currentAccent = 'yellow'; currentFont = 'ibm'; currentDisplay = 'syne';
  // Remove all overrides
  document.documentElement.removeAttribute('style');
  document.body.style.fontFamily = '';
  ['mono-font-override','display-font-override'].forEach(id => { const el = document.getElementById(id); if(el) el.remove(); });
  try { localStorage.removeItem('smr_appearance'); } catch(e){}
  refreshAppearancePanel();
  notify('Appearance reset to default');
}

function topbarToggleMode() {
  if (isLightMode()) {
    quickSetMode('dark');
  } else {
    quickSetMode('light');
  }
  updateTopbarModeIcon();
}

function updateTopbarModeIcon() {
  const icon = document.getElementById('topbar-mode-icon');
  if (!icon) return;
  if (isLightMode()) {
    // Show moon (switch to dark)
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else {
    // Show sun (switch to light)
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
}

function quickSetMode(mode) {
  if (mode === 'dark') {
    const lightThemes = ['light', 'paper'];
    if (lightThemes.includes(currentTheme)) {
      applyTheme('dark');
    }
    refreshAppearancePanel();
    updateTopbarModeIcon();
    notify('Dark mode active');
  } else {
    applyTheme('light');
    updateTopbarModeIcon();
    notify('Light mode active');
  }
}

function isLightMode() {
  return ['light', 'paper'].includes(currentTheme);
}

function openAppearancePanel() {
  refreshAppearancePanel();
  document.getElementById('appearance-overlay').style.display = 'block';
  const panel = document.getElementById('appearance-panel');
  panel.style.display = 'block';
  requestAnimationFrame(() => panel.style.transform = 'translateX(0)');
}

function closeAppearancePanel() {
  const panel = document.getElementById('appearance-panel');
  panel.style.transform = 'translateX(100%)';
  setTimeout(() => {
    panel.style.display = 'none';
    document.getElementById('appearance-overlay').style.display = 'none';
  }, 260);
}

function refreshAppearancePanel() {
  // Mode toggle buttons
  const lightMode = isLightMode();
  const darkBtn  = document.getElementById('mode-btn-dark');
  const lightBtn = document.getElementById('mode-btn-light');
  if (darkBtn) {
    darkBtn.style.borderColor = !lightMode ? 'var(--accent)' : 'var(--border)';
    darkBtn.style.background  = !lightMode ? 'var(--surface2)' : 'transparent';
    darkBtn.style.color       = !lightMode ? 'var(--text)' : 'var(--text-muted)';
  }
  if (lightBtn) {
    lightBtn.style.borderColor = lightMode ? 'var(--accent)' : 'var(--border)';
    lightBtn.style.background  = lightMode ? 'var(--surface2)' : 'transparent';
    lightBtn.style.color       = lightMode ? 'var(--text)' : 'var(--text-muted)';
  }

  // Themes
  const ts = document.getElementById('theme-swatches');
  if (ts) ts.innerHTML = THEMES.map(t => `
    <button onclick="applyTheme('${t.id}')" style="display:flex;align-items:center;gap:12px;background:${currentTheme===t.id?'var(--surface2)':'transparent'};border:1px solid ${currentTheme===t.id?'var(--accent)':'var(--border)'};padding:10px 12px;cursor:pointer;width:100%;text-align:left;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='${currentTheme===t.id?'var(--accent)':'var(--border)'}'">
      <div style="display:flex;gap:3px;flex-shrink:0;">
        ${t.preview.map(c=>`<div style="width:14px;height:28px;background:${c};border-radius:1px;"></div>`).join('')}
      </div>
      <div>
        <div style="font-size:13px;font-weight:500;color:var(--text);">${t.name}</div>
      </div>
      ${currentTheme===t.id?`<div style="margin-left:auto;font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--accent);letter-spacing:1px;">ACTIVE</div>`:''}
    </button>
  `).join('');

  // Accents
  const as = document.getElementById('accent-swatches');
  if (as) as.innerHTML = ACCENTS.map(a => `
    <button onclick="applyAccent('${a.id}')" title="${a.name}" style="width:32px;height:32px;background:${a.color};border:2px solid ${currentAccent===a.id?'var(--text)':'transparent'};cursor:pointer;transition:all 0.15s;border-radius:2px;" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='scale(1)'"></button>
  `).join('');

  // Body fonts
  const ff = document.getElementById('font-options');
  if (ff) ff.innerHTML = BODY_FONTS.map(f => `
    <button onclick="applyFont('${f.id}')" style="display:flex;align-items:center;justify-content:space-between;background:${currentFont===f.id?'var(--surface2)':'transparent'};border:1px solid ${currentFont===f.id?'var(--accent)':'var(--border)'};padding:10px 14px;cursor:pointer;width:100%;text-align:left;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='${currentFont===f.id?'var(--accent)':'var(--border)'}'">
      <span style="font-family:${f.family};font-size:14px;color:var(--text);">${f.name}</span>
      <span style="font-family:${f.family};font-size:11px;color:var(--text-muted);">Aa Bb 123</span>
      ${currentFont===f.id?`<span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--accent);letter-spacing:1px;margin-left:8px;">✓</span>`:''}
    </button>
  `).join('');

  // Display fonts
  const df = document.getElementById('display-font-options');
  if (df) df.innerHTML = DISPLAY_FONTS.map(f => `
    <button onclick="applyDisplayFont('${f.id}')" style="display:flex;align-items:center;justify-content:space-between;background:${currentDisplay===f.id?'var(--surface2)':'transparent'};border:1px solid ${currentDisplay===f.id?'var(--accent)':'var(--border)'};padding:10px 14px;cursor:pointer;width:100%;text-align:left;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='${currentDisplay===f.id?'var(--accent)':'var(--border)'}'">
      <span style="font-family:${f.family};font-size:16px;font-weight:700;color:var(--text);">${f.name}</span>
      <span style="font-family:${f.family};font-size:20px;font-weight:800;color:var(--text-muted);">Aa</span>
      ${currentDisplay===f.id?`<span style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--accent);letter-spacing:1px;margin-left:8px;">✓</span>`:''}
    </button>
  `).join('');
}


// ── DASHBOARD ────────────────────────────────────────────────────

// Alert state: dismissed = gone until page refresh, muted = persisted to localStorage
// Each alert has a stable key so mute survives navigation
let dismissedAlerts = new Set();
let mutedAlerts = new Set();

function loadMutedAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem('smr_muted_alerts') || '[]');
    mutedAlerts = new Set(saved);
  } catch(e) {}
}

function saveMutedAlerts() {
  try {
    localStorage.setItem('smr_muted_alerts', JSON.stringify([...mutedAlerts]));
  } catch(e) {}
}

function dismissAlert(key) {
  dismissedAlerts.add(key);
  const el = document.getElementById('alert-' + key);
  if (el) {
    el.style.maxHeight = el.scrollHeight + 'px';
    el.style.overflow = 'hidden';
    el.style.transition = 'max-height 0.25s ease, opacity 0.2s ease, padding 0.25s ease';
    requestAnimationFrame(() => {
      el.style.maxHeight = '0';
      el.style.opacity = '0';
      el.style.paddingTop = '0';
      el.style.paddingBottom = '0';
      el.style.marginBottom = '0';
    });
    setTimeout(() => {
      el.remove();
      const box = document.getElementById('alerts-box');
      if (box && !box.querySelector('.alert-item')) {
        box.innerHTML = `<div style="padding:10px 0;font-size:12px;color:var(--text-muted);font-family:\'IBM Plex Mono\',monospace;">No active alerts</div>`;
      }
      updateAlertBadge();
    }, 280);
  }
}

function muteAlert(key) {
  mutedAlerts.add(key);
  saveMutedAlerts();
  dismissAlert(key);
}

function unmuteAllAlerts() {
  mutedAlerts.clear();
  saveMutedAlerts();
  renderDashboard();
}

function updateAlertBadge() {
  const alerts = buildAlerts().filter(a => !dismissedAlerts.has(a.key) && !mutedAlerts.has(a.key));
  const badge = document.getElementById('home-alert-badge');
  if (badge) {
    badge.textContent = alerts.length;
    badge.style.display = alerts.length > 0 ? 'inline-block' : 'none';
  }
}

function buildAlerts() {
  const alerts = [];

  // Out-of-stock parts
  inventory.forEach(p => {
    if (p.qty === 0) {
      alerts.push({
        key: 'outofstock-' + p.id,
        type: 'danger',
        title: p.name + ' — out of stock',
        sub: 'SKU ' + p.sku,
        canMute: true,
      });
    } else if (p.qty < p.minQty) {
      alerts.push({
        key: 'lowstock-' + p.id,
        type: 'warn',
        title: p.name + ' — low stock (' + p.qty + ' left)',
        sub: 'Min qty is ' + p.minQty,
        canMute: true,
      });
    }
  });

  // Overdue pickups — completed WOs older than 3 days
  const now = new Date('2026-03-12');
  workOrders.forEach(wo => {
    if (wo.status === 'Repaired' || wo.status === 'Completed') {
      const created = new Date(wo.created || '2026-03-01');
      const days = Math.floor((now - created) / 86400000);
      if (days >= 3) {
        const cust = customers.find(c => c.id === wo.customerId);
        const name = cust ? cust.first + ' ' + cust.last : 'Unknown';
        alerts.push({
          key: 'pickup-' + wo.id,
          type: 'warn',
          title: wo.id + ' — ' + name + ' pickup overdue',
          sub: days + ' days since status update',
          canMute: false,
        });
      }
    }
  });

  // Incoming POs expected today or past
  purchaseOrders.forEach(po => {
    if (po.status === 'Open' || po.status === 'Partial') {
      const exp = new Date(po.expectedDate);
      if (exp <= now) {
        alerts.push({
          key: 'po-due-' + po.id,
          type: 'info',
          title: po.id + ' expected today from ' + po.supplier,
          sub: po.lines.length + ' line item' + (po.lines.length !== 1 ? 's' : ''),
          canMute: false,
        });
      }
    }
  });

  return alerts;
}

function renderDashboard() {
  const el = document.getElementById('home-content');
  if (!el) return;

  // KPI calcs
  const open = workOrders.filter(w => !['Completed','Unrepairable','Client Declined'].includes(w.status)).length;
  const ready = workOrders.filter(w => w.status === 'Repaired').length;
  const todayRevenue = workOrders.filter(w => w.status === 'Completed').reduce((s,w) => s + (w.estimate||0), 0) + 480;
  const lowStock = inventory.filter(p => p.qty <= p.minQty).length;

  // Revenue sparkline — 7 synthetic days
  const spark = [55, 38, 72, 45, 83, 61, 90];
  const sparkMax = Math.max(...spark);

  // Tech load
  const techLoad = {};
  getTechs().filter(t => t !== 'Unassigned').forEach(t => techLoad[t] = 0);
  workOrders.filter(w => !['Completed','Unrepairable','Client Declined'].includes(w.status)).forEach(w => {
    if (w.tech && w.tech !== 'Unassigned') techLoad[w.tech] = (techLoad[w.tech]||0) + 1;
  });
  const maxLoad = Math.max(...Object.values(techLoad), 1);

  // Device breakdown
  const devMap = {};
  workOrders.forEach(w => {
    const t = w.device.toLowerCase().includes('iphone') ? 'iPhone'
            : w.device.toLowerCase().includes('samsung') || w.device.toLowerCase().includes('galaxy') ? 'Samsung'
            : w.device.toLowerCase().includes('ipad') ? 'iPad'
            : w.device.toLowerCase().includes('macbook') || w.device.toLowerCase().includes('mac') ? 'MacBook'
            : 'Other';
    devMap[t] = (devMap[t]||0) + 1;
  });
  const devEntries = Object.entries(devMap).sort((a,b) => b[1]-a[1]);
  const devTotal = devEntries.reduce((s,e) => s+e[1], 0);
  const devColors = ['var(--blue)','var(--purple)','var(--cyan)','var(--orange)','var(--text-muted)'];

  // Alerts
  const allAlerts = buildAlerts().filter(a => !dismissedAlerts.has(a.key) && !mutedAlerts.has(a.key));
  const mutedCount = mutedAlerts.size;

  // Recent WOs (top 5 active)
  const activeWOs = workOrders.filter(w => !['Completed','Unrepairable','Client Declined'].includes(w.status)).slice(0, 5);

  // Greeting
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date('2026-03-12').toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});

  el.innerHTML = `
    <div style="padding:0 0 32px;">

      <!-- Greeting -->
      <div style="margin-bottom:24px;">
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;">${greet}, ${currentUser?.name||'Admin'} 👋</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);letter-spacing:1px;margin-top:3px;">${dateStr.toUpperCase()} · ${storeSettings.name.toUpperCase()}</div>
      </div>

      <!-- KPI Row -->
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px;">
        <div style="background:var(--surface);padding:18px 20px;">
          <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--cyan);">${open}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Open Repairs</div>
        </div>
        <div style="background:var(--surface);padding:18px 20px;">
          <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--green);">${ready}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Ready for Pickup</div>
        </div>
        <div style="background:var(--surface);padding:18px 20px;">
          <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:var(--accent);">$${todayRevenue.toLocaleString()}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Today's Revenue</div>
        </div>
        <div style="background:var(--surface);padding:18px 20px;" onclick="if(${lowStock}>0)showPage('parts',document.querySelector('.nav-btn:nth-child(5)'))">
          <div style="font-family:'Syne',sans-serif;font-size:32px;font-weight:800;color:${lowStock>0?'var(--red)':'var(--text-muted)'};">${lowStock}</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Low / Out of Stock</div>
        </div>
      </div>

      <!-- Main grid: WOs + Alerts -->
      <div style="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;margin-bottom:16px;">

        <!-- Active Work Orders -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div class="card-label">Active Work Orders</div>
            <button class="btn btn-ghost btn-sm" onclick="showPage('work-orders',document.querySelector('.nav-btn:nth-child(2)'))">View all →</button>
          </div>
          ${activeWOs.length === 0 ? '<div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);padding:8px 0;">No active work orders</div>' :
            activeWOs.map(wo => {
              const cust = customers.find(c => c.id === wo.customerId);
              const name = cust ? cust.first + ' ' + cust.last : 'Unknown';
              const cls = STATUS_MAP[wo.status] || '';
              return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="showWODetail('${wo.id}')" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);min-width:68px;">${wo.id}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
                  <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wo.device}</div>
                </div>
                <span class="status-badge ${cls}" style="font-size:9px;padding:2px 7px;flex-shrink:0;">${wo.status}</span>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--green);min-width:44px;text-align:right;flex-shrink:0;">$${(wo.estimate||0).toFixed(0)}</div>
              </div>`;
            }).join('')
          }
        </div>

        <!-- Alerts -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div class="card-label" style="display:flex;align-items:center;gap:6px;">
              Alerts
              <span id="home-alert-badge" style="background:var(--red);color:#fff;font-family:\'IBM Plex Mono\',monospace;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;display:${allAlerts.length>0?'inline-block':'none'}">${allAlerts.length}</span>
            </div>
            ${mutedCount > 0 ? `<button class="btn btn-ghost btn-sm" onclick="unmuteAllAlerts()" title="Restore ${mutedCount} muted alert${mutedCount>1?'s':''}">Unmute ${mutedCount}</button>` : ''}
          </div>
          <div id="alerts-box">
            ${allAlerts.length === 0
              ? `<div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);">No active alerts${mutedCount>0?' · '+mutedCount+' muted':''}</div>`
              : allAlerts.map(a => {
                const dotColor = a.type === 'danger' ? 'var(--red)' : a.type === 'warn' ? 'var(--orange)' : 'var(--blue)';
                return `<div class="alert-item" id="alert-${a.key}" style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
                  <div style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0;margin-top:5px;"></div>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;font-weight:500;line-height:1.4;">${a.title}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:1px;">${a.sub}</div>
                  </div>
                  <div style="display:flex;gap:4px;flex-shrink:0;margin-top:2px;">
                    <button onclick="dismissAlert('${a.key}')" title="Dismiss for this session" style="background:none;border:1px solid var(--border);color:var(--text-muted);cursor:pointer;padding:2px 7px;font-size:10px;font-family:\'IBM Plex Mono\',monospace;border-radius:2px;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--text-muted)'" onmouseout="this.style.borderColor='var(--border)'">✕</button>
                    ${a.canMute ? `<button onclick="muteAlert('${a.key}')" title="Mute permanently (won't show again)" style="background:none;border:1px solid var(--border);color:var(--text-muted);cursor:pointer;padding:2px 7px;font-size:10px;font-family:\'IBM Plex Mono\',monospace;border-radius:2px;transition:all 0.15s;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'">Mute</button>` : ''}
                  </div>
                </div>`;
              }).join('')
            }
          </div>
        </div>
      </div>

      <!-- Bottom row: Revenue + Tech Load + Device Breakdown -->
      <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr);gap:16px;margin-bottom:16px;">

        <!-- Revenue sparkline -->
        <div class="card">
          <div class="card-label" style="margin-bottom:14px;">Revenue — Last 7 Days</div>
          <div style="display:flex;align-items:flex-end;gap:4px;height:72px;margin-bottom:8px;">
            ${spark.map((v,i) => `<div style="flex:1;background:var(--accent);opacity:${i===6?'1':'0.45'};border-radius:2px 2px 0 0;height:${Math.round(v/sparkMax*100)}%;min-height:3px;transition:opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity='${i===6?1:0.45}'"></div>`).join('')}
          </div>
          <div style="display:flex;gap:4px;margin-bottom:12px;">
            ${['F','S','S','M','T','W','T'].map(d => `<div style="flex:1;font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-dim);text-align:center;">${d}</div>`).join('')}
          </div>
          <div style="font-family:'Syne',sans-serif;font-size:26px;font-weight:800;color:var(--accent);">$3,840</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);margin-top:2px;">THIS WEEK · ▲ 8% VS LAST</div>
        </div>

        <!-- Tech Load -->
        <div class="card">
          <div class="card-label" style="margin-bottom:14px;">Technician Load</div>
          ${Object.entries(techLoad).map(([name, count]) => {
            const initials = name.split(' ').map(p=>p[0]).join('');
            const pct = Math.round(count / maxLoad * 100);
            const barColor = pct >= 80 ? 'var(--orange)' : pct >= 50 ? 'var(--cyan)' : 'var(--green)';
            return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:\'IBM Plex Mono\',monospace;font-size:10px;font-weight:700;color:var(--accent);flex-shrink:0;">${initials}</div>
              <div style="font-size:12px;font-weight:500;min-width:58px;">${name}</div>
              <div style="flex:1;height:5px;background:var(--surface2);border-radius:3px;">
                <div style="height:5px;background:${barColor};width:${count===0?'3px':pct+'%'};border-radius:3px;transition:width 0.4s;min-width:3px;"></div>
              </div>
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);min-width:36px;text-align:right;">${count} job${count!==1?'s':''}</div>
            </div>`;
          }).join('')}
          <div style="padding-top:10px;border-top:1px solid var(--border);font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);">
            ${open} open · ${workOrders.filter(w=>w.status==='Completed').length} completed today
          </div>
        </div>

        <!-- Device Breakdown -->
        <div class="card">
          <div class="card-label" style="margin-bottom:14px;">Repairs by Device</div>
          ${devEntries.map(([type, count], i) => {
            const pct = devTotal > 0 ? Math.round(count/devTotal*100) : 0;
            return `<div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:12px;font-weight:500;">${type}</span>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:${devColors[i]||'var(--text-muted)'};">${count} <span style="color:var(--text-dim)">(${pct}%)</span></span>
              </div>
              <div style="height:4px;background:var(--surface2);border-radius:2px;">
                <div style="height:4px;background:${devColors[i]||'var(--text-muted)'};width:${pct}%;border-radius:2px;transition:width 0.4s;"></div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="card">
        <div class="card-label" style="margin-bottom:14px;">Quick Actions</div>
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
          ${[
            ['checkin','2','New Check-In','Start device intake','var(--purple)'],
            ['work-orders','2','View Work Orders','All active repairs','var(--cyan)'],
            ['parts','5','Order Parts','Inventory & POs','var(--orange)'],
            ['drawer','6','Cash Drawer','Payments & float','var(--green)'],
          ].map(([page, nthChild, label, sub, color]) => `
            <button onclick="showPage('${page}',document.querySelector('.nav-btn:nth-child(${nthChild})'))" style="background:var(--surface);border:1px solid var(--border);padding:14px 16px;text-align:left;cursor:pointer;transition:all 0.15s;border-radius:2px;" onmouseover="this.style.borderColor='${color}';this.style.background='var(--surface2)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--surface)'">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;">${label}</div>
              <div style="font-size:11px;color:var(--text-muted);">${sub}</div>
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ── REPORTS ──────────────────────────────────────────────────────

// Generate synthetic daily revenue data seeded from real work orders
function getRevenueData(days) {
  const today = new Date('2026-03-12');
  const data = [];
  // Base from real completed WOs + synthetic history
  const completedRevenue = workOrders.filter(w=>w.status==='Completed').reduce((s,w)=>s+(w.estimate||0),0);
  const seed = [420,380,510,295,640,580,490,720,410,550,610,380,470,530,660,390,480,590,440,710,360,520,575,430,615,490,350,680,540,460];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const val = seed[i % seed.length] + (i === 0 ? completedRevenue * 0.4 : 0);
    data.push({ label, value: Math.round(val) });
  }
  return data;
}

function renderReportsPage() {
  const days = parseInt(document.getElementById('report-range')?.value || '30');
  const revenueData = getRevenueData(days);
  const totalRevenue = revenueData.reduce((s,d)=>s+d.value, 0);
  const avgPerDay = Math.round(totalRevenue / days);

  // Repairs by device type from WO data
  const deviceMap = {};
  workOrders.forEach(w => {
    const type = w.device.includes('iPhone') ? 'iPhone'
               : w.device.includes('Samsung') || w.device.includes('Galaxy') ? 'Samsung'
               : w.device.includes('iPad') ? 'iPad'
               : w.device.includes('MacBook') || w.device.includes('Mac') ? 'MacBook'
               : 'Other';
    deviceMap[type] = (deviceMap[type]||0) + 1;
  });
  const deviceEntries = Object.entries(deviceMap).sort((a,b)=>b[1]-a[1]);
  const totalDevices = deviceEntries.reduce((s,e)=>s+e[1],0);

  // Tech performance
  const techMap = {};
  workOrders.forEach(w => {
    const t = w.tech || 'Unassigned';
    if (!techMap[t]) techMap[t] = { jobs:0, revenue:0, completed:0 };
    techMap[t].jobs++;
    techMap[t].revenue += w.estimate || 0;
    if (w.status === 'Completed') techMap[t].completed++;
  });
  const techEntries = Object.entries(techMap).filter(([t])=>t!=='Unassigned').sort((a,b)=>b[1].revenue-a[1].revenue);

  // Status breakdown
  const statusCounts = {};
  workOrders.forEach(w => { statusCounts[w.status] = (statusCounts[w.status]||0)+1; });

  const deviceColors = ['var(--accent)','var(--cyan)','var(--purple)','var(--orange)','var(--blue)'];
  const maxBar = Math.max(...revenueData.map(d=>d.value));

  // Slice labels for chart — show fewer for long ranges
  const labelStep = days > 30 ? Math.ceil(days/14) : days > 14 ? 3 : 1;
  const chartData = revenueData.filter((_,i) => (revenueData.length-1-i) % labelStep === 0 || i === revenueData.length-1);

  document.getElementById('reports-content').innerHTML = `
    <!-- KPI Row -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:24px;">
      <div style="background:var(--surface);padding:20px 22px;">
        <div style="font-family:'Syne',sans-serif;font-size:30px;font-weight:800;color:var(--accent);">$${totalRevenue.toLocaleString()}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Total Revenue</div>
      </div>
      <div style="background:var(--surface);padding:20px 22px;">
        <div style="font-family:'Syne',sans-serif;font-size:30px;font-weight:800;color:var(--cyan);">${workOrders.length}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Total Repairs</div>
      </div>
      <div style="background:var(--surface);padding:20px 22px;">
        <div style="font-family:'Syne',sans-serif;font-size:30px;font-weight:800;color:var(--green);">$${avgPerDay.toLocaleString()}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Avg / Day</div>
      </div>
      <div style="background:var(--surface);padding:20px 22px;">
        <div style="font-family:'Syne',sans-serif;font-size:30px;font-weight:800;color:var(--purple);">${workOrders.filter(w=>w.status==='Completed').length}</div>
        <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Completed</div>
      </div>
    </div>

    <!-- Revenue Chart + Device Breakdown -->
    <div style="display:grid;grid-template-columns:1fr 280px;gap:16px;margin-bottom:16px;">

      <!-- Revenue Bar Chart -->
      <div class="card">
        <div class="card-label" style="margin-bottom:16px;">Revenue — Last ${days} Days</div>
        <div style="display:flex;align-items:flex-end;gap:3px;height:140px;padding-bottom:24px;position:relative;overflow:hidden;">
          ${revenueData.map((d,i) => {
            const pct = maxBar > 0 ? (d.value / maxBar * 100) : 0;
            const showLabel = (revenueData.length - 1 - i) % labelStep === 0;
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative;" title="$${d.value.toLocaleString()} — ${d.label}">
              <div style="width:100%;background:var(--accent);opacity:0.85;border-radius:2px 2px 0 0;height:${pct}%;min-height:${d.value>0?2:0}px;transition:height 0.3s;cursor:pointer;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.85"></div>
              ${showLabel ? `<div style="position:absolute;bottom:-20px;font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-dim);white-space:nowrap;transform:rotate(-40deg);transform-origin:top left;left:50%;">${d.label}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">$0</span>
          <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);">$${maxBar.toLocaleString()}</span>
        </div>
      </div>

      <!-- Device Breakdown -->
      <div class="card">
        <div class="card-label" style="margin-bottom:16px;">Repairs by Device</div>
        ${deviceEntries.map(([type, count], i) => {
          const pct = totalDevices > 0 ? Math.round(count/totalDevices*100) : 0;
          return `<div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:500;">${type}</span>
              <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:${deviceColors[i]||'var(--accent)'};">${count} <span style="color:var(--text-dim)">(${pct}%)</span></span>
            </div>
            <div style="height:5px;background:var(--surface2);border-radius:3px;">
              <div style="height:5px;background:${deviceColors[i]||'var(--accent)'};width:${pct}%;border-radius:3px;transition:width 0.4s;"></div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Tech Performance + Status Breakdown -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">

      <!-- Tech Performance -->
      <div class="card">
        <div class="card-label" style="margin-bottom:14px;">Technician Performance</div>
        <div class="table-wrap" style="margin:0;">
          <table>
            <thead><tr>
              <th>Technician</th>
              <th>Jobs</th>
              <th>Completed</th>
              <th>Revenue</th>
              <th>Rate</th>
            </tr></thead>
            <tbody>
              ${techEntries.map(([name, d]) => {
                const rate = d.jobs > 0 ? Math.round(d.completed/d.jobs*100) : 0;
                const rateColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--orange)' : 'var(--red)';
                return `<tr>
                  <td class="td-primary">${name}</td>
                  <td class="td-mono">${d.jobs}</td>
                  <td class="td-mono" style="color:var(--green)">${d.completed}</td>
                  <td class="td-mono" style="color:var(--accent)">$${d.revenue.toFixed(0)}</td>
                  <td><span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;font-weight:700;color:${rateColor};">${rate}%</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Repair Status Breakdown -->
      <div class="card">
        <div class="card-label" style="margin-bottom:14px;">Repair Status Breakdown</div>
        ${Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]).map(([status, count]) => {
          const cls = STATUS_MAP[status] || '';
          const pct = workOrders.length > 0 ? Math.round(count/workOrders.length*100) : 0;
          return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
            <span class="status-badge ${cls}" style="min-width:140px;text-align:center;">${status}</span>
            <div style="flex:1;height:4px;background:var(--surface2);border-radius:2px;">
              <div style="height:4px;background:var(--accent);opacity:0.7;width:${pct}%;border-radius:2px;"></div>
            </div>
            <span style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-muted);min-width:28px;text-align:right;">${count}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Parts / Inventory Value + Top Parts Used -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="card">
        <div class="card-label" style="margin-bottom:14px;">Inventory Value Summary</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:14px;">
          <div style="background:var(--surface2);padding:14px 16px;">
            <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--accent);">$${inventory.reduce((s,p)=>s+p.cost*p.qty,0).toFixed(0)}</div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Cost Value</div>
          </div>
          <div style="background:var(--surface2);padding:14px 16px;">
            <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--green);">$${inventory.reduce((s,p)=>s+p.price*p.qty,0).toFixed(0)}</div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Retail Value</div>
          </div>
          <div style="background:var(--surface2);padding:14px 16px;">
            <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--red);">${inventory.filter(p=>p.qty===0).length}</div>
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px;">Out of Stock</div>
          </div>
        </div>
        <div class="table-wrap" style="margin:0;">
          <table>
            <thead><tr><th>Part</th><th>Qty</th><th>Cost</th><th>Retail</th></tr></thead>
            <tbody>
              ${inventory.map(p=>`<tr>
                <td class="td-primary" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</td>
                <td><span class="${p.qty===0?'qty-out':p.qty<=p.minQty?'qty-low':'qty-ok'}" style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;font-weight:700;">${p.qty}</span></td>
                <td class="td-mono">$${p.cost.toFixed(2)}</td>
                <td class="td-mono" style="color:var(--accent)">$${p.price.toFixed(2)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recent Activity Feed -->
      <div class="card">
        <div class="card-label" style="margin-bottom:14px;">Recent Activity</div>
        <div style="display:flex;flex-direction:column;gap:0;">
          ${workOrders.slice(0,8).map(wo => {
            const cust = customers.find(c=>c.id===wo.customerId);
            const name = cust ? cust.firstName+' '+cust.lastName : 'Unknown';
            return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--accent);min-width:72px;">${wo.id}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
                <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wo.device}</div>
              </div>
              <span class="status-badge ${STATUS_MAP[wo.status]||''}" style="font-size:9px;padding:2px 6px;">${wo.status}</span>
              <div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--green);min-width:48px;text-align:right;">$${(wo.estimate||0).toFixed(0)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- Time Log -->
    <div class="card" style="margin-top:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div class="card-label">Time Log</div>
        <div style="display:flex;gap:10px;align-items:center;">
          ${clockEntries.some(e => !e.clockOut) ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--green);letter-spacing:1px;">● ${clockEntries.filter(e=>!e.clockOut).length} CLOCKED IN</span>` : ''}
          ${clockEntries.length > 0 ? `<button class="btn btn-ghost btn-sm" onclick="exportClockCSV()">⬇ Export CSV</button>` : ''}
        </div>
      </div>
      ${clockEntries.length === 0 ? '<div style="color:var(--text-dim);font-size:12px;">No clock entries yet.</div>' : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Date</th><th>Clock In</th><th>Clock Out</th><th>Duration</th></tr></thead>
          <tbody>
            ${[...clockEntries].reverse().slice(0, 50).map(e => {
              const cin  = new Date(e.clockIn);
              const cout = e.clockOut ? new Date(e.clockOut) : null;
              const dur  = cout ? formatElapsed(e.clockIn, e.clockOut) : '—';
              return `<tr>
                <td class="td-primary">${e.userName}</td>
                <td class="td-mono" style="color:${e.role==='Manager'?'var(--orange)':e.role==='Admin'?'var(--accent)':'var(--text-muted)'};">${e.role}</td>
                <td class="td-mono">${cin.toLocaleDateString()}</td>
                <td class="td-mono">${cin.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
                <td class="td-mono">${cout ? cout.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '<span style="color:var(--green);">Active</span>'}</td>
                <td class="td-mono">${dur}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `;
}

async function exportClockCSV() {
  const rows = [['Name','Role','Date','Clock In','Clock Out','Duration (h)','Duration (min)']];
  [...clockEntries].reverse().forEach(e => {
    const cin  = new Date(e.clockIn);
    const cout = e.clockOut ? new Date(e.clockOut) : null;
    const ms   = cout ? cout - cin : null;
    const hrs  = ms !== null ? (ms / 3600000).toFixed(2) : '';
    const mins = ms !== null ? Math.round(ms / 60000) : '';
    rows.push([
      e.userName,
      e.role,
      cin.toLocaleDateString(),
      cin.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
      cout ? cout.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : 'Active',
      hrs,
      mins,
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const filename = `timelog-${new Date().toISOString().slice(0,10)}.csv`;
  if (window.electronAPI) {
    const saved = await window.electronAPI.exportFile(csv, filename);
    if (saved) notify('Time log exported ✓');
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = filename;
    a.click();
    notify('Time log downloaded ✓');
  }
}

// ── SETTINGS ─────────────────────────────────────────────────────

let storeSettings = {
  name: 'Stone MTN Device Repair',
  tagline: 'Fast • Reliable • Affordable',
  phone: '(404) 555-0182',
  email: 'repairs@stonemtn.com',
  address: '1234 Peachtree Rd NE',
  city: 'Atlanta',
  state: 'GA',
  zip: '30309',
  taxRate: '8.9',
  taxName: 'GA Sales Tax',
  taxOnParts: true,
  taxOnLabor: false,
  defaultWarrantyDays: '30',
  defaultTurnaround: '1-2 Business Days',
  receiptFooter: 'Thank you for choosing Stone MTN! All repairs carry a 30-day warranty.',
  laborRate: '65',
  diagFee: '25',
  laborMultiplier: '2.5',
  depositAmount: '25',
  depositNonRefundable: true,
  depositDeviceTypes: ['Phone','Tablet','Laptop','Other'],
  currency: 'USD',
  timezone: 'America/New_York',
  dateFormat: 'MM/DD/YYYY',
  notifyStatusChange: true,
  notifyReady: true,
  notifyReminder: false,
  smsFrom: '',
  emailFrom: 'repairs@stonemtn.com',
  adminPin: '',
};

function renderSettingsPage() {
  const s = storeSettings;
  document.getElementById('settings-content').innerHTML = `
    <div style="display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:start;">

      <!-- Settings Nav -->
      <div style="display:flex;flex-direction:column;gap:2px;position:sticky;top:80px;">
        ${[
          ['store-info','Store Info'],
          ['tax-cfg','Tax & Pricing'],
          ['repair-defaults','Repair Defaults'],
          ['receipt-cfg','Receipt & Print'],
          ['notifications','Notifications'],
          ['system-cfg','System'],
          ['user-mgmt','Users & Security'],
        ].map(([id,label],i)=>`
          <button onclick="document.getElementById('sec-${id}').scrollIntoView({behavior:'smooth'})" style="background:none;border:none;text-align:left;padding:8px 12px;font-family:\'IBM Plex Mono\',monospace;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);cursor:pointer;border-radius:2px;transition:all 0.15s;border-left:2px solid transparent;" onmouseover="this.style.color='var(--text)';this.style.background='var(--surface2)'" onmouseout="this.style.color='var(--text-muted)';this.style.background='none'">${label}</button>
        `).join('')}
      </div>

      <!-- Settings Panels -->
      <div style="display:flex;flex-direction:column;gap:20px;">

        <!-- Store Info -->
        <div class="card" id="sec-store-info">
          <div class="card-label" style="margin-bottom:16px;">Store Information</div>
          <div class="form-grid">
            <div class="form-group span2">
              <label class="form-label">Store Name</label>
              <input class="form-input" id="set-name" value="${s.name}">
            </div>
            <div class="form-group span2">
              <label class="form-label">Tagline / Slogan</label>
              <input class="form-input" id="set-tagline" value="${s.tagline}" placeholder="Fast • Reliable • Affordable">
            </div>
            <div class="form-group">
              <label class="form-label">Phone</label>
              <input class="form-input" id="set-phone" value="${s.phone}">
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input class="form-input" id="set-email" value="${s.email}">
            </div>
            <div class="form-group span2">
              <label class="form-label">Street Address</label>
              <input class="form-input" id="set-address" value="${s.address}">
            </div>
            <div class="form-group">
              <label class="form-label">City</label>
              <input class="form-input" id="set-city" value="${s.city}">
            </div>
            <div class="form-group" style="display:grid;grid-template-columns:80px 1fr;gap:8px;">
              <div>
                <label class="form-label">State</label>
                <input class="form-input" id="set-state" value="${s.state}" maxlength="2" style="text-transform:uppercase;">
              </div>
              <div>
                <label class="form-label">ZIP</label>
                <input class="form-input" id="set-zip" value="${s.zip}">
              </div>
            </div>
          </div>
        </div>

        <!-- Tax & Pricing -->
        <div class="card" id="sec-tax-cfg">
          <div class="card-label" style="margin-bottom:16px;">Tax & Pricing</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Tax Rate (%)</label>
              <input class="form-input" id="set-taxrate" type="number" step="0.01" value="${s.taxRate}" placeholder="8.9">
            </div>
            <div class="form-group">
              <label class="form-label">Tax Name</label>
              <input class="form-input" id="set-taxname" value="${s.taxName}" placeholder="Sales Tax">
            </div>
            <div class="form-group">
              <label class="form-label">Default Labor Rate ($/hr)</label>
              <input class="form-input" id="set-laborrate" type="number" value="${s.laborRate}">
            </div>
            <div class="form-group">
              <label class="form-label">Diagnostic Fee ($)</label>
              <input class="form-input" id="set-diagfee" type="number" value="${s.diagFee}">
            </div>
            <div class="form-group">
              <label class="form-label">Labor Multiplier (× parts cost)</label>
              <input class="form-input" id="set-labormult" type="number" step="0.1" min="1" value="${s.laborMultiplier}" placeholder="2.5">
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Estimate = Parts + (Parts × multiplier). Default 2.5×</div>
            </div>
            <div class="form-group">
              <label class="form-label">Deposit Amount ($)</label>
              <input class="form-input" id="set-deposit" type="number" step="0.01" min="0" value="${s.depositAmount}" placeholder="25.00">
            </div>
            <div class="form-group span2" style="display:flex;gap:24px;align-items:center;padding:6px 0 10px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="set-depositnonrefund" ${s.depositNonRefundable?'checked':''} style="width:14px;height:14px;accent-color:var(--accent);">
                Deposit is non-refundable if client declines or device is unrepairable
              </label>
            </div>
            <div class="form-group span2">
              <label class="form-label">Charge Deposit On</label>
              <div style="display:flex;flex-wrap:wrap;gap:10px;padding:6px 0;">
                ${['Phone','Tablet','Laptop','Desktop','Game Console','Other'].map(dt => `
                  <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" class="dep-device-type" value="${dt}" ${(s.depositDeviceTypes||[]).includes(dt)?'checked':''} style="width:14px;height:14px;accent-color:var(--accent);">
                    ${dt}
                  </label>
                `).join('')}
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Deposit will only be required for checked device types</div>
            </div>
            <div class="form-group span2" style="display:flex;gap:24px;align-items:center;padding:10px 0;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="set-taxparts" ${s.taxOnParts?'checked':''} style="width:14px;height:14px;accent-color:var(--accent);">
                Apply tax to parts
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="set-taxlabor" ${s.taxOnLabor?'checked':''} style="width:14px;height:14px;accent-color:var(--accent);">
                Apply tax to labor
              </label>
            </div>
          </div>
        </div>

        <!-- Repair Defaults -->
        <div class="card" id="sec-repair-defaults">
          <div class="card-label" style="margin-bottom:16px;">Repair Defaults</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Default Warranty (days)</label>
              <select class="form-select" id="set-warranty">
                ${[7,14,30,60,90,180].map(d=>`<option value="${d}" ${s.defaultWarrantyDays==d?'selected':''}>${d} days</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Default Turnaround</label>
              <input class="form-input" id="set-turnaround" value="${s.defaultTurnaround}" placeholder="1-2 Business Days">
            </div>
          </div>
        </div>

        <!-- Receipt & Print -->
        <div class="card" id="sec-receipt-cfg">
          <div class="card-label" style="margin-bottom:16px;">Receipt & Print</div>
          <div class="form-grid">
            <div class="form-group span2">
              <label class="form-label">Receipt Footer Message</label>
              <textarea class="form-input" id="set-footer" rows="3" style="resize:vertical;">${s.receiptFooter}</textarea>
            </div>
            <div class="form-group">
              <label class="form-label">Currency</label>
              <select class="form-select" id="set-currency">
                <option value="USD" ${s.currency==='USD'?'selected':''}>USD — US Dollar</option>
                <option value="CAD" ${s.currency==='CAD'?'selected':''}>CAD — Canadian Dollar</option>
                <option value="GBP" ${s.currency==='GBP'?'selected':''}>GBP — British Pound</option>
                <option value="EUR" ${s.currency==='EUR'?'selected':''}>EUR — Euro</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Date Format</label>
              <select class="form-select" id="set-datefmt">
                <option value="MM/DD/YYYY" ${s.dateFormat==='MM/DD/YYYY'?'selected':''}>MM/DD/YYYY</option>
                <option value="DD/MM/YYYY" ${s.dateFormat==='DD/MM/YYYY'?'selected':''}>DD/MM/YYYY</option>
                <option value="YYYY-MM-DD" ${s.dateFormat==='YYYY-MM-DD'?'selected':''}>YYYY-MM-DD</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Notifications -->
        <div class="card" id="sec-notifications">
          <div class="card-label" style="margin-bottom:4px;">Notifications</div>
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-dim);margin-bottom:16px;">SMS & email triggers (requires Twilio / SendGrid integration)</div>
          <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;">
            ${[
              ['set-notify-status','notifyStatusChange','Notify customer on every status change'],
              ['set-notify-ready','notifyReady','Notify customer when repair is ready for pickup'],
              ['set-notify-reminder','notifyReminder','Send 24hr reminder if device not picked up'],
            ].map(([id,key,label])=>`
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input type="checkbox" id="${id}" ${s[key]?'checked':''} style="width:14px;height:14px;accent-color:var(--accent);">
                <span style="font-size:13px;">${label}</span>
              </label>
            `).join('')}
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">SMS From Number</label>
              <input class="form-input" id="set-smsfrom" value="${s.smsFrom}" placeholder="+1 (404) 555-0000">
            </div>
            <div class="form-group">
              <label class="form-label">Email From Address</label>
              <input class="form-input" id="set-emailfrom" value="${s.emailFrom}">
            </div>
          </div>
        </div>

        <!-- System -->
        <div class="card" id="sec-system-cfg">
          <div class="card-label" style="margin-bottom:16px;">System</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Timezone</label>
              <select class="form-select" id="set-timezone">
                ${['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','Pacific/Honolulu'].map(tz=>`<option value="${tz}" ${s.timezone===tz?'selected':''}>${tz.replace('America/','').replace('_',' ')}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end;">
              <div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">App Version</div>
                <div style="font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--text);">Stone MTN Portal v1.0.0-beta</div>
              </div>
            </div>
          </div>
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);display:flex;gap:10px;">
            <button class="btn btn-ghost" onclick="exportData()">⬇ Export Backup</button>
            <button class="btn btn-ghost" onclick="importData()">⬆ Import Backup</button>
            <button class="btn btn-ghost" style="border-color:var(--red);color:var(--red);" onmouseover="this.style.background='rgba(255,68,68,0.08)'" onmouseout="this.style.background=''" onclick="resetToDemo()">Reset to Demo Data</button>
          </div>
        </div>

        <!-- Users & Security -->
        <div class="card" id="sec-user-mgmt">
          <div class="card-label" style="margin-bottom:16px;">Users &amp; Security</div>

          <!-- Admin PIN -->
          <div style="margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--border);">
            <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;">Admin PIN</div>
            <div style="display:flex;align-items:flex-end;gap:10px;">
              <div class="form-group" style="margin:0;">
                <label class="form-label">PIN (4–8 digits, leave blank to disable)</label>
                <input class="form-input" id="set-adminpin" type="password" maxlength="8" placeholder="e.g. 1234" value="${s.adminPin||''}" style="width:140px;letter-spacing:4px;">
              </div>
              <button class="btn btn-ghost" onclick="savePIN()">Save PIN</button>
            </div>
          </div>

          <!-- User list -->
          <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">Accounts</div>
          <div id="user-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">
            ${users.map(u => `
              <div style="display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);padding:10px 14px;">
                <div style="flex:1;">
                  <span style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:var(--text);">${u.name}</span>
                  <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:var(--text-muted);margin-left:10px;">@${u.username}</span>
                </div>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;padding:2px 8px;border:1px solid ${u.role==='Admin'?'var(--accent)':u.role==='Manager'?'var(--orange)':'var(--border)'};color:${u.role==='Admin'?'var(--accent)':u.role==='Manager'?'var(--orange)':'var(--text-muted)'};">${u.role}</span>
                <span style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;color:${u.active?'var(--green)':'var(--red)'};">${u.active?'Active':'Inactive'}</span>
                ${u.role !== 'Admin' ? `<button class="btn btn-ghost btn-sm" onclick="openEditUserModal('${u.id}')">Edit</button>` : `<button class="btn btn-ghost btn-sm" onclick="openChangeAdminPasswordModal()">Change PW</button>`}
              </div>
            `).join('')}
          </div>
          <button class="btn btn-accent" onclick="openNewUserModal()">+ Add Account</button>
        </div>

      </div>
    </div>
  `;
}

function saveSettings() {
  const g = id => document.getElementById(id);
  if (!g('set-name')) return;
  storeSettings = {
    name: g('set-name').value,
    tagline: g('set-tagline').value,
    phone: g('set-phone').value,
    email: g('set-email').value,
    address: g('set-address').value,
    city: g('set-city').value,
    state: g('set-state').value,
    zip: g('set-zip').value,
    taxRate: g('set-taxrate').value,
    taxName: g('set-taxname').value,
    taxOnParts: g('set-taxparts').checked,
    taxOnLabor: g('set-taxlabor').checked,
    laborRate: g('set-laborrate').value,
    diagFee: g('set-diagfee').value,
    laborMultiplier: g('set-labormult').value,
    depositAmount: g('set-deposit').value,
    depositNonRefundable: g('set-depositnonrefund').checked,
    depositDeviceTypes: [...document.querySelectorAll('.dep-device-type:checked')].map(el => el.value),
    defaultWarrantyDays: g('set-warranty').value,
    defaultTurnaround: g('set-turnaround').value,
    receiptFooter: g('set-footer').value,
    currency: g('set-currency').value,
    dateFormat: g('set-datefmt').value,
    notifyStatusChange: g('set-notify-status').checked,
    notifyReady: g('set-notify-ready').checked,
    notifyReminder: g('set-notify-reminder').checked,
    smsFrom: g('set-smsfrom').value,
    emailFrom: g('set-emailfrom').value,
    timezone: g('set-timezone').value,
    adminPin: storeSettings.adminPin || '',
  };
  try { localStorage.setItem('smr_settings', JSON.stringify(storeSettings)); } catch(e){}
  notify('Settings saved ✓');
}

function savePIN() {
  const val = (document.getElementById('set-adminpin')?.value || '').trim();
  if (val && !/^\d{4,8}$/.test(val)) { alert('PIN must be 4–8 digits.'); return; }
  storeSettings.adminPin = val;
  saveData();
  notify(val ? 'Admin PIN saved ✓' : 'Admin PIN removed ✓');
}

// ── USER MANAGEMENT ─────────────────────────────────────────────
function openNewUserModal() {
  openModal('Add Account', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="form-input" id="nu-name" placeholder="e.g. Alex M.">
      </div>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input class="form-input" id="nu-username" placeholder="e.g. alexm">
      </div>
      <div class="form-group">
        <label class="form-label">Role</label>
        <select class="form-select" id="nu-role">
          <option value="Tech">Tech</option>
          <option value="Manager">Manager</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input class="form-input" id="nu-password" type="password" placeholder="Password">
      </div>
    </div>
  `);
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
    <button class="btn btn-accent" onclick="saveNewUser()">Create Account</button>
  `;
}

function saveNewUser() {
  const name     = document.getElementById('nu-name').value.trim();
  const username = document.getElementById('nu-username').value.trim();
  const role     = document.getElementById('nu-role').value;
  const password = document.getElementById('nu-password').value;
  if (!name || !username || !password) { alert('All fields required.'); return; }
  if (users.find(u => u.username === username)) { alert('Username already exists.'); return; }
  users.push({ id: 'u'+Date.now(), username, password, name, role, active: true });
  saveData();
  closeModalDirect();
  notify('Account created: ' + name + ' ✓');
  renderSettingsPage();
}

function openEditUserModal(uid) {
  const u = users.find(x => x.id === uid);
  if (!u) return;
  openModal('Edit Account — ' + u.name, `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="form-input" id="eu-name" value="${u.name}">
      </div>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input class="form-input" id="eu-username" value="${u.username}">
      </div>
      <div class="form-group">
        <label class="form-label">Role</label>
        <select class="form-select" id="eu-role">
          <option value="Tech" ${u.role==='Tech'?'selected':''}>Tech</option>
          <option value="Manager" ${u.role==='Manager'?'selected':''}>Manager</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="eu-active">
          <option value="1" ${u.active?'selected':''}>Active</option>
          <option value="0" ${!u.active?'selected':''}>Inactive</option>
        </select>
      </div>
      <div class="form-group span2">
        <label class="form-label">New Password (leave blank to keep current)</label>
        <input class="form-input" id="eu-password" type="password" placeholder="New password…">
      </div>
    </div>
  `);
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
    <button class="btn btn-accent" onclick="saveEditUser('${uid}')">Save</button>
  `;
}

function saveEditUser(uid) {
  const u = users.find(x => x.id === uid);
  if (!u) return;
  const name     = document.getElementById('eu-name').value.trim();
  const username = document.getElementById('eu-username').value.trim();
  const role     = document.getElementById('eu-role').value;
  const password = document.getElementById('eu-password').value;
  const active   = document.getElementById('eu-active').value === '1';
  if (!name || !username) { alert('Name and username required.'); return; }
  const dup = users.find(x => x.username === username && x.id !== uid);
  if (dup) { alert('Username already in use.'); return; }
  u.name     = name;
  u.username = username;
  u.role     = role;
  u.active   = active;
  if (password) u.password = password;
  saveData();
  closeModalDirect();
  notify('Account updated ✓');
  renderSettingsPage();
}

function openChangeAdminPasswordModal() {
  openModal('Change Admin Password', `
    <div class="form-grid">
      <div class="form-group span2">
        <label class="form-label">Current Password</label>
        <input class="form-input" id="cap-current" type="password">
      </div>
      <div class="form-group span2">
        <label class="form-label">New Password</label>
        <input class="form-input" id="cap-new" type="password">
      </div>
      <div class="form-group span2">
        <label class="form-label">Confirm New Password</label>
        <input class="form-input" id="cap-confirm" type="password">
      </div>
    </div>
  `);
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeModalDirect()">Cancel</button>
    <button class="btn btn-accent" onclick="saveAdminPassword()">Change Password</button>
  `;
}

async function saveAdminPassword() {
  const current = document.getElementById('cap-current').value;
  const next    = document.getElementById('cap-new').value;
  const confirm = document.getElementById('cap-confirm').value;
  if (!next)             { alert('New password cannot be empty.'); return; }
  if (next !== confirm)  { alert('Passwords do not match.'); return; }
  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Could not change password.');
      return;
    }
  } catch (e) { alert('Connection error — please try again.'); return; }
  closeModalDirect();
  notify('Admin password changed ✓');
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('smr_settings') || '{}');
    if (saved.name) storeSettings = { ...storeSettings, ...saved };
  } catch(e){}
}

// ── INIT ─────────────────────────────────────────────────────────
function updateLowStockBadge() {
  const lowOrOut = inventory.filter(p => p.qty <= p.minQty).length;
  const btn = document.getElementById('nav-parts-btn');
  if (!btn) return;
  const label = btn.querySelector('.nav-label');
  if (!label) return;
  if (lowOrOut > 0) {
    label.innerHTML = `Parts <span style="background:var(--red);color:#fff;font-family:\'IBM Plex Mono\',monospace;font-size:9px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:4px;vertical-align:middle;">${lowOrOut}</span>`;
  } else {
    label.textContent = 'Parts';
  }
}

// ── SQLITE / LOCALSTORAGE PERSISTENCE ────────────────────────────
// Runs via Electron (SQLite) or plain browser (localStorage fallback).

function saveData() {
  const data = {
    dataVersion: DATA_VERSION,
    inventory, productLines, skuSerialCounter,
    purchaseOrders, customers, workOrders,
    cashEntries, drawerFloat, drawerOpen, drawerSessions,
    filterSlots, storeSettings, users, clockEntries,
  };
  fetch('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(e => console.warn('Save failed:', e));
}

const DATA_VERSION = 3; // bump this to wipe old saved data on next load

async function loadData() {
  try {
    let d;
    const res = await fetch('/api/data');
    if (!res.ok) return;
    d = await res.json();
    if (!d) return;
    // If saved data is from an older version, discard it (keeps users + settings)
    if ((d.dataVersion || 1) < DATA_VERSION) {
      if (Array.isArray(d.users) && d.users.length) users = d.users;
      if (d.storeSettings && typeof d.storeSettings === 'object')
        storeSettings = { ...storeSettings, ...d.storeSettings };
      saveData(); // persist fresh empty state with new version
      return;
    }
    if (Array.isArray(d.inventory))             inventory        = d.inventory;
    if (Array.isArray(d.productLines))          productLines     = d.productLines;
    if (typeof d.skuSerialCounter === 'number') skuSerialCounter = d.skuSerialCounter;
    if (Array.isArray(d.purchaseOrders))        purchaseOrders   = d.purchaseOrders;
    if (Array.isArray(d.customers))             customers        = d.customers;
    if (Array.isArray(d.workOrders))            workOrders       = d.workOrders;
    if (Array.isArray(d.cashEntries))           cashEntries      = d.cashEntries;
    if (typeof d.drawerFloat === 'number')      drawerFloat      = d.drawerFloat;
    if (typeof d.drawerOpen  === 'boolean')     drawerOpen       = d.drawerOpen;
    if (Array.isArray(d.drawerSessions))        drawerSessions   = d.drawerSessions;
    if (Array.isArray(d.filterSlots))           filterSlots      = d.filterSlots;
    if (d.storeSettings && typeof d.storeSettings === 'object')
      storeSettings = { ...storeSettings, ...d.storeSettings };
    if (Array.isArray(d.users) && d.users.length) users = d.users;
    if (Array.isArray(d.clockEntries))            clockEntries = d.clockEntries;
  } catch(e) { console.warn('Load failed:', e); }
}

async function exportData() {
  if (!isAdmin()) { notify('Admin access required.'); return; }
  try {
    const json = JSON.stringify({
      inventory, productLines, skuSerialCounter,
      purchaseOrders, customers, workOrders,
      cashEntries, drawerFloat, drawerOpen, drawerSessions,
      filterSlots, storeSettings,
      exportedAt: new Date().toISOString(),
      version: '1.0',
    }, null, 2);

    if (window.electronAPI) {
      const saved = await window.electronAPI.exportFile(json);
      if (saved) notify('Backup saved ✓');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'stonemtn-backup-' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      notify('Backup downloaded ✓');
    }
  } catch(e) { alert('Export failed: ' + e.message); }
}

async function importData() {
  if (!isAdmin()) { notify('Admin access required.'); return; }
  try {
    let json;
    if (window.electronAPI) {
      json = await window.electronAPI.importFile();
      if (!json) return;
    } else {
      json = await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = e => {
          const f = e.target.files[0];
          if (!f) { resolve(null); return; }
          const r = new FileReader();
          r.onload = ev => resolve(ev.target.result);
          r.readAsText(f);
        };
        input.click();
      });
      if (!json) return;
    }

    const d = JSON.parse(json);
    if (!confirm('Replace ALL current data with this backup? This cannot be undone.')) return;
    if (Array.isArray(d.inventory))             inventory        = d.inventory;
    if (Array.isArray(d.productLines))          productLines     = d.productLines;
    if (typeof d.skuSerialCounter === 'number') skuSerialCounter = d.skuSerialCounter;
    if (Array.isArray(d.purchaseOrders))        purchaseOrders   = d.purchaseOrders;
    if (Array.isArray(d.customers))             customers        = d.customers;
    if (Array.isArray(d.workOrders))            workOrders       = d.workOrders;
    if (Array.isArray(d.cashEntries))           cashEntries      = d.cashEntries;
    if (typeof d.drawerFloat === 'number')      drawerFloat      = d.drawerFloat;
    if (typeof d.drawerOpen  === 'boolean')     drawerOpen       = d.drawerOpen;
    if (Array.isArray(d.drawerSessions))        drawerSessions   = d.drawerSessions;
    if (Array.isArray(d.filterSlots))           filterSlots      = d.filterSlots;
    if (d.storeSettings && typeof d.storeSettings === 'object')
      storeSettings = { ...storeSettings, ...d.storeSettings };
    saveData();
    renderStats();
    renderWOTable();
    updateLowStockBadge();
    notify('Backup imported successfully ✓');
  } catch(err) { alert('Import failed: ' + err.message); }
}

async function resetToDemo() {
  if (!isAdmin()) { notify('Admin access required.'); return; }
  if (!confirm('This will ERASE all your data. Are you sure?')) return;
  await fetch('/api/data', { method: 'DELETE' }).catch(() => {});
  notify('Data cleared — reloading…');
  setTimeout(() => location.reload(), 1200);
}

// ── INIT ──────────────────────────────────────────────────────────
loadMutedAlerts();
loadAppearance();
updateTopbarModeIcon();
loadSidebarState();
(async () => {
  // Restore existing session if the user refreshed the page
  try {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const { user } = await meRes.json();
      await _activateSession(user);
      return;
    }
  } catch (e) { /* no session — show login */ }
  // No active session: stay on login screen
})();