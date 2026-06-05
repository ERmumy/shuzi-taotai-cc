'use strict';
/* 数字淘汰 · 卡通版 —— 客户端 */

const socket = io();
const app = document.getElementById('app');

// 持久身份（刷新/重连仍是同一玩家）
const PID_KEY = 'sztt_pid', NAME_KEY = 'sztt_name', TUT_KEY = 'sztt_tut_seen', ROOM_KEY = 'sztt_room';
let playerId = localStorage.getItem(PID_KEY);
if (!playerId) { playerId = 'p_' + Math.random().toString(36).slice(2, 10); localStorage.setItem(PID_KEY, playerId); }
let myName = localStorage.getItem(NAME_KEY) || '';
let savedRoom = (localStorage.getItem(ROOM_KEY) || '').toUpperCase(); // 关页面/刷新前所在房间，用于自动归位

// 本地界面状态
let view = 'home';        // home | tutorial | room | reconnecting
let inRoom = false;
let tutIndex = 0;
let tutReturnTo = 'home'; // 看完教学回到哪
let state = null;         // 服务端最新对局状态
let selNum = null;        // 出数前的本地选择
let lastPhaseKey = '';    // 用于切换轮次时重置本地选择

// 从二维码链接进入
const roomFromUrl = (new URLSearchParams(location.search).get('room') || '').toUpperCase();

// 首次游玩 → 自动进入教学
if (!localStorage.getItem(TUT_KEY)) { view = 'tutorial'; tutReturnTo = 'home'; }

// 关页面前还在某个房间里 → 先进入“重连中”，socket 连上后自动归位
if (savedRoom && view !== 'tutorial' && (!roomFromUrl || roomFromUrl === savedRoom)) {
  view = 'reconnecting';
}

// ---------------- 工具 ----------------
function h(html) { return html; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }
function gameAct(action, payload) {
  return new Promise(res => socket.emit('game', { action, payload }, r => {
    if (r && r.ok === false && r.msg) toast(r.msg);
    res(r);
  }));
}
function fmtSip(k) {
  if (!k) return '0 口';
  const cup = k / 3;
  return `${k} 口` + (k >= 3 ? `（${Number.isInteger(cup) ? cup : cup.toFixed(1)} 杯）` : '');
}

// ---------------- Socket ----------------
function saveRoom(code) { savedRoom = (code || '').toUpperCase(); localStorage.setItem(ROOM_KEY, savedRoom); }
function clearSavedRoom() { savedRoom = ''; localStorage.removeItem(ROOM_KEY); }
// 用存档房间号自动重新加入（重开页面/断线后回到原局）
function attemptRejoin(code) {
  code = (code || '').toUpperCase().trim();
  if (!code) return;
  socket.emit('join', { roomCode: code, name: myName || '玩家', playerId }, (r) => {
    if (r && r.ok) {
      inRoom = true;
      if (view !== 'tutorial') view = 'room';
      saveRoom(code);
    } else {
      clearSavedRoom();
      if (view === 'reconnecting') { view = 'home'; render(); }
      if (r && r.msg) toast(r.msg);
    }
  });
}
socket.on('connect', () => {
  if (inRoom && state) {
    // 页内瞬断重连：回到当前房间
    socket.emit('join', { roomCode: state.roomCode, name: myName, playerId }, () => {});
  } else if (savedRoom && (!roomFromUrl || roomFromUrl === savedRoom)) {
    // 整页重开/断线后：用存档房间号自动归位
    attemptRejoin(savedRoom);
  }
});
socket.on('state', (s) => {
  const prevPhase = state && state.phase;
  state = s; inRoom = true; if (view !== 'tutorial') view = 'room';
  // 进入新的出数轮或亮数时给点反馈
  const key = s.phase + ':' + s.subRound + ':' + (s.reveal ? s.reveal.note : '');
  if (key !== lastPhaseKey) {
    lastPhaseKey = key; selNum = null;
    if (['collect', 'endgame_collect', 'final_collect'].includes(s.phase) && s.you && s.you.alive) vibrate(40);
    if (s.phase === 'reveal') vibrate([30, 40, 30]);
  }
  render();
});

