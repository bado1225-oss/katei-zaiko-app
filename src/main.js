// おうち在庫 - localStorage + Firebase 同期版
const STORAGE_KEY = 'katei-zaiko-items-v1';
const LOG_KEY = 'katei-zaiko-logs-v1';
const STATE_KEY = 'katei-zaiko-state-v1';

const LOCATIONS = {
  'fridge':         { label: '冷蔵庫',         icon: '🥬', group: 'house' },
  'pantry':         { label: 'パントリー',     icon: '🥫', group: 'house' },
  'freezer':        { label: '冷凍ストッカー', icon: '🧊', group: 'house' },
  'vanity':         { label: '洗面所',         icon: '🪥', group: 'house' },
  'bath':           { label: 'お風呂',         icon: '🛁', group: 'house' },
  'storage':        { label: '倉庫',           icon: '📦', group: 'warehouse' },
  'storage-fridge': { label: '倉庫冷蔵庫',     icon: '❄️', group: 'warehouse' },
};

const GROUPS = {
  'house':     { label: '家',   icon: '🏠', locs: ['fridge','pantry','freezer','vanity','bath'] },
  'warehouse': { label: '倉庫', icon: '📦', locs: ['storage','storage-fridge'] },
};

// カテゴリチップを表示する loc とカテゴリ一覧
const CATEGORY_CHIP_LOCS = new Set(['pantry', 'storage']);
const CATEGORY_CHIPS = [
  { key: 'all',   label: 'すべて' },
  { key: '食材', label: '食材' },
  { key: '飲料', label: '飲料' },
  { key: '日用品', label: '日用品' },
];

// 仕入れ先プリセット (固定) + ユーザー追加分は localStorage に保存
const SUPPLIER_PRESETS = ['Amazon', 'コスモス', 'タイヨー', 'パシオ', '鮮度市場'];
const SUPPLIERS_KEY = 'katei-zaiko-suppliers-v1';
function loadCustomSuppliers(){
  try { return JSON.parse(localStorage.getItem(SUPPLIERS_KEY) || '[]'); } catch { return []; }
}
function saveCustomSuppliers(list){ localStorage.setItem(SUPPLIERS_KEY, JSON.stringify(list)); }
function getAllSuppliers(){
  const custom = loadCustomSuppliers();
  // プリセット順 → カスタム(プリセットに無いもののみ)
  return [...SUPPLIER_PRESETS, ...custom.filter(s => !SUPPLIER_PRESETS.includes(s))];
}
function isPresetSupplier(name){ return SUPPLIER_PRESETS.includes(name); }

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
  cloudUser: null,            // Firebase auth user (null=未ログイン)
  lastSyncedAt: null,         // 最終 onSnapshot 時刻 (ISO)
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
  // カテゴリ「消耗品」→「日用品」リネーム (旧版から移行)
  // supplier(単体str) → suppliers(配列) に移行
  let migrated = false;
  for (const i of STATE.items){
    if (i.category === '消耗品'){ i.category = '日用品'; migrated = true; }
    if (!Array.isArray(i.suppliers)){
      const s = (i.supplier || '').trim();
      i.suppliers = s ? [s] : [];
      migrated = true;
    }
  }
  if (migrated) saveItems();
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
  if (stock > min) return 'normal';
  // stock <= min:補充ライン到達
  const meta = LOCATIONS[item.location];
  if (!meta) return 'order';
  // 倉庫の在庫が最低を下回ったら → 発注
  if (meta.group === 'warehouse') return 'order';
  // 家の在庫が最低を下回った: 同名の倉庫アイテムを探す
  const twin = STATE.items.find(i =>
    i.id !== item.id &&
    i.name === item.name &&
    LOCATIONS[i.location] && LOCATIONS[i.location].group === 'warehouse'
  );
  // 倉庫に同名品があり、かつ在庫が残っている → 倉庫から補充
  if (twin && (Number(twin.stock) || 0) > 0) return 'refill';
  // 倉庫に無い or 倉庫も0 → 発注
  return 'order';
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
  const log = { id: uid(), at: now(), action, itemName, detail: detail || '' };
  STATE.logs.unshift(log);
  saveLogs();
  if (STATE.cloudUser && window.kateiSync) window.kateiSync.addLog(log).catch(err => showToast('履歴の同期に失敗: ' + err.message));
}
function syncItem(item){
  if (STATE.cloudUser && window.kateiSync) window.kateiSync.upsertItem(item).catch(err => showToast('同期失敗: ' + err.message));
}
function syncDeleteItem(id){
  if (STATE.cloudUser && window.kateiSync) window.kateiSync.deleteItem(id).catch(err => showToast('削除同期失敗: ' + err.message));
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
    const useGroups = CATEGORY_CHIP_LOCS.has(loc) && STATE.currentCategory === 'all';
    list.innerHTML = useGroups ? renderItemsGroupedByCategory(items) : items.map(renderItemCard).join('');
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
    return;
  }
  if (status === 'order'){
    // 発注必要を URL有無で2セクション、各セクション内で仕入れ先別にサブグループ化
    const hasUrl = it => !!(it.url && String(it.url).trim());
    const orderList = items.filter(hasUrl);
    const shopList  = items.filter(it => !hasUrl(it));
    let html = '';
    if (orderList.length){
      html += `<div class="cat-group-header"><span class="cat-group-title">🌐 発注リスト (URL登録あり)</span><span class="cat-group-count">${orderList.length}件</span></div>`;
      html += renderItemsBySupplier(orderList);
    }
    if (shopList.length){
      html += `<div class="cat-group-header"><span class="cat-group-title">🛒 買い物リスト (店頭購入)</span><span class="cat-group-count">${shopList.length}件</span></div>`;
      html += renderItemsBySupplier(shopList);
    }
    list.innerHTML = html;
  } else {
    list.innerHTML = items.map(renderItemCard).join('');
  }
}

