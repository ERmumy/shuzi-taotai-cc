'use strict';
/*
 * server.js —— 房间管理 + 实时同步（Socket.IO）
 * 同一 WiFi 下：房主创建房间得到房间号/二维码，其余手机扫码或输号加入。
 */
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

// roomCode -> Game
const rooms = new Map();

// 大厅掉线宽限：key=`${roomCode}:${playerId}` -> 定时器。宽限期内重连可保住座位/头像/房主
const lobbyKickTimers = new Map();
const LOBBY_GRACE_MS = 60 * 1000;
function clearLobbyTimer(roomCode, playerId) {
  const key = roomCode + ':' + playerId;
  const t = lobbyKickTimers.get(key);
  if (t) { clearTimeout(t); lobbyKickTimers.delete(key); }
}
// 同一玩家可能刚用新页面/新连接重连：判断除当前 socket 外，是否还有该玩家的在线连接
function hasOtherLiveSocket(roomCode, playerId, exceptId) {
  const set = io.sockets.adapter.rooms.get(roomCode);
  if (!set) return false;
  for (const sid of set) {
    if (sid === exceptId) continue;
    const s = io.sockets.sockets.get(sid);
    if (s && s.data && s.data.playerId === playerId) return true;
  }
  return false;
}

// 生成不易混淆的 4 位房间号
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// 取局域网 IPv4（跳过 169.254 无效地址，优先常见私有网段）
function localIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) {
        candidates.push(ni.address);
      }
    }
  }
  const preferred = candidates.find(a =>
    a.startsWith('192.168.') || a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return preferred || candidates[0] || 'localhost';
}
const LAN_IP = localIP();
// 实际端口在 listen 成功后确定（端口被占用会自动顺延），JOIN_BASE 随之更新
let JOIN_BASE = `http://${LAN_IP}:${PORT}`;

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// 生产环境优先用 BASE_URL 环境变量（如 Render 部署时设置），
// 其次用请求的 host 头（支持代理/CDN），回退到 LAN IP
function getJoinBase(req) {
  if (process.env.BASE_URL) return cleanBaseUrl(process.env.BASE_URL);
  if (req) {
    const headers = req.headers || (req.handshake && req.handshake.headers) || {};
    const protoHeader = headers['x-forwarded-proto'] || req.protocol || 'http';
    const hostHeader = headers['x-forwarded-host'] || headers.host || `localhost:${PORT}`;
    const proto = String(Array.isArray(protoHeader) ? protoHeader[0] : protoHeader).split(',')[0].trim();
    const host = String(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader).split(',')[0].trim();
    return cleanBaseUrl(`${proto || 'http'}://${host}`);
  }
  return JOIN_BASE;
}

// 亮数阶段自动推进：到点替房主点「继续」，无需房主手动操作
const REVEAL_AUTO_MS = 8 * 1000;        // 普通结算：看一眼就走
const REVEAL_AUTO_MS_TOKEN = 15 * 1000; // 本轮有人可用免酒令牌：留足决定时间
const revealTimers = new Map();         // roomCode -> setTimeout 句柄

function clearRevealTimer(roomCode) {
  const t = revealTimers.get(roomCode);
  if (t) { clearTimeout(t); revealTimers.delete(roomCode); }
  const game = rooms.get(roomCode);
  if (game) game.revealDeadline = null;
}

// 根据房间当前阶段，确保亮数阶段有且仅有一个自动推进定时器
function syncRevealTimer(roomCode) {
  const game = rooms.get(roomCode);
  if (!game || game.phase !== 'reveal') { clearRevealTimer(roomCode); return; }
  if (revealTimers.has(roomCode)) return; // 本次亮数已安排
  const r = game.lastResult;
  const hasToken = !!(r && r.eligibleTokenIds && r.eligibleTokenIds.length);
  const delay = hasToken ? REVEAL_AUTO_MS_TOKEN : REVEAL_AUTO_MS;
  game.revealDeadline = Date.now() + delay;
  const t = setTimeout(() => {
    revealTimers.delete(roomCode);
    const g = rooms.get(roomCode);
    if (!g || g.phase !== 'reveal') return;
    g.proceed(g.hostId); // 替房主推进
    syncRevealTimer(roomCode);
    broadcast(roomCode);
  }, delay);
  revealTimers.set(roomCode, t);
}