// ---------------- 入口动作 ----------------
function createRoom() {
  if (!ensureName()) return;
  socket.emit('create', { name: myName, playerId }, (r) => { if (r && r.ok) saveRoom(r.roomCode);
    if (r && r.ok) { inRoom = true; view = 'room'; }
  });
}
function joinRoom(code) {
  if (!ensureName()) return;
  code = (code || '').toUpperCase().trim();
  if (code.length < 4) return toast('请输入 4 位房间号');
  socket.emit('join', { roomCode: code, name: myName, playerId }, (r) => { if (r && r.ok) saveRoom(r.roomCode || code);
    if (r && r.ok) { inRoom = true; view = 'room'; }
    else toast((r && r.msg) || '加入失败');
  });
}
function ensureName() {
  const el = document.getElementById('nameInput');
  if (el) myName = el.value.trim();
  if (!myName) { toast('先起个名字吧～'); el && el.focus(); return false; }
  localStorage.setItem(NAME_KEY, myName);
  return true;
}

// =================================================================
//  渲染
// =================================================================
function render() {
  if (view === 'tutorial') return app.replaceChildren(elFromHTML(renderTutorial()));
  if (view === 'reconnecting' && (!inRoom || !state)) return app.replaceChildren(elFromHTML(renderReconnecting()));
  if (!inRoom || !state) return app.replaceChildren(elFromHTML(renderHome()));
  return app.replaceChildren(elFromHTML(renderRoom()));
}
function elFromHTML(html) { const d = document.createElement('div'); d.innerHTML = html; bindLater(); return d.firstElementChild; }

// 事件绑定：用事件委托，避免重渲染丢监听
app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, val = t.dataset.val;
  handleAction(act, val, t);
});
function bindLater() {}

function handleAction(act, val) {
  switch (act) {
    case 'create': return createRoom();
    case 'join': return joinRoom(document.getElementById('codeInput')?.value);
    case 'show-tut': tutIndex = 0; tutReturnTo = inRoom ? 'room' : 'home'; view = 'tutorial'; return render();
    case 'tut-next': return tutNext(1);
    case 'tut-prev': return tutNext(-1);
    case 'tut-skip': return endTutorial();
    case 'start': return gameAct('start', { tutorial: !!startTutOn });
    case 'toggle-start-tut': startTutOn = !startTutOn; return render();
    case 'select-num': selNum = Number(val); return render();
    case 'lock-num': return lockNum();
    case 'consent': return gameAct('consent', { choice: val });
    case 'endgame': selNum = Number(val); return render();
    case 'lock-endgame': if (selNum) gameAct('endgamePick', { value: selNum }); selNum = null; return;
    case 'revival-pick': return gameAct('revivalPick', { targetId: val });
    case 'revival-decide': return gameAct('revivalDecide', { choice: val });
    case 'final': selNum = Number(val); return render();
    case 'lock-final': if (selNum) gameAct('finalPick', { value: selNum }); selNum = null; return;
    case 'toggle-token': return gameAct('toggleToken', { use: val === '1' });
    case 'proceed': return gameAct('proceed');
    case 'restart': return gameAct('restart');
    case 'copy-url': return copyJoin();
    case 'kick': return gameAct('kick', { targetId: val });
    case 'leave': clearSavedRoom(); inRoom = false; view = 'home'; state = null; location.href = location.pathname; return;
  }
}
function lockNum() {
  if (!selNum) return toast('先选一个数字');
  gameAct('pick', { value: selNum });
}

let startTutOn = true; // 房主默认开启新手教学

// ---------------- 重连中 ----------------
function renderReconnecting() {
  return `
  <div class="screen">
    <div class="logo"><span class="emoji">🔄</span><h1>正在重连…</h1>
      <p>回到房间 ${esc(savedRoom)}</p></div>
    <div class="card center">
      <div class="waiting">连接服务器中<span class="dots"></span></div>
      <p class="muted" style="margin-top:10px;font-size:13px">服务器若在休眠，首次可能要等几十秒</p>
    </div>
    <button class="btn btn-ghost btn-block" data-act="leave">返回首页</button>
  </div>`;
}