function getItemSuppliers(it){
  if (Array.isArray(it.suppliers) && it.suppliers.length) return it.suppliers;
  if (typeof it.supplier === 'string' && it.supplier.trim()) return [it.supplier.trim()];
  return [];
}
function renderItemsBySupplier(items){
  // 1アイテムが複数 supplier を持つ場合、各 supplier のグループに重複表示
  const grouped = {};
  for (const it of items){
    const sups = getItemSuppliers(it);
    if (sups.length === 0){
      (grouped['(仕入れ先未設定)'] = grouped['(仕入れ先未設定)'] || []).push(it);
    } else {
      for (const sup of sups){
        (grouped[sup] = grouped[sup] || []).push(it);
      }
    }
  }
  // プリセット順 → カスタム → 未設定 の順で並べる
  const order = (name) => {
    if (name === '(仕入れ先未設定)') return 999;
    const idx = SUPPLIER_PRESETS.indexOf(name);
    if (idx >= 0) return idx;
    return 100;
  };
  const suppliers = Object.keys(grouped).sort((a, b) => {
    const oa = order(a), ob = order(b);
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b, 'ja');
  });
  return suppliers.map(sup => {
    const list = grouped[sup];
    return `
      <div class="supplier-group-header">
        <span class="supplier-name">📍 ${escapeHtml(sup)}</span>
        <span class="supplier-count">${list.length}件</span>
      </div>
      ${list.map(renderItemCard).join('')}
    `;
  }).join('');
}

function renderItemsGroupedByCategory(items){
  // 既に items はステータス順にソート済み。カテゴリ毎にバケットへ。
  const order = ['食材', '飲料', '日用品'];
  const grouped = {};
  for (const it of items){
    const cat = it.category || 'その他';
    (grouped[cat] = grouped[cat] || []).push(it);
  }
  const cats = [
    ...order.filter(c => grouped[c]),
    ...Object.keys(grouped).filter(c => !order.includes(c)).sort(),
  ];
  return cats.map(cat => `
    <div class="cat-group-header">
      <span class="cat-group-title">${escapeHtml(cat)}</span>
      <span class="cat-group-count">${grouped[cat].length}件</span>
    </div>
    ${grouped[cat].map(renderItemCard).join('')}
  `).join('');
}