// 复活选人阶段自动随机：10 秒内未达成有效复活则系统随机复活一名
const REVIVAL_AUTO_MS = 10 * 1000;
const revivalTimers = new Map(); // roomCode -> setTimeout 句柄

function clearRevivalTimer(roomCode) {
  const t = revivalTimers.get(roomCode);
  if (t) { clearTimeout(t); revivalTimers.delete(roomCode); }
  const game = rooms.get(roomCode);
  if (game) game.revivalDeadline = null;
}

function syncRevivalTimer(roomCode) {
  const game = rooms.get(roomCode);
  if (!game || game.phase !== 'revival_select') { clearRevivalTimer(roomCode); return; }
  if (revivalTimers.has(roomCode)) return; // 本次选人已安排
  game.revivalDeadline = Date.now() + REVIVAL_AUTO_MS;
  const t = setTimeout(() => {
    revivalTimers.delete(roomCode);
    const g = rooms.get(roomCode);
    if (!g || g.phase !== 'revival_select') return;
    g.revivalTimeout(); // 到点强制随机复活
    syncRevivalTimer(roomCode);
    broadcast(roomCode);
  }, REVIVAL_AUTO_MS);
  revivalTimers.set(roomCode, t);
}

// 给房间内每个 socket 推送各自裁剪后的状态
function broadcast(roomCode) {
  const game = rooms.get(roomCode);
  if (!game) return;
  game.maybeReassignHost();
  for (const [, sock] of io.sockets.adapter.rooms.get(roomCode)
    ? [...io.sockets.adapter.rooms.get(roomCode)].map(sid => [sid, io.sockets.sockets.get(sid)])
    : []) {
    if (!sock) continue;
    const pid = sock.data.playerId;
    sock.emit('state', game.publicState(pid));
  }
}