// ---------------- 首页 ----------------
function renderHome() {
  const nameVal = esc(myName);
  const codeVal = esc(roomFromUrl);
  return `
  <div class="screen">
    <div class="logo">
      <span class="emoji">🍻</span>
      <h1>数字淘汰</h1>
      <p>卡通版 · 手机多人在线博弈</p>
    </div>
    <div class="card">
      <p class="label">你的昵称</p>
      <input id="nameInput" class="input" maxlength="8" placeholder="起个名字" value="${nameVal}">
    </div>
    ${roomFromUrl ? `
    <div class="card">
      <p class="label">扫码进入房间</p>
      <input id="codeInput" class="input code" maxlength="4" value="${codeVal}">
      <div style="height:12px"></div>
      <button class="btn btn-primary btn-block" data-act="join">🚪 加入房间 ${codeVal}</button>
    </div>` : `
    <button class="btn btn-primary btn-block" data-act="create">✨ 创建房间（当房主）</button>
    <div class="card">
      <p class="label">输入房间号加入</p>
      <input id="codeInput" class="input code" maxlength="4" placeholder="ABCD">
      <div style="height:12px"></div>
      <button class="btn btn-green btn-block" data-act="join">🚪 加入房间</button>
    </div>`}
    <button class="btn btn-ghost btn-block" data-act="show-tut">📖 看规则 / 新手教学</button>
    <div class="spacer"></div>
    <p class="fineprint">同一 WiFi 下：一人创建房间，其他人扫码或输房间号加入<br>每人一部手机，同时出数 · 3–20 人</p>
  </div>`;
}

// ---------------- 教学卡片 ----------------
const TUT_CARDS = [
  { e: '🎯', t: '游戏目标', b: `每轮大家<b>同时</b>报一个数字。<br>报<b>小数</b>抢着「逃生通关」，报<b>大数</b>换「免酒令牌🛡️」。<br>笑到最后或喝得最少就是赢家！` },
  { e: '🔢', t: '怎么出数', b: `场上有几个人，就报 <b>1 到几</b> 的整数。<br>例如 5 人时，报 1、2、3、4、5 都行。<br>大家锁定后<b>同时亮出</b>。` },
  { e: '💥', t: '撞车作废', b: `如果一个数字被<b>两人或以上</b>报出 → 全部作废！<br>报这些数字的人<b>喝当轮罚酒</b>，但<b>留在场上</b>继续玩。` },
  { e: '🎉', t: '动态放生（通关）', b: `没撞车的数字里，从<b>小到大</b>放生若干人，<b>通关出局</b>不再喝酒。<br>人越多放越多：<span class="tut-mini"><span class="m">17-20人放5</span><span class="m">9-12人放3</span><span class="m">3-6人放1</span></span>` },
  { e: '🛡️', t: '免酒令牌', b: `放生后，留场玩家里报出<b>最大独有数字</b>的人，得 1 枚<b>免酒令牌</b>。<br>喝酒前亮出，可<b>抵 1 杯（3口）</b>。这就是报大数的价值！` },
  { e: '🍶', t: '罚酒会涨', b: `撞车罚酒随小轮递增，<b>3 口封顶</b>：<br><span class="tut-mini"><span class="m">第1-2轮 1口</span><span class="m">第3-4轮 2口</span><span class="m">第5轮起 3口</span></span><br>越拖越贵，早逃生更稳！` },
  { e: '🐔', t: '终局 · 斗鸡博弈', b: `剩 2 人时进入终局，各报 <b>1 或 2</b>：<br>· 一人1一人2 → 报 <b>2</b> 的人输喝 2 杯<br>· 都报1 → 撞死，<b>各喝 4 杯</b><br>· 都报2 → 触发<b>复活</b>！` },
  { e: '🔮', t: '复活 & 最终局', b: `双双报 2 时，可<b>邀请一名已通关的人</b>回归。<br>他接受 → 得 1 令牌，三人报 <b>1-3</b> 打最终局，<b>最小独有数字</b>的人逃脱，其余垫底喝 2 杯。` },
  { e: '🍻', t: '准备开玩！', b: `记住口诀：<br><b>小数抢逃生，大数换免死</b>。<br>祝你滴酒不沾，把朋友们都灌倒～` },
];
function renderTutorial() {
  const c = TUT_CARDS[tutIndex];
  const last = tutIndex === TUT_CARDS.length - 1;
  const dots = TUT_CARDS.map((_, i) => `<span class="d ${i === tutIndex ? 'on' : ''}"></span>`).join('');
  return `
  <div class="screen tut">
    <div class="center muted" style="font-weight:800">规则教学 ${tutIndex + 1}/${TUT_CARDS.length}</div>
    <div class="card tut-card">
      <div class="tut-emoji">${c.e}</div>
      <h2>${c.t}</h2>
      <div class="body">${c.b}</div>
    </div>
    <div class="tut-dots">${dots}</div>
    <div class="row">
      ${tutIndex > 0 ? `<button class="btn btn-ghost" data-act="tut-prev">← 上一张</button>` : `<button class="btn btn-ghost" data-act="tut-skip">跳过</button>`}
      <button class="btn btn-primary" data-act="${last ? 'tut-skip' : 'tut-next'}">${last ? '开始玩 🎮' : '下一张 →'}</button>
    </div>
  </div>`;
}
function tutNext(d) { tutIndex = Math.max(0, Math.min(TUT_CARDS.length - 1, tutIndex + d)); render(); }
function endTutorial() {
  localStorage.setItem(TUT_KEY, '1');
  view = tutReturnTo === 'room' && inRoom ? 'room' : 'home';
  render();
}