function renderItemCard(item){
  const s = getStatus(item);
  const loc = LOCATIONS[item.location] || { label: item.location, icon: '📦' };
  const noteHtml = item.note ? `<div class="item-note">📝 ${escapeHtml(item.note)}</div>` : '';
  const hasUrl = !!(item.url && String(item.url).trim());
  const supList = getItemSuppliers(item);
  const supLabel = supList.length ? supList.join(' / ') : '購入先';
  const linkBtn = hasUrl ? `<a class="item-link-btn" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">🛒 ${escapeHtml(supLabel)}</a>` : '';
  const thr = (item.minStock != null && item.minStock !== '') ? `補充ライン: ${item.minStock}` : '';
  const subtitle = item.category ? escapeHtml(item.category) : '未分類';
  const isOrdered = !!item.ordered;
  // 発注ボタン: 発注リスト(URLあり)で発注必要 もしくは 既に発注済みの場合に表示
  const showOrderToggle = isOrdered || (s === 'order' && hasUrl);
  const orderBtn = showOrderToggle
    ? `<button class="item-edit-btn order-toggle ${isOrdered?'on':''}" onclick="toggleOrdered('${item.id}')">${isOrdered?'✅ 発注済み (取消)':'📤 発注済みにする'}</button>`
    : '';
  const statusBadge = isOrdered
    ? `<span class="item-tag ordered">✅ 発注済み</span>`
    : `<span class="item-tag ${s}">${statusLabel(s)}</span>`;
  return `
    <div class="item-card ${isOrdered?'ordered':''}" data-id="${item.id}">
      <div class="item-row1">
        <div class="item-title-wrap">
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="item-subtitle">${subtitle}</div>
        </div>
        <div class="item-meta">
          ${statusBadge}
          <span class="item-tag">${loc.icon} ${escapeHtml(loc.label)}</span>
        </div>
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
        ${orderBtn}
        ${linkBtn}
        <button class="item-edit-btn" onclick="openModal({id:'${item.id}'})">編集</button>
      </div>
    </div>
  `;
}

function renderSupplierChips(selected){
  const wrap = document.getElementById('f-supplier-chips');
  if (!wrap) return;
  const all = getAllSuppliers();
  const sel = new Set(selected || []);
  // selected の中で all に無いもの (旧データ等) も末尾に表示しておく
  const extras = (selected || []).filter(s => !all.includes(s));
  const list = [...all, ...extras];
  if (list.length === 0){
    wrap.innerHTML = '<div class="supplier-empty">下の入力欄から仕入れ先を追加してください</div>';
    return;
  }
  wrap.innerHTML = list.map(name => {
    const active = sel.has(name) ? 'active' : '';
    const removable = !isPresetSupplier(name);
    return `<button type="button" class="supplier-chip ${active}" data-supplier="${escapeAttr(name)}" onclick="toggleSupplierChip('${escapeAttr(name)}')">${escapeHtml(name)}${removable ? `<span class="supplier-chip-x" onclick="event.stopPropagation();removeCustomSupplier('${escapeAttr(name)}')">✕</span>` : ''}</button>`;
  }).join('');
}
function toggleSupplierChip(name){
  const btn = document.querySelector(`#f-supplier-chips .supplier-chip[data-supplier="${name}"]`);
  if (btn) btn.classList.toggle('active');
}
function collectSelectedSuppliers(){
  return [...document.querySelectorAll('#f-supplier-chips .supplier-chip.active')]
    .map(b => b.dataset.supplier);
}
function addCustomSupplier(){
  const inp = document.getElementById('f-supplier-new');
  const name = inp.value.trim();
  if (!name){ showToast('店名を入力してください'); return; }
  const all = getAllSuppliers();
  if (all.includes(name)){ showToast('既に登録済みです'); return; }
  const custom = loadCustomSuppliers();
  custom.push(name);
  saveCustomSuppliers(custom);
  inp.value = '';
  // 既存の選択を維持しつつ、新規分を選択状態で追加
  const selected = collectSelectedSuppliers();
  selected.push(name);
  renderSupplierChips(selected);
  showToast(`「${name}」を仕入れ先に追加`);
}
function removeCustomSupplier(name){
  if (isPresetSupplier(name)) return;
  if (!confirm(`「${name}」を仕入れ先一覧から削除しますか?\n(既に登録された品目の仕入れ先設定からも外れます)`)) return;
  const custom = loadCustomSuppliers().filter(s => s !== name);
  saveCustomSuppliers(custom);
  // 既存の品目からこの supplier を除外
  let touched = false;
  for (const it of STATE.items){
    if (Array.isArray(it.suppliers) && it.suppliers.includes(name)){
      it.suppliers = it.suppliers.filter(s => s !== name);
      it.updatedAt = now();
      syncItem(it);
      touched = true;
    }
  }
  if (touched) saveItems();
  // 選択状態を維持して再描画
  const selected = collectSelectedSuppliers().filter(s => s !== name);
  renderSupplierChips(selected);
  showToast(`「${name}」を削除しました`);
}

