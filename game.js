'use strict';
/*
 * game.js —— 《数字淘汰》v5 纯游戏逻辑 / 状态机
 * 不依赖网络层，便于单元测试。server.js 负责把 socket 事件翻译成对这些方法的调用。
 *
 * 规则要点（对应文档 v5 最多20人版）：
 *  - 每小轮各报 1..当前人数 的整数，同时亮出。
 *  - 第1步 撞车作废：被≥2人报的数字作废，这些人喝当轮基础罚酒，留场。
 *  - 第2步 动态放生：未撞车数字里，从小到大放生若干名（通关出局）。
 *  - 第3步 安然令牌：放生后，留场玩家中“最大独有数字”者得 1 枚令牌。
 *  - 第4步 全员撞车：无人独有则全员喝基础罚酒，原地重报（小轮序号不变、不发令牌）。
 *  - 罚酒递增：第1-2小轮1口，第3-4小轮2口，第5小轮起3口（1杯）封顶。
 *  - 终局(剩2人) 斗鸡博弈；2,2 触发复活；复活接受则三人最终局。
 *  - 安然令牌：每个结算阶段每人至多用1枚，抵 1 杯（3口）。
 */

const SIP_PER_CUP = 3; // 3 口 = 1 杯

// 放生阶梯：当前人数 → 本轮放生名额
const RELEASE_LADDER = [
  { min: 17, max: 20, release: 5 },
  { min: 13, max: 16, release: 4 },
  { min: 9,  max: 12, release: 3 },
  { min: 7,  max: 8,  release: 2 },
  { min: 3,  max: 6,  release: 1 },
];

function releaseCountFor(n) {
  for (const row of RELEASE_LADDER) {
    if (n >= row.min && n <= row.max) return row.release;
  }
  return 0; // n <= 2 由终局逻辑单独处理
}

// 常规小轮撞车基础罚酒（口），按小轮序号递增，3 口封顶
function basePenaltyFor(subRound) {
  if (subRound <= 2) return 1;
  if (subRound <= 4) return 2;
  return 3;
}

// 卡通头像池
const AVATARS = [
  '🦊','🐼','🐯','🐸','🐵','🦁','🐶','🐱','🐰','🐻',
  '🐨','🐷','🐔','🦄','🐙','🦖','🐢','🦉','🐝','🐳',
];

const PHASE = {
  LOBBY: 'lobby',
  COLLECT: 'collect',                 // 常规小轮出数
  REVEAL: 'reveal',                   // 亮数 / 结算（含令牌声明窗口）
  ENDGAME_CONSENT: 'endgame_consent', // 终局：双方是否同意开战
  ENDGAME_COLLECT: 'endgame_collect', // 终局：报 1/2
  REVIVAL_SELECT: 'revival_select',   // 复活：两人共同指定
  REVIVAL_DECIDE: 'revival_decide',   // 复活：被邀者决定
  FINAL_COLLECT: 'final_collect',     // 最终局：三人报 1-3
  GAMEOVER: 'gameover',
};

let _avatarCursor = 0;