// ---------------- 房间总路由 ----------------
function renderRoom() {
  switch (state.phase) {
    case 'lobby': return renderLobby();
    case 'collect': return renderCollect();
    case 'reveal': return renderReveal();
    case 'endgame_consent': return renderEndgameConsent();
    case 'endgame_collect': return renderEndgameCollect();
    case 'revival_select': return renderRevivalSelect();
    case 'revival_decide': return renderRevivalDecide();
    case 'final_collect': return renderFinalCollect();
    case 'gameover': return renderGameover();
    default: return `<div class="screen"><div class="card">未知状态</div></div>`;
  }
}

function topbar() {
  const you = state.you || {};
  return `
  <div class="topbar">
    <div><div class="room">房间 ${state.roomCode}</div></div>
    <div class="stats">
      <span class="pill tk">🛡️ ${you.tokens || 0}</span>
      <span class="pill">🍶 ${you.drinks || 0}口</span>
    </div>
  </div>`;
}
function playerChips() {
  return `<div class="players">` + state.players.map(p => {
    const cls = ['chip'];
    if (p.isHost) cls.push('host');
    if (state.phase === 'collect' && p.alive && p.hasPicked) cls.push('picked');
    if (!p.connected) cls.push('off');
    const me = p.id === playerId;
    let tag = '';
    if (p.isHost) tag = `<span class="tag host">房主</span>`;
    else if (me) tag = `<span class="tag me">你</span>`;
    if (state.phase === 'collect' && p.alive && p.hasPicked) tag = `<span class="tag ok">已出</span>`;
    const status = p.escaped ? '🎉' : (!p.alive && state.phase !== 'lobby' ? '' : '');
    return `<div class="${cls.join(' ')}">
      <span class="av">${p.avatar}</span>
      <span class="nm">${esc(p.name)}${status}</span>
      ${tag}
    </div>`;
  }).join('') + `</div>`;
}
function logFeed() {
  if (!state.log || !state.log.length) return '';
  return `<div class="card tight"><div class="log">` +
    state.log.map(l => `<div class="log-item">${esc(l)}</div>`).join('') +
    `</div></div>`;
}
function hintBanner(text) {
  if (!state.tutorialMode || !text) return '';
  return `<div class="hint"><span class="b">💡</span><span>${text}</span></div>`;
}

// ---------------- 大厅 ----------------
function renderLobby() {
  const n = state.players.length;
  const canStart = n >= 3;
  const host = state.youAreHost;
  // 异步取二维码
  ensureQR();
  return `
  <div class="screen">
    ${topbar()}
    <div class="logo" style="margin:0"><span class="emoji" style="font-size:40px">🍻</span><h1 style="font-size:22px">等待玩家加入</h1></div>
    <div class="card qrwrap">
      <div id="qrbox"><div class="waiting">生成二维码<span class="dots"></span></div></div>
      <div class="big-num" style="color:var(--purple);letter-spacing:6px">${state.roomCode}</div>
      <div class="joinurl" id="joinurl"></div>
      <div style="height:10px"></div>
      <button class="btn btn-ghost btn-sm btn-block" data-act="copy-url">📋 复制加入链接</button>
    </div>
    <div class="card tight">
      <div class="section-title">👥 已加入 ${n}/20 ${n < 3 ? '<span class="muted" style="font-size:13px">（至少3人）</span>' : ''}</div>
      <div style="height:10px"></div>
      ${lobbyPlayers(host)}
    </div>
    ${host ? `
    <div class="card tight">
      <div class="toggle-row">
        <span>🔰 新手教学模式<br><span class="muted" style="font-size:12px;font-weight:600">每步显示规则提示，第一次玩建议开</span></span>
        <span class="switch ${startTutOn ? 'on' : ''}" data-act="toggle-start-tut"><span class="knob"></span></span>
      </div>
    </div>
    <button class="btn btn-primary btn-block" data-act="start" ${canStart ? '' : 'disabled'}>${canStart ? '🎮 开始游戏' : '至少需要 3 人'}</button>
    ` : `<div class="waiting">等房主开始游戏<span class="dots"></span></div>`}
    <button class="btn btn-ghost btn-sm btn-block" data-act="show-tut">📖 看规则教学</button>
    <button class="btn btn-ghost btn-sm btn-block" data-act="leave">退出房间</button>
  </div>`;
}
function lobbyPlayers(host) {
  return `<div class="players">` + state.players.map(p => {
    const me = p.id === playerId;
    const cls = ['chip']; if (p.isHost) cls.push('host'); if (!p.connected) cls.push('off');
    let tag = p.isHost ? `<span class="tag host">房主</span>` : (me ? `<span class="tag me">你</span>` : '');
    const kick = host && !p.isHost ? `<span data-act="kick" data-val="${p.id}" style="color:#ff5a7a;font-weight:900;padding:0 4px">✕</span>` : '';
    return `<div class="${cls.join(' ')}"><span class="av">${p.avatar}</span><span class="nm">${esc(p.name)}</span>${tag}${kick}</div>`;
  }).join('') + `</div>`;
}