// 提供加入二维码（dataURL）
app.get('/qr/:code', async (req, res) => {
  const base = getJoinBase(req);
  const url = `${base}/?room=${encodeURIComponent(req.params.code)}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320,
      color: { dark: '#2b2b40', light: '#ffffff' } });
    res.json({ url, dataUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

io.on('connection', (socket) => {
  // 创建房间
  socket.on('create', ({ name, playerId }, cb) => {
    const roomCode = genRoomCode();
    const game = new Game(roomCode);
    rooms.set(roomCode, game);
    game.addPlayer(playerId, name);
    socket.data = { roomCode, playerId };
    socket.join(roomCode);
    const joinUrl = `${getJoinBase(socket)}/?room=${roomCode}`;
    cb && cb({ ok: true, roomCode, joinUrl });
    broadcast(roomCode);
  });

  // 加入房间
  socket.on('join', ({ roomCode, name, playerId }, cb) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const game = rooms.get(roomCode);
    if (!game) return cb && cb({ ok: false, msg: '房间不存在' });
    clearLobbyTimer(roomCode, playerId); // 该玩家重连/加入成功，撤销大厅待移除定时器
    const existing = game.players.get(playerId);
    if (!existing && game.phase !== 'lobby') {
      return cb && cb({ ok: false, msg: '游戏已开始，无法中途加入' });
    }
    if (!existing && game.players.size >= 20) {
      return cb && cb({ ok: false, msg: '房间已满（20人）' });
    }
    game.addPlayer(playerId, name);
    socket.data = { roomCode, playerId };
    socket.join(roomCode);
    const joinUrl = `${getJoinBase(socket)}/?room=${roomCode}`;
    cb && cb({ ok: true, roomCode, joinUrl });
    broadcast(roomCode);
  });

  // 统一的游戏动作通道
  socket.on('game', ({ action, payload }, cb) => {
    const { roomCode, playerId } = socket.data || {};
    const game = rooms.get(roomCode);
    if (!game) return cb && cb({ ok: false, msg: '房间不存在' });
    game.maybeReassignHost();
    let res = { ok: true };
    switch (action) {
      case 'start':        res = game.startGame(playerId, payload && payload.tutorial); break;
      case 'pick':         res = game.submitPick(playerId, payload.value); break;
      case 'consent':      res = game.submitConsent(playerId, payload.choice); break;
      case 'endgamePick':  res = game.submitEndgamePick(playerId, payload.value); break;
      case 'revivalPick':  res = game.submitRevivalPick(playerId, payload.targetId); break;
      case 'revivalRandom':res = game.submitRevivalRandom(playerId); break;
      case 'revivalDecide':res = game.submitRevivalDecision(playerId, payload.choice); break;
      case 'finalPick':    res = game.submitFinalPick(playerId, payload.value); break;
      case 'toggleToken':  res = game.toggleToken(playerId, payload.use); break;
      case 'proceed':      res = game.proceed(playerId); break;
      case 'restart':      res = game.restart(playerId); break;
      case 'removeOffline':res = game.removeOffline(playerId, payload.targetId); break;
      case 'rename':
        { const p = game.players.get(playerId); if (p && payload.name) p.name = String(payload.name).slice(0, 8); }
        break;
      case 'kick':
        if (playerId === game.hostId && game.phase === 'lobby') game.removePlayer(payload.targetId);
        break;
      default: res = { ok: false, msg: '未知操作' };
    }
    cb && cb(res);
    syncRevealTimer(roomCode);  // 进入亮数则起倒计时，离开则清除（含房主手动「继续」）
    syncRevivalTimer(roomCode); // 进入复活选人则起 10 秒倒计时，离开则清除
    broadcast(roomCode);
  });

  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode) return;
    const game = rooms.get(roomCode);
    if (!game) return;
    // 同一玩家已用新连接重连（刷新/多开）：忽略这次旧连接断开，避免把刚回来的人误删
    if (hasOtherLiveSocket(roomCode, playerId, socket.id)) return;
    game.setConnected(playerId, false);
    if (game.phase === 'lobby') {
      // 大厅：先保留座位，给 LOBBY_GRACE_MS 的重连机会；过期仍未回来才真正移除
      clearLobbyTimer(roomCode, playerId);
      const key = roomCode + ':' + playerId;
      lobbyKickTimers.set(key, setTimeout(() => {
        lobbyKickTimers.delete(key);
        const g = rooms.get(roomCode);
        if (!g) return;
        const p = g.players.get(playerId);
        if (g.phase === 'lobby' && p && !p.connected) {
          g.removePlayer(playerId);
          broadcast(roomCode);
        }
      }, LOBBY_GRACE_MS));
    }
    // 房间空了就回收
    const allGone = [...game.players.values()].every(p => !p.connected);
    if (game.players.size === 0 || allGone) {
      setTimeout(() => {
        const g = rooms.get(roomCode);
        if (g && [...g.players.values()].every(p => !p.connected)) {
          clearRevealTimer(roomCode);
          clearRevivalTimer(roomCode);
          rooms.delete(roomCode);
        }
      }, 1000 * 60 * 10); // 10 分钟无人则回收
    }
    broadcast(roomCode);
  });
});

// 启动监听；端口被占用时自动顺延到下一个端口
function startListen(port, attemptsLeft) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  端口 ${port} 被占用，尝试 ${port + 1} ...`);
      setTimeout(() => startListen(port + 1, attemptsLeft - 1), 150);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  };
  const onListening = async () => {
    server.removeListener('error', onError);
    JOIN_BASE = `http://${LAN_IP}:${port}`;
    let qrText = '';
    try { qrText = await QRCode.toString(`${JOIN_BASE}`, { type: 'terminal', small: true }); } catch {}
    console.log('\n========================================');
    console.log('  🍻 数字淘汰 · 卡通版 已启动');
    console.log('========================================');
    console.log(`  本机访问：  http://localhost:${port}`);
    console.log(`  同一WiFi下手机访问： ${JOIN_BASE}`);
    console.log('  （房主在手机/电脑打开上面网址 → 创建房间 → 其他人扫码加入）');
    if (qrText) { console.log('\n  手机扫码直接打开：\n'); console.log(qrText); }
    console.log('========================================\n');
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '0.0.0.0');
}
startListen(PORT, 10);