// 1アイテムの数値・状態だけを DOM 上で書き換える(リスト全体は再描画しない)
// → +/- ボタン連打中にカードがソート移動して見失う問題の解消
function updateItemCardInPlace(item){
  const cards = document.querySelectorAll(`.item-card[data-id="${item.id}"]`);
  if (cards.length === 0) return;
  const isOrdered = !!item.ordered;
  const s = getStatus(item);
  cards.forEach(card => {
    const qtyNum = card.querySelector('.qty-num');
    if (qtyNum) qtyNum.textContent = item.stock ?? 0;
    card.classList.toggle('ordered', isOrdered);
    // ステータスバッジ (item-row1 内の最初の .item-tag)
    const firstTag = card.querySelector('.item-row1 .item-meta .item-tag');
    if (firstTag){
      if (isOrdered){
        firstTag.className = 'item-tag ordered';
        firstTag.textContent = '✅ 発注済み';
      } else {
        firstTag.className = 'item-tag ' + s;
        firstTag.textContent = statusLabel(s);
      }
    }
    // 発注ボタン (発注リスト内のみ存在)
    const orderBtn = card.querySelector('.order-toggle');
    if (orderBtn){
      orderBtn.classList.toggle('on', isOrdered);
      orderBtn.textContent = isOrdered ? '✅ 発注済み (取消)' : '📤 発注済みにする';
    }
  });
}