let _qrCode = null;
function ensureQR() {
  if (_qrCode === state.roomCode) return;
  _qrCode = state.roomCode;
  fetch('/qr/' + state.roomCode).then(r => r.json()).then(d => {
    const box = document.getElementById('qrbox');
    const url = document.getElementById('joinurl');
    if (box) box.innerHTML = `<img src="${d.dataUrl}" alt="加入二维码">`;
    if (url) url.textContent = d.url;
    joinUrlCache = d.url;
  }).catch(() => {});
}
let joinUrlCache = '';
function copyJoin() {
  const text = joinUrlCache || (location.origin + '/?room=' + state.roomCode);
  navigator.clipboard?.writeText(text).then(() => toast('链接已复制～')).catch(() => toast(text));
}

// ---------------- 常规出数 ----------------
function renderCollect() {
  const you = state.you;
  const alive = you && you.alive;
  const locked = you && you.pick != null;
  const pendingNames = state.players.filter(p => p.alive && !p.hasPicked).map(p => p.name);
  const range = state.range;

  let main;
  if (!alive) {
    main = `<div class="card center"><div class="tut-emoji" style="font-size:54px">🎉</div>
      <div class="section-title center" style="justify-content:center">你已通关，安全上岸！</div>
      <p class="muted">围观这一轮，看谁要喝～</p></div>`;
  } else if (locked) {
    main = `<div class="card center">
      <p class="muted">你出了</p>
      <div class="big-num" style="color:var(--coral)">${you.pick}</div>
      <div class="waiting">等其他人出数<span class="dots"></span></div>
      ${pendingNames.length ? `<p class="muted">还差：${pendingNames.map(esc).join('、')}</p>` : ''}
    </div>`;
  } else {
    const cols = range > 6 ? '' : 'few';
    const nums = Array.from({ length: range }, (_, i) => i + 1).map(v =>
      `<button class="num ${selNum === v ? 'sel' : ''}" data-act="select-num" data-val="${v}">${v}</button>`).join('');
    main = `<div class="card">
      <div class="section-title">🔢 报一个数（1–${range}）</div>
      <div style="height:12px"></div>
      <div class="numpad ${cols}">${nums}</div>
      <div style="height:14px"></div>
      <button class="btn btn-primary btn-block" data-act="lock-num" ${selNum ? '' : 'disabled'}>${selNum ? `锁定出数 ${selNum} ✓` : '先选一个数字'}</button>
    </div>`;
  }

  const hint = hintBanner(`第 ${state.subRound} 小轮，撞车各喝 <b>${state.basePenalty} 口</b>。想通关就抢小数、又怕和别人撞；报最大独有数字能拿免酒令牌🛡️。`);
  return `
  <div class="screen">
    ${topbar()}
    <div class="center" style="font-weight:900;font-size:16px">第 ${state.subRound} 小轮 · 场上 ${state.fieldSize} 人</div>
    ${hint}
    ${main}
    <div class="card tight">${playerChips()}</div>
    ${logFeed()}
  </div>`;
}

