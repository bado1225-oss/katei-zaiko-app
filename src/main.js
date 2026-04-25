// 家庭在庫管理アプリ - localStorage版
const STORAGE_KEY = 'katei-zaiko-items-v1';
const LOG_KEY = 'katei-zaiko-logs-v1';
const STATE_KEY = 'katei-zaiko-state-v1';

const LOCATIONS = {
  'fridge':         { label: '冷蔵庫',         icon: '🥬', group: 'house' },
  'pantry':         { label: 'パントリー',     icon: '🥫', group: 'house' },
  'freezer':        { label: '冷凍ストッカー', icon: '🧊', group: 'house' },
  'storage':        { label: '倉庫',           icon: '📦', group: 'warehouse' },
  'storage-fridge': { label: '倉庫冷蔵庫',     icon: '❄️', group: 'warehouse' },
};

const GROUPS = {
  'house':     { label: '家',   icon: '🏠', locs: ['fridge','pantry','freezer'] },
  'warehouse': { label: '倉庫', icon: '📦', locs: ['storage','storage-fridge'] },
};

// カテゴリチップを表示する loc とカテゴリ一覧
const CATEGORY_CHIP_LOCS = new Set(['pantry', 'storage']);
const CATEGORY_CHIPS = [
  { key: 'all',   label: 'すべて' },
  { key: '食材', label: '食材' },
  { key: '飲料', label: '飲料' },
  { key: '消耗品', label: '消耗品' },
];

const STATE = {
  items: [],
  logs: [],
  currentGroup: 'house',
  currentLoc: 'fridge',
  currentTab: 'loc',          // 'loc' | 'status' | 'log' | 'settings'
  currentStatus: null,        // 'refill' | 'order' | 'normal' | null
  currentCategory: 'all',     // カテゴリチップ用 (pantry/storage のみ)
  editingId: null,
  qtyEditingId: null,
};

/* ---------- storage ---------- */
function loadAll(){
  try { STATE.items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { STATE.items = []; }
  try { STATE.logs  = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { STATE.logs = []; }
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    if (s.currentLoc && LOCATIONS[s.currentLoc]) STATE.currentLoc = s.currentLoc;
    STATE.currentGroup = LOCATIONS[STATE.currentLoc].group;
  } catch {}
}
function saveItems(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.items)); }
function saveLogs(){
  if (STATE.logs.length > 200) STATE.logs = STATE.logs.slice(0, 200);
  localStorage.setItem(LOG_KEY, JSON.stringify(STATE.logs));
}
function saveState(){
  localStorage.setItem(STATE_KEY, JSON.stringify({ currentLoc: STATE.currentLoc }));
}

/* ---------- helpers ---------- */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function now(){ return new Date().toISOString(); }
function fmtDate(iso){
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function fmtToday(){
  const d = new Date();
  const wd = ['日','月','火','水','木','金','土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 (${wd})`;
}
function getStatus(item){
  const stock = Number(item.stock) || 0;
  const min = Number(item.minStock) || 0;
  if (stock <= 0) return 'order';
  if (stock <= min) return 'refill';
  return 'normal';
}
function statusLabel(s){ return s === 'order' ? '発注必要' : s === 'refill' ? '補充必要' : '正常'; }
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>t.classList.remove('show'), 2000);
}
function addLog(action, itemName, detail){
  STATE.logs.unshift({ id: uid(), at: now(), action, itemName, detail: detail || '' });
  saveLogs();
}

/* ---------- KPI ---------- */
function renderKpis(){
  const grid = document.getElementById('dashboard-kpis');
  let refill = 0, order = 0, normal = 0;
  for (const it of STATE.items){
    const s = getStatus(it);
    if (s === 'refill') refill++;
    else if (s === 'order') order++;
    else normal++;
  }
  grid.innerHTML = `
    <div class="kpi-card warning" onclick="showStatus('refill')">
      <div class="kpi-label">補充必要</div>
      <div class="kpi-value">${refill}</div>
      <div class="kpi-sub">タップで一覧</div>
    </div>
    <div class="kpi-card danger" onclick="showStatus('order')">
      <div class="kpi-label">発注必要</div>
      <div class="kpi-value">${order}</div>
      <div class="kpi-sub">タップで一覧</div>
    </div>
    <div class="kpi-card good">
      <div class="kpi-label">正常</div>
      <div class="kpi-value">${normal}</div>
      <div class="kpi-sub">${STATE.items.length}件中</div>
    </div>
  `;
  document.getElementById('hero-stamp').textContent = `${fmtToday().split(' ')[0]}`;
  document.getElementById('header-date').textContent = fmtToday();
}