class Game {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.phase = PHASE.LOBBY;
    this.players = new Map(); // id -> player
    this.hostId = null;
    this.subRound = 1;
    this.lastResult = null;   // 见 _makeResult
    this.log = [];            // 文字事件流（最新在后）
    this.invitedId = null;    // 复活被邀者
    this.revivalProposals = {}; // 终局两人各自提名
    this.tutorialMode = false; // 新手教学模式（开局由房主决定）
    this.createdAt = Date.now();
  }

  // 房主掉线时迁移给任一在线玩家，避免卡住
  maybeReassignHost() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const online = [...this.players.values()].find(p => p.connected);
    if (online) this.hostId = online.id;
  }

  // 重开一局（保留玩家与昵称/头像，清空战绩）
  restart(byId) {
    if (byId !== this.hostId) return { ok: false, msg: '只有房主能重开' };
    this.phase = PHASE.LOBBY;
    this.subRound = 1;
    this.lastResult = null;
    this.invitedId = null;
    this.revivalProposals = {};
    this.log = [];
    for (const p of this.players.values()) {
      p.alive = false; p.escaped = false; p.tokens = 0; p.drinks = 0;
      p.pick = null; p.consent = null; p.finishRank = null;
    }
    return { ok: true };
  }

  // ---------- 玩家管理 ----------
  addPlayer(id, name) {
    if (this.players.has(id)) { // 重连
      this.players.get(id).connected = true;
      return this.players.get(id);
    }
    const avatar = AVATARS[_avatarCursor % AVATARS.length];
    _avatarCursor++;
    const p = {
      id,
      name: (name || '玩家').slice(0, 8),
      avatar,
      connected: true,
      alive: false,     // 是否在场上
      escaped: false,    // 是否已通关放生
      tokens: 0,         // 安然令牌数
      drinks: 0,         // 累计口数
      pick: null,        // 本轮出数（仅服务端可见，亮数时才公开）
      consent: null,     // 终局同意/拒绝
      finishRank: null,  // 通关名次（越小越早通关）
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    return p;
  }

  setConnected(id, val) {
    const p = this.players.get(id);
    if (p) p.connected = val;
  }

  removePlayer(id) {
    // 仅大厅阶段允许真正移除；游戏中只标记掉线，保留位置
    if (this.phase === PHASE.LOBBY) {
      this.players.delete(id);
      if (this.hostId === id) {
        const first = this.players.keys().next();
        this.hostId = first.done ? null : first.value;
      }
    } else {
      this.setConnected(id, false);
    }
  }

  alivePlayers() {
    return [...this.players.values()].filter(p => p.alive);
  }

  escapedPlayers() {
    return [...this.players.values()].filter(p => p.escaped);
  }

  fieldSize() {
    return this.alivePlayers().length;
  }

  // ---------- 开局 ----------
  startGame(byId, tutorialMode = false) {
    if (this.phase !== PHASE.LOBBY) return { ok: false, msg: '游戏已开始' };
    if (byId !== this.hostId) return { ok: false, msg: '只有房主能开始' };
    const ps = [...this.players.values()];
    if (ps.length < 3) return { ok: false, msg: '至少需要 3 人' };
    if (ps.length > 20) return { ok: false, msg: '最多 20 人' };
    this.tutorialMode = !!tutorialMode;
    for (const p of ps) {
      p.alive = true; p.escaped = false; p.tokens = 0; p.drinks = 0;
      p.pick = null; p.consent = null; p.finishRank = null;
    }
    this.subRound = 1;
    this.phase = PHASE.COLLECT;
    this.log = [];
    this._log(`🎮 游戏开始！共 ${ps.length} 人，报数范围 1-${ps.length}`);
    return { ok: true };
  }

  // ---------- 出数（常规小轮） ----------
  submitPick(id, value) {
    if (this.phase !== PHASE.COLLECT) return { ok: false };
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false };
    const n = this.fieldSize();
    value = Number(value);
    if (!Number.isInteger(value) || value < 1 || value > n) return { ok: false, msg: `请报 1-${n}` };
    p.pick = value;
    if (this.alivePlayers().every(pl => pl.pick != null)) this._resolveNormal();
    return { ok: true };
  }

  _resolveNormal() {
    const alive = this.alivePlayers();
    const n = alive.length;
    const counts = new Map();
    for (const p of alive) counts.set(p.pick, (counts.get(p.pick) || 0) + 1);

    const collidedNumbers = [...counts.entries()].filter(([, c]) => c >= 2).map(([v]) => v);
    const uniquePlayers = alive.filter(p => counts.get(p.pick) === 1)
      .sort((a, b) => a.pick - b.pick);
    const collidedPlayers = alive.filter(p => counts.get(p.pick) >= 2);
    const base = basePenaltyFor(this.subRound);

    // 第4步 全员撞车：无人独有
    if (uniquePlayers.length === 0) {
      const drinks = {};
      for (const p of alive) drinks[p.id] = base;
      this.lastResult = this._makeResult('all_collide', {
        collidedNumbers, releasedIds: [], tokenWinnerId: null, drinks,
        note: `全员撞车！各喝 ${base} 口，原地重报第 ${this.subRound} 小轮`,
      });
      this.phase = PHASE.REVEAL;
      return;
    }

    // 第2步 动态放生
    const releaseN = Math.min(releaseCountFor(n), uniquePlayers.length);
    const released = uniquePlayers.slice(0, releaseN);
    const remainingUnique = uniquePlayers.slice(releaseN);

    // 第3步 安然令牌：留场玩家中最大独有数字
    let tokenWinnerId = null;
    if (remainingUnique.length > 0) {
      tokenWinnerId = remainingUnique.reduce((a, b) => (b.pick > a.pick ? b : a)).id;
    }

    // 第1步 撞车罚酒
    const drinks = {};
    for (const p of collidedPlayers) drinks[p.id] = base;

    this.lastResult = this._makeResult('normal', {
      collidedNumbers,
      releasedIds: released.map(p => p.id),
      tokenWinnerId,
      drinks,
      note: this._normalNote(collidedPlayers, released, tokenWinnerId, base),
    });
    this.phase = PHASE.REVEAL;
  }

  _normalNote(collided, released, tokenWinnerId, base) {
    const parts = [];
    if (collided.length) parts.push(`${collided.length} 人撞车各喝 ${base} 口`);
    if (released.length) parts.push(`放生 ${released.map(p => p.name).join('、')}（通关）`);
    if (tokenWinnerId) parts.push(`${this.players.get(tokenWinnerId).name} 抢到安然令牌🛡️`);
    return parts.join('；') || '本轮无事发生';
  }

  // ---------- 终局：同意/拒绝 ----------
  submitConsent(id, choice) {
    if (this.phase !== PHASE.ENDGAME_CONSENT) return { ok: false };
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false };
    p.consent = choice === 'agree' ? 'agree' : 'refuse';
    const two = this.alivePlayers();
    if (two.every(pl => pl.consent != null)) {
      if (two.some(pl => pl.consent === 'refuse')) {
        // 任一拒绝：双方各喝 2 杯（6 口）
        const drinks = {};
        for (const pl of two) drinks[pl.id] = 2 * SIP_PER_CUP;
        this.lastResult = this._makeResult('endgame_refuse', {
          collidedNumbers: [], releasedIds: [], tokenWinnerId: null, drinks,
          note: '有人拒绝对决，双方各喝 2 杯（6口）',
          terminal: true,
        });
        this.phase = PHASE.REVEAL;
      } else {
        for (const pl of two) pl.pick = null;
        this.phase = PHASE.ENDGAME_COLLECT;
        this._log('⚔️ 双方同意开战！各报 1 或 2');
      }
    }
    return { ok: true };
  }

  // ---------- 终局：报 1/2 ----------
  submitEndgamePick(id, value) {
    if (this.phase !== PHASE.ENDGAME_COLLECT) return { ok: false };
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false };
    value = Number(value);
    if (value !== 1 && value !== 2) return { ok: false, msg: '只能报 1 或 2' };
    p.pick = value;
    const two = this.alivePlayers();
    if (two.every(pl => pl.pick != null)) this._resolveEndgame(two);
    return { ok: true };
  }

  _resolveEndgame(two) {
    const [a, b] = two;
    if (a.pick === 1 && b.pick === 1) {
      // 1,1 同抢小数，双输双倍：各 12 口（4 杯）
      const drinks = { [a.id]: 4 * SIP_PER_CUP, [b.id]: 4 * SIP_PER_CUP };
      this.lastResult = this._makeResult('endgame_result', {
        collidedNumbers: [1], releasedIds: [], tokenWinnerId: null, drinks,
        note: '1、1 同抢小数撞死，并列最大输家，各喝 4 杯（12口）',
        terminal: true,
      });
      this.phase = PHASE.REVEAL;
    } else if (a.pick === 2 && b.pick === 2) {
      // 2,2 触发复活
      this.revivalProposals = {};
      const candidates = this.escapedPlayers();
      if (candidates.length === 0) {
        // 兜底：无人可复活，双方各喝 2 杯收场
        const drinks = { [a.id]: 2 * SIP_PER_CUP, [b.id]: 2 * SIP_PER_CUP };
        this.lastResult = this._makeResult('endgame_result', {
          collidedNumbers: [2], releasedIds: [], tokenWinnerId: null, drinks,
          note: '2、2 触发复活，但无人可邀请，双方各喝 2 杯收场',
          terminal: true,
        });
        this.phase = PHASE.REVEAL;
      } else {
        this.phase = PHASE.REVIVAL_SELECT;
        this._log('🔮 双双报 2，触发复活！两位终局玩家请协商邀请一名已通关玩家');
      }
    } else {
      // 1,2 报 2 者落败
      const loser = a.pick === 2 ? a : b;
      const winner = a.pick === 2 ? b : a;
      const drinks = { [loser.id]: 2 * SIP_PER_CUP };
      winner.escaped = true; winner.alive = false; winner.finishRank = this._nextRank();
      this.lastResult = this._makeResult('endgame_result', {
        collidedNumbers: [], releasedIds: [], tokenWinnerId: null, drinks,
        note: `${loser.name} 贪大报 2 落败，喝 2 杯（6口）；${winner.name} 抢 1 逃生获胜🏆`,
        terminal: true,
      });
      this.phase = PHASE.REVEAL;
    }
  }

  // ---------- 复活：两人共同指定 ----------
  submitRevivalPick(id, targetId) {
    if (this.phase !== PHASE.REVIVAL_SELECT) return { ok: false };
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false };
    const target = this.players.get(targetId);
    if (!target || !target.escaped) return { ok: false, msg: '只能邀请已通关玩家' };
    this.revivalProposals[id] = targetId;
    const two = this.alivePlayers();
    const picks = two.map(pl => this.revivalProposals[pl.id]);
    if (picks.every(x => x != null)) {
      if (picks[0] === picks[1]) {
        this.invitedId = picks[0];
        this.phase = PHASE.REVIVAL_DECIDE;
        this._log(`📨 邀请 ${this.players.get(this.invitedId).name} 回归，等待其决定`);
      } else {
        // 不一致，重置重选
        this.revivalProposals = {};
        return { ok: true, msg: '两人提名不一致，请重新协商' };
      }
    }
    return { ok: true };
  }

  // ---------- 复活：被邀者决定 ----------
  submitRevivalDecision(id, choice) {
    if (this.phase !== PHASE.REVIVAL_DECIDE) return { ok: false };
    if (id !== this.invitedId) return { ok: false };
    const invitee = this.players.get(id);
    const two = this.alivePlayers();
    if (choice === 'accept') {
      invitee.tokens += 1;       // 正式安然令牌
      invitee.escaped = false;
      invitee.alive = true;
      invitee.finishRank = null;
      for (const pl of this.alivePlayers()) pl.pick = null;
      this.phase = PHASE.FINAL_COLLECT;
      this._log(`✅ ${invitee.name} 接受复活，获得 1 枚安然令牌，三人进入最终局！各报 1-3`);
    } else {
      // 拒绝：被邀者 + 两名终局玩家各喝 1 杯（3口）
      const drinks = {};
      drinks[invitee.id] = SIP_PER_CUP;
      for (const pl of two) drinks[pl.id] = SIP_PER_CUP;
      this.lastResult = this._makeResult('revival_refuse', {
        collidedNumbers: [], releasedIds: [], tokenWinnerId: null, drinks,
        note: `${invitee.name} 拒绝复活，三人各喝 1 杯（3口）收场`,
        terminal: true,
      });
      this.phase = PHASE.REVEAL;
    }
    return { ok: true };
  }

  // ---------- 最终局：三人报 1-3 ----------
  submitFinalPick(id, value) {
    if (this.phase !== PHASE.FINAL_COLLECT) return { ok: false };
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false };
    value = Number(value);
    if (![1, 2, 3].includes(value)) return { ok: false, msg: '只能报 1-3' };
    p.pick = value;
    const three = this.alivePlayers();
    if (three.every(pl => pl.pick != null)) this._resolveFinal(three);
    return { ok: true };
  }

  _resolveFinal(three) {
    const counts = new Map();
    for (const p of three) counts.set(p.pick, (counts.get(p.pick) || 0) + 1);
    const collidedNumbers = [...counts.entries()].filter(([, c]) => c >= 2).map(([v]) => v);
    const unique = three.filter(p => counts.get(p.pick) === 1).sort((a, b) => a.pick - b.pick);

    const drinks = {};
    let note;
    if (unique.length > 0) {
      const winner = unique[0]; // 最小独有数字逃脱
      winner.escaped = true; winner.alive = false; winner.finishRank = this._nextRank();
      for (const p of three) if (p.id !== winner.id) drinks[p.id] = 2 * SIP_PER_CUP;
      note = `${winner.name} 报最小独有数字 ${winner.pick} 逃脱🏆，其余两人各喝 2 杯（6口）垫底`;
    } else {
      for (const p of three) drinks[p.id] = 2 * SIP_PER_CUP;
      note = '无人独有，三人一起垫底，各喝 2 杯（6口）';
    }
    this.lastResult = this._makeResult('final_result', {
      collidedNumbers, releasedIds: [], tokenWinnerId: null, drinks,
      note, terminal: true,
    });
    this.phase = PHASE.REVEAL;
  }

  // ---------- 令牌声明（reveal 窗口内） ----------
  toggleToken(id, use) {
    if (this.phase !== PHASE.REVEAL || !this.lastResult) return { ok: false };
    const r = this.lastResult;
    if (!r.eligibleTokenIds.includes(id)) return { ok: false, msg: '你没有可用令牌' };
    r.tokenUse[id] = !!use;
    return { ok: true };
  }

  // ---------- 继续（房主推进 reveal） ----------
  proceed(byId) {
    if (this.phase !== PHASE.REVEAL) return { ok: false };
    if (byId !== this.hostId) return { ok: false, msg: '等房主点继续' };
    const r = this.lastResult;

    // 应用令牌抵酒（每人至多 1 枚，抵 1 杯）
    for (const pid of r.eligibleTokenIds) {
      if (r.tokenUse[pid]) {
        const p = this.players.get(pid);
        if (p && p.tokens > 0) {
          p.tokens -= 1;
          r.finalDrinks[pid] = Math.max(0, r.drinks[pid] - SIP_PER_CUP);
        }
      }
    }
    // 落账
    for (const [pid, amt] of Object.entries(r.finalDrinks)) {
      const p = this.players.get(pid);
      if (p) p.drinks += amt;
    }
    // 发放本轮令牌
    if (r.tokenWinnerId) {
      const w = this.players.get(r.tokenWinnerId);
      if (w) w.tokens += 1;
    }
    // 放生落地
    for (const pid of r.releasedIds) {
      const p = this.players.get(pid);
      if (p) { p.escaped = true; p.alive = false; p.finishRank = this._nextRank(); }
    }

    this._log(r.note);

    // 阶段流转
    if (r.terminal) { this._toGameOver(false); return { ok: true }; } // 终局/最终局垫底者不算通关

    if (r.type === 'all_collide') {
      for (const p of this.alivePlayers()) p.pick = null; // 同一小轮原地重报
      this.phase = PHASE.COLLECT;
      return { ok: true };
    }

    // 常规小轮结束
    const size = this.fieldSize();
    if (size <= 1) { this._toGameOver(true); return { ok: true }; } // 独自笑到最后＝通关
    if (size === 2) {
      for (const p of this.alivePlayers()) { p.pick = null; p.consent = null; }
      this.phase = PHASE.ENDGAME_CONSENT;
      this._log('🐔 只剩 2 人，进入终局斗鸡博弈，双方先表态是否开战');
      return { ok: true };
    }
    this.subRound += 1;
    for (const p of this.alivePlayers()) p.pick = null;
    this.phase = PHASE.COLLECT;
    return { ok: true };
  }

  _toGameOver(markEscaped) {
    // markEscaped=true：剩余在场玩家算通关（独自笑到最后）
    // markEscaped=false：终局/最终局结束，留场的都是垫底输家，不标通关
    for (const p of this.alivePlayers()) {
      if (markEscaped) p.escaped = true;
      p.alive = false;
      if (p.finishRank == null) p.finishRank = this._nextRank();
    }
    this.phase = PHASE.GAMEOVER;
    this._log('🏁 本局结束！');
  }

  _nextRank() {
    const ranks = [...this.players.values()].map(p => p.finishRank).filter(x => x != null);
    return ranks.length ? Math.max(...ranks) + 1 : 1;
  }

  // ---------- 结果对象构造 ----------
  _makeResult(type, { collidedNumbers, releasedIds, tokenWinnerId, drinks, note, terminal = false }) {
    const picks = {};
    for (const p of this.players.values()) if (p.pick != null) picks[p.id] = p.pick;
    // 可用令牌者 = 本次需喝酒且持有令牌的玩家
    const eligibleTokenIds = Object.keys(drinks).filter(pid => {
      const p = this.players.get(pid);
      return p && p.tokens > 0 && drinks[pid] > 0;
    });
    const finalDrinks = { ...drinks };
    return {
      type, picks, collidedNumbers, releasedIds, tokenWinnerId,
      drinks, finalDrinks, eligibleTokenIds, tokenUse: {}, note, terminal,
      subRound: this.subRound,
    };
  }

  _log(msg) { this.log.push(msg); if (this.log.length > 60) this.log.shift(); }

  // ---------- 给客户端的可见状态（按玩家裁剪） ----------
  publicState(forId) {
    const n = this.fieldSize();
    const range =
      this.phase === PHASE.ENDGAME_COLLECT ? 2 :
      this.phase === PHASE.FINAL_COLLECT ? 3 :
      this.phase === PHASE.COLLECT ? n : 0;

    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar,
      connected: p.connected, alive: p.alive, escaped: p.escaped,
      tokens: p.tokens, drinks: p.drinks, finishRank: p.finishRank,
      isHost: p.id === this.hostId,
      hasPicked: p.pick != null,          // 出数阶段只暴露“是否已出”
      consent: this.phase === PHASE.ENDGAME_CONSENT ? (p.consent != null) : undefined,
    }));

    const me = this.players.get(forId);
    const state = {
      roomCode: this.roomCode,
      phase: this.phase,
      hostId: this.hostId,
      tutorialMode: this.tutorialMode,
      youAreHost: forId === this.hostId,
      subRound: this.subRound,
      fieldSize: n,
      range,
      basePenalty: basePenaltyFor(this.subRound),
      players,
      log: this.log.slice(-12),
      you: me ? {
        id: me.id, alive: me.alive, escaped: me.escaped,
        tokens: me.tokens, drinks: me.drinks,
        pick: me.pick, consent: me.consent,
      } : null,
      invitedId: this.invitedId,
    };

    if (this.phase === PHASE.REVEAL && this.lastResult) {
      const r = this.lastResult;
      state.reveal = {
        type: r.type,
        picks: r.picks,
        collidedNumbers: r.collidedNumbers,
        releasedIds: r.releasedIds,
        tokenWinnerId: r.tokenWinnerId,
        drinks: r.drinks,
        finalDrinks: r.finalDrinks,
        eligibleTokenIds: r.eligibleTokenIds,
        tokenUse: r.tokenUse,
        note: r.note,
        youEligible: r.eligibleTokenIds.includes(forId),
        youUsingToken: !!r.tokenUse[forId],
      };
    }
    return state;
  }
}

module.exports = {
  Game, PHASE, SIP_PER_CUP, RELEASE_LADDER,
  releaseCountFor, basePenaltyFor, AVATARS,
};