// ---------------- 亮数 / 结算 ----------------
function renderReveal() {
  const r = state.reveal;
  const byId = Object.fromEntries(state.players.map(p => [p.id, p]));
  const cells = Object.entries(r.picks).map(([pid, val]) => {
    const p = byId[pid]; if (!p) return '';
    const collide = r.collidedNumbers.includes(val);
    const released = r.releasedIds.includes(pid);
    const isToken = r.tokenWinnerId === pid;
    const drink = r.finalDrinks[pid];
    const cls = ['cell'];
    if (collide) cls.push('collide');
    if (released) cls.push('released');
    if (isToken) cls.push('token');
    let st = '';
    if (released) st = `<div class="st">🎉通关</div>`;
    else if (collide) st = `<div class="st" style="color:var(--coral)">💥撞车</div>`;
    else if (isToken) st = `<div class="st" style="color:var(--purple)">🛡️得令牌</div>`;
    if (drink != null && drink >= 0 && r.drinks[pid]) {
      const used = r.drinks[pid] !== r.finalDrinks[pid];
      st += `<div class="st" style="color:var(--coral-d)">🍶${drink}口${used ? '<span style="color:var(--purple)">(令牌-3)</span>' : ''}</div>`;
    }
    return `<div class="${cls.join(' ')}">
      ${isToken ? '<span class="crown">🛡️</span>' : ''}
      <div class="av">${p.avatar}</div>
      <div class="pk">${val}</div>
      <div class="nm">${esc(p.name)}</div>
      ${st}
    </div>`;
  }).join('');

  // 令牌使用
  let tokenUI = '';
  if (r.youEligible) {
    tokenUI = `<div class="card tight">
      <div class="section-title">🛡️ 你有免酒令牌，可抵这次 1 杯（3口）</div>
      <div style="height:10px"></div>
      <div class="row">
        <button class="btn ${r.youUsingToken ? 'btn-purple' : 'btn-ghost'} btn-sm" data-act="toggle-token" data-val="1">${r.youUsingToken ? '✓ 用令牌抵3口' : '用令牌抵3口'}</button>
        <button class="btn ${!r.youUsingToken ? 'btn-ghost' : 'btn-ghost'} btn-sm" data-act="toggle-token" data-val="0" ${!r.youUsingToken ? 'style="opacity:.6"' : ''}>留着不用</button>
      </div>
    </div>`;
  }

  const proceed = state.youAreHost
    ? `<button class="btn btn-primary btn-block" data-act="proceed">${r.terminal ? '查看结算 🏁' : '继续下一轮 ▶'}</button>`
    : `<div class="waiting">等房主点「继续」<span class="dots"></span></div>`;

  const hint = hintBanner(revealHint(r));
  return `
  <div class="screen">
    ${topbar()}
    <div class="note-bar">${esc(r.note)}</div>
    ${hint}
    <div class="card"><div class="reveal-grid">${cells}</div></div>
    ${tokenUI}
    ${proceed}
    ${logFeed()}
  </div>`;
}
function revealHint(r) {
  switch (r.type) {
    case 'all_collide': return '没有人报出独有数字 → 全员撞车，各喝罚酒后<b>原地重报本小轮</b>（罚酒不涨、不发令牌）。';
    case 'normal': return '红色=撞车作废喝酒；绿色=最小独有数字<b>通关</b>；紫色皇冠=最大独有数字得<b>免酒令牌</b>。';
    case 'endgame_refuse': return '有人拒绝斗鸡，双方<b>共同承担</b>各 2 杯，避免单方坑人。';
    case 'endgame_result': return '终局斗鸡：报 1 抢逃生但怕撞，报 2 避开撞 1 却可能成最大输家。';
    case 'revival_refuse': return '被邀者拒绝复活 → 三人各喝 1 杯柔和收场，不强迫已通关的人回火坑。';
    case 'final_result': return '最终局只打一轮：<b>最小独有数字</b>逃脱，其余垫底，强制分胜负。';
    default: return '';
  }
}