/* ---------- Tabs / Views ---------- */
function renderSubTabs(){
  const wrap = document.getElementById('sub-segment-tabs');
  if (!wrap) return;
  if (STATE.currentTab !== 'loc'){ wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const locs = GROUPS[STATE.currentGroup].locs;
  wrap.innerHTML = locs.map(loc => {
    const m = LOCATIONS[loc];
    const active = loc === STATE.currentLoc ? 'active' : '';
    return `<button class="sub-segment-btn ${active}" data-loc="${loc}" onclick="showLoc('${loc}')"><span class="seg-icon">${m.icon}</span>${escapeHtml(m.label)}</button>`;
  }).join('');
}
function showTab(tab){
  STATE.currentTab = tab;
  document.getElementById('view-loc').style.display = (tab === 'loc') ? '' : 'none';
  document.getElementById('view-status').style.display = (tab === 'status') ? '' : 'none';
  document.getElementById('view-log').style.display = (tab === 'log') ? '' : 'none';
  document.getElementById('view-settings').style.display = (tab === 'settings') ? '' : 'none';
  // main group tabs are only "active" when in loc view
  document.querySelectorAll('.main-segment-btn').forEach(btn => {
    btn.classList.toggle('active', tab === 'loc' && btn.dataset.group === STATE.currentGroup);
  });
  renderSubTabs();
  if (tab === 'log') renderLog();
  window.scrollTo({ top:0, behavior:'smooth' });
}
function showGroup(group){
  if (!GROUPS[group]) return;
  if (STATE.currentTab === 'loc' && STATE.currentGroup === group){
    window.scrollTo({ top:0, behavior:'smooth' });
    return;
  }
  STATE.currentGroup = group;
  // 既存の currentLoc がこのグループに無ければ先頭へ
  if (LOCATIONS[STATE.currentLoc].group !== group){
    STATE.currentLoc = GROUPS[group].locs[0];
  }
  STATE.currentCategory = 'all';
  saveState();
  showTab('loc');
  renderLoc();
}
function showLoc(loc){
  if (!LOCATIONS[loc]) return;
  if (STATE.currentTab === 'loc' && STATE.currentLoc === loc){
    window.scrollTo({ top:0, behavior:'smooth' });
    return;
  }
  STATE.currentLoc = loc;
  STATE.currentGroup = LOCATIONS[loc].group;
  STATE.currentCategory = 'all';
  saveState();
  showTab('loc');
  renderLoc();
}
function showStatus(status){
  STATE.currentStatus = status;
  document.getElementById('status-section-title').textContent = statusLabel(status);
  showTab('status');
  renderStatus();
}
function toggleFilterPanel(){
  const btn = document.getElementById('filter-toggle-loc');
  const panel = document.getElementById('filter-panel-loc');
  btn.classList.toggle('open');
  panel.classList.toggle('open');
}

/* ---------- Render: location view ---------- */
function renderCatChips(){
  const row = document.getElementById('cat-chip-row');
  if (!row) return;
  if (!CATEGORY_CHIP_LOCS.has(STATE.currentLoc)){
    row.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  row.style.display = '';
  row.innerHTML = CATEGORY_CHIPS.map(c => {
    const active = c.key === STATE.currentCategory ? 'active' : '';
    return `<button class="cat-chip ${active}" data-cat="${escapeAttr(c.key)}" onclick="setCategoryChip('${c.key}')">${escapeHtml(c.label)}</button>`;
  }).join('');
}
function setCategoryChip(cat){
  STATE.currentCategory = cat;
  renderCatChips();
  renderLoc();
}

function renderLoc(){
  const loc = STATE.currentLoc;
  const meta = LOCATIONS[loc];
  document.getElementById('loc-section-title').textContent = `${meta.icon} ${meta.label}`;
  renderCatChips();
  // populate name select with items in this loc
  const nameSelect = document.getElementById('search-name');
  const prevName = nameSelect.value;
  const namesInLoc = [...new Set(STATE.items.filter(i=>i.location===loc).map(i=>i.name))].sort();
  nameSelect.innerHTML = '<option value="">商品名: すべて</option>' +
    namesInLoc.map(n=>`<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  if (namesInLoc.includes(prevName)) nameSelect.value = prevName;

  const filterStatus = document.getElementById('filter-status').value;
  const filterName = nameSelect.value;
  let items = STATE.items.filter(i => i.location === loc);
  if (filterName) items = items.filter(i => i.name === filterName);
  if (filterStatus !== 'all') items = items.filter(i => getStatus(i) === filterStatus);
  if (CATEGORY_CHIP_LOCS.has(loc) && STATE.currentCategory !== 'all'){
    items = items.filter(i => i.category === STATE.currentCategory);
  }
  // sort: order > refill > normal, then name
  const order = { order:0, refill:1, normal:2 };
  items.sort((a,b)=>{
    const sa = order[getStatus(a)], sb = order[getStatus(b)];
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name, 'ja');
  });

  const list = document.getElementById('loc-items');
  document.getElementById('loc-count-pill').textContent = `${items.length}件`;
  if (items.length === 0){
    list.innerHTML = `<div class="empty-msg">${meta.label} に登録された品目はありません</div>`;
  } else {
    list.innerHTML = items.map(renderItemCard).join('');
  }
  const lastUpdated = STATE.items.reduce((m,i)=> i.updatedAt && (!m || i.updatedAt > m) ? i.updatedAt : m, null);
  document.getElementById('last-updated-loc').textContent = lastUpdated ? `最終更新: ${fmtDate(lastUpdated)}` : '';
}

function renderStatus(){
  const status = STATE.currentStatus;
  const items = STATE.items.filter(i => getStatus(i) === status)
    .sort((a,b) => a.name.localeCompare(b.name, 'ja'));
  document.getElementById('status-count-pill').textContent = `${items.length}件`;
  const list = document.getElementById('status-items');
  if (items.length === 0){
    list.innerHTML = `<div class="empty-msg">${statusLabel(status)} の品目はありません</div>`;
  } else {
    list.innerHTML = items.map(renderItemCard).join('');
  }
}

function renderItemCard(item){
  const s = getStatus(item);
  const loc = LOCATIONS[item.location] || { label: item.location, icon: '📦' };
  const noteHtml = item.note ? `<div class="item-note">📝 ${escapeHtml(item.note)}</div>` : '';
  const linkBtn = item.url ? `<a class="item-link-btn" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">🛒 ${escapeHtml(item.supplier || '購入先')}</a>` : '';
  const thr = (item.minStock != null && item.minStock !== '') ? `補充ライン: ${item.minStock}` : '';
  return `
    <div class="item-card" data-id="${item.id}">
      <div class="item-row1">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">
          <span class="item-tag ${s}">${statusLabel(s)}</span>
          <span class="item-tag">${loc.icon} ${escapeHtml(loc.label)}</span>
        </div>
      </div>
      <div class="item-meta">
        ${item.category ? `<span class="item-tag cat">${escapeHtml(item.category)}</span>` : ''}
      </div>
      <div class="item-row2">
        <button class="qty-step" onclick="stepQty('${item.id}',-1)">−</button>
        <div class="qty-display" onclick="openQtyModal('${item.id}')">
          <span class="qty-num">${item.stock ?? 0}</span>
          <span class="qty-unit">${escapeHtml(item.unit || '')}</span>
          <span class="qty-thr">${thr}</span>
        </div>
        <button class="qty-step" onclick="stepQty('${item.id}',1)">＋</button>
      </div>
      ${noteHtml}
      <div class="item-actions">
        ${linkBtn}
        <button class="item-edit-btn" onclick="openModal({id:'${item.id}'})">編集</button>
      </div>
    </div>
  `;
}

/* ---------- Log ---------- */
function renderLog(){
  const list = document.getElementById('log-items');
  const logs = STATE.logs.slice(0, 100);
  if (logs.length === 0){
    list.innerHTML = `<div class="empty-msg">履歴はまだありません</div>`;
    return;
  }
  list.innerHTML = logs.map(l=>`
    <div class="log-row">
      <div class="log-time">${fmtDate(l.at)}</div>
      <div class="log-text"><span class="log-action">${escapeHtml(l.action)}</span> ${escapeHtml(l.itemName)} ${l.detail ? `<span style="color:#80887d">${escapeHtml(l.detail)}</span>` : ''}</div>
    </div>
  `).join('');
}

/* ---------- Stock change ---------- */
function stepQty(id, delta){
  const item = STATE.items.find(i=>i.id===id);
  if (!item) return;
  const before = Number(item.stock) || 0;
  const after = Math.max(0, before + delta);
  if (before === after) return;
  item.stock = after;
  item.updatedAt = now();
  saveItems();
  addLog(delta > 0 ? '在庫追加' : '在庫消費', item.name, `${before} → ${after} ${item.unit || ''}`);
  renderKpis();
  if (STATE.currentTab === 'loc') renderLoc();
  else if (STATE.currentTab === 'status') renderStatus();
}

function openQtyModal(id){
  const item = STATE.items.find(i=>i.id===id);
  if (!item) return;
  STATE.qtyEditingId = id;
  document.getElementById('qty-modal-title').textContent = `${item.name} の在庫数を変更`;
  document.getElementById('qty-modal-input').value = item.stock ?? 0;
  document.getElementById('qty-modal-unit').textContent = item.unit || '';
  document.getElementById('qty-modal-meta').textContent = (item.minStock != null && item.minStock !== '') ? `補充ライン: ${item.minStock} ${item.unit || ''}` : '';
  document.getElementById('qty-modal-overlay').classList.add('show');
}
function closeQtyModal(){
  document.getElementById('qty-modal-overlay').classList.remove('show');
  STATE.qtyEditingId = null;
}
function closeQtyModalOutside(e){
  if (e.target.id === 'qty-modal-overlay') closeQtyModal();
}
function stepQtyModal(delta){
  const inp = document.getElementById('qty-modal-input');
  const v = Math.max(0, (Number(inp.value)||0) + delta);
  inp.value = v;
}
function saveQtyModal(){
  const id = STATE.qtyEditingId;
  const item = STATE.items.find(i=>i.id===id);
  if (!item) return closeQtyModal();
  const v = Math.max(0, Number(document.getElementById('qty-modal-input').value) || 0);
  const before = Number(item.stock) || 0;
  if (before === v){ closeQtyModal(); return; }
  item.stock = v;
  item.updatedAt = now();
  saveItems();
  addLog('在庫変更', item.name, `${before} → ${v} ${item.unit || ''}`);
  closeQtyModal();
  renderKpis();
  if (STATE.currentTab === 'loc') renderLoc();
  else if (STATE.currentTab === 'status') renderStatus();
  showToast('在庫数を更新しました');
}

/* ---------- Item Edit Modal ---------- */
function openModal({ id } = {}){
  STATE.editingId = id || null;
  const isEdit = !!id;
  document.getElementById('modal-title').textContent = isEdit ? '品目を編集' : '新規品目を追加';
  document.getElementById('modal-submit-btn').textContent = isEdit ? '保存する' : '追加する';
  document.getElementById('delete-section').style.display = isEdit ? '' : 'none';
  document.getElementById('f-stock-row').style.display = isEdit ? 'none' : '';

  const item = isEdit ? STATE.items.find(i=>i.id===id) : null;
  document.getElementById('f-name').value = item?.name || '';
  document.getElementById('f-location').value = item?.location || STATE.currentLoc;
  document.getElementById('f-category').value = item?.category || '食材';
  document.getElementById('f-unit').value = item?.unit || '個';
  document.getElementById('f-min').value = item?.minStock ?? '';
  document.getElementById('f-target').value = item?.target ?? '';
  document.getElementById('f-supplier').value = item?.supplier || '';
  document.getElementById('f-url').value = item?.url || '';
  document.getElementById('f-note').value = item?.note || '';
  document.getElementById('f-stock').value = '';
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal(){
  document.getElementById('modal-overlay').classList.remove('show');
  STATE.editingId = null;
}
function closeModalOutside(e){
  if (e.target.id === 'modal-overlay') closeModal();
}
function submitModal(){
  const name = document.getElementById('f-name').value.trim();
  const location = document.getElementById('f-location').value;
  const category = document.getElementById('f-category').value;
  const unit = document.getElementById('f-unit').value;
  const minStock = document.getElementById('f-min').value;
  const target = document.getElementById('f-target').value;
  const supplier = document.getElementById('f-supplier').value.trim();
  const url = document.getElementById('f-url').value.trim();
  const note = document.getElementById('f-note').value.trim();
  if (!name){ showToast('商品名を入力してください'); return; }
  if (!unit){ showToast('単位を選択してください'); return; }

  if (STATE.editingId){
    const item = STATE.items.find(i=>i.id===STATE.editingId);
    if (!item) return;
    Object.assign(item, {
      name, location, category, unit,
      minStock: minStock === '' ? 0 : Number(minStock),
      target: target === '' ? null : Number(target),
      supplier, url, note,
      updatedAt: now(),
    });
    saveItems();
    addLog('品目編集', name);
    showToast('保存しました');
  } else {
    const initial = document.getElementById('f-stock').value;
    const newItem = {
      id: uid(),
      name, location, category, unit,
      minStock: minStock === '' ? 0 : Number(minStock),
      target: target === '' ? null : Number(target),
      supplier, url, note,
      stock: initial === '' ? 0 : Number(initial),
      createdAt: now(),
      updatedAt: now(),
    };
    STATE.items.push(newItem);
    saveItems();
    addLog('品目追加', name, `初期在庫 ${newItem.stock} ${unit}`);
    showToast('追加しました');
    // jump to that location
    STATE.currentLoc = location;
    saveState();
  }
  closeModal();
  renderKpis();
  showTab('loc');
  renderLoc();
}
function deleteItem(){
  const id = STATE.editingId;
  if (!id) return;
  const item = STATE.items.find(i=>i.id===id);
  if (!item) return;
  if (!confirm(`「${item.name}」を削除しますか？`)) return;
  STATE.items = STATE.items.filter(i=>i.id!==id);
  saveItems();
  addLog('品目削除', item.name);
  closeModal();
  renderKpis();
  if (STATE.currentTab === 'loc') renderLoc();
  else if (STATE.currentTab === 'status') renderStatus();
  showToast('削除しました');
}

/* ---------- Settings ---------- */
function exportJson(){
  const data = {
    exportedAt: now(),
    items: STATE.items,
    logs: STATE.logs,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `katei-zaiko-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('エクスポートしました');
}
function importJson(e){
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.items)) throw new Error('形式エラー');
      if (!confirm(`${data.items.length}件の品目を読み込みます。現在のデータは上書きされます。よろしいですか？`)) return;
      STATE.items = data.items;
      STATE.logs = Array.isArray(data.logs) ? data.logs : [];
      saveItems(); saveLogs();
      addLog('データ復元', '', `${data.items.length}件`);
      renderKpis();
      renderLoc();
      showToast('インポートしました');
    } catch (err){
      showToast('読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}
function clearAll(){
  if (!confirm('すべての在庫データと履歴を削除します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に削除しますか？')) return;
  STATE.items = []; STATE.logs = [];
  saveItems(); saveLogs();
  renderKpis(); renderLoc();
  showToast('すべて削除しました');
}

/* ---------- escape ---------- */
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

/* ---------- init ---------- */
function init(){
  loadAll();
  renderKpis();
  showTab('loc');
  renderLoc();
  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