function toggleOrdered(id){
  const item = STATE.items.find(i=>i.id===id);
  if (!item) return;
  item.ordered = !item.ordered;
  item.updatedAt = now();
  saveItems();
  syncItem(item);
  addLog(item.ordered ? '発注済みにした' : '発注済み解除', item.name);
  renderKpis();
  updateItemCardInPlace(item);
  showToast(item.ordered ? '発注済みにしました' : '発注済みを解除しました');
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
  if (delta > 0 && item.ordered) item.ordered = false; // 入荷時に発注済みを自動解除
  item.updatedAt = now();
  saveItems();
  syncItem(item);
  addLog(delta > 0 ? '在庫追加' : '在庫消費', item.name, `${before} → ${after} ${item.unit || ''}`);
  // 全リストの再描画はせず、KPI と該当カードのみ in-place 更新
  // → 補充ライン跨ぎでカードが消えたり位置が動いたりせず、最後まで入力できる
  renderKpis();
  updateItemCardInPlace(item);
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
  if (v > before && item.ordered) item.ordered = false; // 入荷時に発注済みを自動解除
  item.updatedAt = now();
  saveItems();
  syncItem(item);
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
  renderSupplierChips(item?.suppliers || []);
  document.getElementById('f-supplier-new').value = '';
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
  const suppliers = collectSelectedSuppliers();
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
      suppliers, url, note,
      updatedAt: now(),
    });
    delete item.supplier;
    saveItems();
    syncItem(item);
    addLog('品目編集', name);
    showToast('保存しました');
  } else {
    const initial = document.getElementById('f-stock').value;
    const newItem = {
      id: uid(),
      name, location, category, unit,
      minStock: minStock === '' ? 0 : Number(minStock),
      target: target === '' ? null : Number(target),
      suppliers, url, note,
      stock: initial === '' ? 0 : Number(initial),
      createdAt: now(),
      updatedAt: now(),
    };
    STATE.items.push(newItem);
    saveItems();
    syncItem(newItem);
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
  syncDeleteItem(id);
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
      if (STATE.cloudUser && window.kateiSync){
        window.kateiSync.pushAll({ items: STATE.items, logs: STATE.logs }).catch(err => showToast('クラウド反映失敗: ' + err.message));
      }
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
function loadTemplates(){
  const templates = window.KATEI_TEMPLATES || [];
  if (templates.length === 0){ showToast('テンプレートが見つかりません'); return; }
  // 同名+同loc は重複扱い
  const existing = new Set(STATE.items.map(i => `${i.name}|${i.location}`));
  const toAdd = templates.filter(t => !existing.has(`${t.name}|${t.location}`));
  if (toAdd.length === 0){ showToast('追加できる新しい品目がありません'); return; }
  if (!confirm(`${toAdd.length}件のテンプレート品目を追加します。よろしいですか?`)) return;
  const t = now();
  for (const tmpl of toAdd){
    const item = {
      id: uid(),
      name: tmpl.name,
      location: tmpl.location,
      category: tmpl.category || '食材',
      unit: tmpl.unit || '個',
      minStock: tmpl.minStock ?? 0,
      target: tmpl.target ?? null,
      suppliers: [],
      url: '',
      note: '',
      stock: 0,
      createdAt: t,
      updatedAt: t,
    };
    STATE.items.push(item);
    syncItem(item);
  }
  saveItems();
  addLog('テンプレート追加', '', `${toAdd.length}件`);
  renderKpis();
  if (STATE.currentTab === 'loc') renderLoc();
  showToast(`${toAdd.length}件 追加しました`);
}

function clearAll(){
  if (!confirm('すべての在庫データと履歴を削除します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に削除しますか？')) return;
  STATE.items = []; STATE.logs = [];
  saveItems(); saveLogs();
  if (STATE.cloudUser && window.kateiSync) {
    window.kateiSync.clearAll().catch(err => showToast('クラウド削除失敗: ' + err.message));
  }
  renderKpis(); renderLoc();
  showToast('すべて削除しました');
}

/* ---------- escape ---------- */
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

/* ---------- Cloud sync (Firebase) ---------- */
function renderCloudUI(){
  const status = document.getElementById('cloud-status');
  const form = document.getElementById('cloud-login-form');
  const loggedIn = document.getElementById('cloud-logged-in');
  if (!status || !form || !loggedIn) return;
  if (STATE.cloudUser){
    const synced = STATE.lastSyncedAt ? `\n最終同期: ${fmtDate(STATE.lastSyncedAt)}` : '';
    status.textContent = `✅ ログイン中: ${STATE.cloudUser.email}\n品目 ${STATE.items.length}件 / 履歴 ${STATE.logs.length}件${synced}`;
    status.classList.add('connected');
    form.style.display = 'none';
    loggedIn.style.display = '';
  } else {
    status.textContent = '未ログイン';
    status.classList.remove('connected');
    form.style.display = '';
    loggedIn.style.display = 'none';
  }
}
function cloudPullAll(){
  if (!window.kateiSync || !STATE.cloudUser){ showToast('ログインしてください'); return; }
  if (!confirm('クラウドのデータをこの端末に取り込み、ローカルデータを上書きします。よろしいですか?')) return;
  window.kateiSync.fetchAllOnce()
    .then(({ items, logs }) => {
      STATE.items = items;
      STATE.logs = logs;
      saveItems(); saveLogs();
      STATE.lastSyncedAt = new Date().toISOString();
      renderKpis();
      renderCloudUI();
      if (STATE.currentTab === 'loc') renderLoc();
      else if (STATE.currentTab === 'log') renderLog();
      showToast(`${items.length}件 取り込みました`);
    })
    .catch(err => showToast('取り込み失敗: ' + err.message));
}
function cloudSignIn(){
  const email = document.getElementById('cloud-email').value.trim();
  const password = document.getElementById('cloud-password').value;
  if (!email || !password){ showToast('メールとパスワードを入力してください'); return; }
  if (!window.kateiSync){ showToast('Firebase の準備ができていません'); return; }
  window.kateiSync.signIn(email, password)
    .then(() => { showToast('ログインしました'); document.getElementById('cloud-password').value = ''; })
    .catch(err => showToast('ログイン失敗: ' + (err.code || err.message)));
}
function cloudSignOut(){
  if (!window.kateiSync) return;
  window.kateiSync.signOut().then(() => showToast('ログアウトしました'));
}
function cloudPushAll(){
  if (!window.kateiSync || !STATE.cloudUser){ showToast('ログインしてください'); return; }
  if (!confirm(`この端末の ${STATE.items.length}件 と履歴 ${STATE.logs.length}件 をクラウドに上書きアップロードします。よろしいですか?`)) return;
  window.kateiSync.pushAll({ items: STATE.items, logs: STATE.logs })
    .then(() => showToast('アップロードしました'))
    .catch(err => showToast('失敗: ' + err.message));
}
function setupCloudListeners(){
  window.addEventListener('katei-auth-change', e => {
    STATE.cloudUser = e.detail.user;
    renderCloudUI();
  });
  window.addEventListener('katei-items-change', e => {
    STATE.items = e.detail.items;
    STATE.lastSyncedAt = e.detail.syncedAt || new Date().toISOString();
    saveItems();
    renderKpis();
    renderCloudUI();
    if (STATE.currentTab === 'loc') renderLoc();
    else if (STATE.currentTab === 'status') renderStatus();
  });
  window.addEventListener('katei-logs-change', e => {
    STATE.logs = e.detail.logs;
    saveLogs();
    if (STATE.currentTab === 'log') renderLog();
  });
  window.addEventListener('katei-sync-error', e => {
    showToast(`同期エラー(${e.detail.kind}): ${e.detail.message}`);
  });
  // ログイン直後にクラウドが空かつローカルにデータがある場合、ローカルが消えないようpush提案
  window.addEventListener('katei-firestore-empty', () => {
    if (STATE.items.length === 0 && STATE.logs.length === 0) return;
    const ok = confirm(
      `クラウドにはまだデータがありません。\nこの端末の品目 ${STATE.items.length} 件 / 履歴 ${STATE.logs.length} 件 をクラウドにアップロードしますか?\n\n「いいえ」を押すとローカルデータはそのまま、クラウドは空のままになります。`
    );
    if (ok && window.kateiSync){
      window.kateiSync.pushAll({ items: STATE.items, logs: STATE.logs })
        .then(() => showToast(`${STATE.items.length}件をアップロードしました`))
        .catch(err => showToast('アップロード失敗: ' + err.message));
    }
  });
}

/* ---------- init ---------- */
function init(){
  loadAll();
  setupCloudListeners();
  renderKpis();
  showTab('loc');
  renderLoc();
  renderCloudUI();
  // Service Worker - 古いコードに張り付かないよう、更新検知時に即リロード
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => reg.update()).catch(()=>{});
    let reloadingForSW = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForSW) return;
      reloadingForSW = true;
      window.location.reload();
    });
  }
}
document.addEventListener('DOMContentLoaded', init);