// ---------------- 终局：同意 ----------------
function renderEndgameConsent() {
  const you = state.you, mine = you && you.alive;
  const decided = mine && you.consent != null;
  const both = state.players.filter(p => p.alive);
  const waiting = both.filter(p => !p.consent).map(p => p.name); // consent here is bool
  const main = !mine
    ? `<div class="card center"><div class="tut-emoji">🍿</div><p>两位决战者正在表态是否开战…</p></div>`
    : decided
      ? `<div class="card center"><div class="big-num">${you.consent === 'agree' ? '⚔️' : '🙅'}</div><div class="waiting">已选择「${you.consent === 'agree' ? '开战' : '拒绝'}」，等对方<span class="dots"></span></div></div>`
      : `<div class="card">
          <div class="section-title center" style="justify-content:center">🐔 终局斗鸡，是否开战？</div>
          <div style="height:14px"></div>
          <button class="btn btn-primary btn-block" data-act="consent" data-val="agree">⚔️ 同意开战（报1或2定胜负）</button>
          <div style="height:10px"></div>
          <button class="btn btn-ghost btn-block" data-act="consent" data-val="refuse">🙅 拒绝（双方各喝 2 杯收场）</button>
        </div>`;
  return `<div class="screen">
    ${topbar()}
    ${hintBanner('只剩 2 人。两人都同意才开战；任一方拒绝则<b>双方</b>各喝 2 杯，防止有人靠拒绝坑对手。')}
    ${main}
    <div class="card tight">${playerChips()}</div>
  </div>`;
}

// ---------------- 终局：报1/2 ----------------
function renderEndgameCollect() {
  const you = state.you, mine = you && you.alive;
  const locked = mine && you.pick != null;
  let main;
  if (!mine) main = `<div class="card center"><div class="tut-emoji">🍿</div><p>两位决战者正在出数…</p></div>`;
  else if (locked) main = `<div class="card center"><p class="muted">你出了</p><div class="big-num" style="color:var(--coral)">${you.pick}</div><div class="waiting">等对方<span class="dots"></span></div></div>`;
  else main = `<div class="card">
    <div class="section-title center" style="justify-content:center">⚔️ 报 1 或 2</div>
    <div style="height:12px"></div>
    <div class="numpad few">
      <button class="num big ${selNum === 1 ? 'sel' : ''}" data-act="endgame" data-val="1">1</button>
      <button class="num big ${selNum === 2 ? 'sel' : ''}" data-act="endgame" data-val="2">2</button>
    </div>
    <div style="height:14px"></div>
    <button class="btn btn-primary btn-block" data-act="lock-endgame" ${selNum ? '' : 'disabled'}>${selNum ? `锁定 ${selNum} ✓` : '选 1 或 2'}</button>
  </div>`;
  return `<div class="screen">
    ${topbar()}
    ${hintBanner('报 <b>1</b>：抢逃生，但两人都报1就撞死各喝4杯。报 <b>2</b>：避开撞1，但若对方报1你就是最大输家喝2杯。都报2 → 复活！')}
    ${main}
  </div>`;
}

// ---------------- 复活：选人 ----------------
function renderRevivalSelect() {
  const you = state.you, mine = you && you.alive;
  const escaped = state.players.filter(p => p.escaped);
  let main;
  if (!mine) {
    main = `<div class="card center"><div class="tut-emoji">🔮</div><p>两位决战者正在<b>协商</b>邀请谁回归…</p>
      ${you && you.escaped ? '<p class="muted">你已通关，可能被邀请回来打最终局</p>' : ''}</div>`;
  } else {
    main = `<div class="card">
      <div class="section-title">🔮 邀请一名已通关玩家回归</div>
      <p class="muted" style="margin:6px 0">两位决战者需<b>选同一个人</b>才生效</p>
      <div class="players">` +
      escaped.map(p => `<button class="chip" data-act="revival-pick" data-val="${p.id}" style="cursor:pointer">
        <span class="av">${p.avatar}</span><span class="nm">${esc(p.name)}</span></button>`).join('') +
      `</div></div>`;
  }
  return `<div class="screen">
    ${topbar()}
    ${hintBanner('双双报 2 触发复活。两位决战者<b>共同指定</b>一名已通关玩家邀请回归，需协商一致。')}
    ${main}
  </div>`;
}

// ---------------- 复活：被邀者决定 ----------------
function renderRevivalDecide() {
  const me = playerId === state.invitedId;
  const inviteeName = (state.players.find(p => p.id === state.invitedId) || {}).name || '';
  let main;
  if (me) {
    main = `<div class="card">
      <div class="section-title center" style="justify-content:center">📨 邀请你回归打最终局！</div>
      <div style="height:12px"></div>
      <button class="btn btn-green btn-block" data-act="revival-decide" data-val="accept">✅ 接受（得1令牌🛡️，三人最终局）</button>
      <div style="height:10px"></div>
      <button class="btn btn-ghost btn-block" data-act="revival-decide" data-val="refuse">🙅 拒绝（三人各喝1杯收场）</button>
    </div>`;
  } else {
    main = `<div class="card center"><div class="tut-emoji">📨</div><p><b>${esc(inviteeName)}</b> 正在决定是否回归…</p></div>`;
  }
  return `<div class="screen">
    ${topbar()}
    ${hintBanner('被邀请者可自由选择：接受则带着 1 枚免酒令牌进最终局；拒绝则三人各喝 1 杯柔和收场。')}
    ${main}
  </div>`;
}

// ---------------- 最终局 ----------------
function renderFinalCollect() {
  const you = state.you, mine = you && you.alive;
  const locked = mine && you.pick != null;
  let main;
  if (!mine) main = `<div class="card center"><div class="tut-emoji">🍿</div><p>三位玩家正在出数定胜负…</p></div>`;
  else if (locked) main = `<div class="card center"><p class="muted">你出了</p><div class="big-num" style="color:var(--coral)">${you.pick}</div><div class="waiting">等其他人<span class="dots"></span></div></div>`;
  else main = `<div class="card">
    <div class="section-title center" style="justify-content:center">🎲 最终局：报 1、2 或 3</div>
    <div style="height:12px"></div>
    <div class="numpad few">
      ${[1, 2, 3].map(v => `<button class="num big ${selNum === v ? 'sel' : ''}" data-act="final" data-val="${v}">${v}</button>`).join('')}
    </div>
    <div style="height:14px"></div>
    <button class="btn btn-primary btn-block" data-act="lock-final" ${selNum ? '' : 'disabled'}>${selNum ? `锁定 ${selNum} ✓` : '选一个数'}</button>
  </div>`;
  return `<div class="screen">
    ${topbar()}
    ${hintBanner('只打一轮强制分胜负：先作废撞车数字，<b>最小独有数字</b>的人逃脱，其余两人垫底各喝 2 杯。')}
    ${main}
    <div class="card tight">${playerChips()}</div>
  </div>`;
}

// ---------------- 结算 ----------------
function renderGameover() {
  // 排序：喝得越少越靠前；同酒量按通关名次
  const ps = [...state.players].sort((a, b) =>
    (a.drinks - b.drinks) || ((a.finishRank || 99) - (b.finishRank || 99)));
  const maxDrink = Math.max(...ps.map(p => p.drinks), 0);
  const items = ps.map((p, i) => {
    const win = p.drinks === 0;
    const loser = p.drinks === maxDrink && maxDrink > 0;
    const cls = ['rank-item']; if (win) cls.push('win'); else if (loser) cls.push('loser');
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    const sub = [];
    if (p.escaped) sub.push('🎉通关');
    if (p.tokens) sub.push(`🛡️余${p.tokens}`);
    sub.push(`🍶 ${fmtSip(p.drinks)}`);
    return `<div class="${cls.join(' ')}">
      <div class="pos">${medal}</div>
      <div class="av">${p.avatar}</div>
      <div class="info"><div class="nm">${esc(p.name)}${p.id === playerId ? ' <span class="tag me">你</span>' : ''}</div>
        <div class="sub">${sub.join(' · ')}</div></div>
      ${loser ? '<div style="font-size:24px">🍺</div>' : (win ? '<div style="font-size:24px">😎</div>' : '')}
    </div>`;
  }).join('');

  const loserName = ps.filter(p => p.drinks === maxDrink && maxDrink > 0).map(p => p.name);
  return `<div class="screen">
    <div class="logo" style="margin:6px 0"><span class="emoji">🏁</span><h1 style="font-size:24px">本局结算</h1>
      ${maxDrink > 0 ? `<p>今晚的酒蒙子：<b>${loserName.map(esc).join('、')}</b> 🍺</p>` : '<p>大家都很猛，谁也没喝多！</p>'}</div>
    <div class="card"><div class="rank">${items}</div></div>
    ${state.youAreHost
      ? `<button class="btn btn-primary btn-block" data-act="restart">🔄 再来一局</button>`
      : `<div class="waiting">等房主开下一局<span class="dots"></span></div>`}
    <button class="btn btn-ghost btn-sm btn-block" data-act="show-tut">📖 再看规则</button>
    <button class="btn btn-ghost btn-sm btn-block" data-act="leave">退出房间</button>
  </div>`;
}

// 初次渲染
render();
