'use strict';
/* 简易自测：node test/game.test.js */
const assert = require('assert');
const { Game, releaseCountFor, basePenaltyFor } = require('../game');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// 让一组玩家加入并开局
function makeGame(n) {
  const g = new Game('TEST');
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, '玩家' + i);
  g.startGame('p0');
  return g;
}
function pickAll(g, picks) { // picks: {p0:1,...}
  for (const [id, v] of Object.entries(picks)) g.submitPick(id, v);
}

console.log('放生阶梯 / 罚酒：');
t('放生名额', () => {
  assert.equal(releaseCountFor(20), 5);
  assert.equal(releaseCountFor(13), 4);
  assert.equal(releaseCountFor(12), 3);
  assert.equal(releaseCountFor(8), 2);
  assert.equal(releaseCountFor(6), 1);
  assert.equal(releaseCountFor(3), 1);
  assert.equal(releaseCountFor(2), 0);
});
t('罚酒递增 3 口封顶', () => {
  assert.equal(basePenaltyFor(1), 1);
  assert.equal(basePenaltyFor(2), 1);
  assert.equal(basePenaltyFor(3), 2);
  assert.equal(basePenaltyFor(4), 2);
  assert.equal(basePenaltyFor(5), 3);
  assert.equal(basePenaltyFor(99), 3);
});

console.log('常规小轮：');
t('5人：撞车作废 + 放生最小1名 + 最大独有得令牌', () => {
  const g = makeGame(5);
  // 出数：p0=1, p1=1(撞车), p2=2, p3=3, p4=4
  pickAll(g, { p0: 1, p1: 1, p2: 2, p3: 3, p4: 4 });
  assert.equal(g.phase, 'reveal');
  const r = g.lastResult;
  assert.deepEqual(r.collidedNumbers, [1]);
  // 未撞车独有：2(p2),3(p3),4(p4)；放生最小1名 → p2
  assert.deepEqual(r.releasedIds, ['p2']);
  // 留场独有最大 → p4 得令牌
  assert.equal(r.tokenWinnerId, 'p4');
  // 撞车的 p0,p1 各喝 1 口（第1小轮）
  assert.equal(r.drinks.p0, 1);
  assert.equal(r.drinks.p1, 1);
  // 推进
  g.proceed('p0');
  assert.equal(g.players.get('p2').escaped, true);
  assert.equal(g.players.get('p4').tokens, 1);
  assert.equal(g.players.get('p0').drinks, 1);
  assert.equal(g.fieldSize(), 4);
  assert.equal(g.subRound, 2);
});

t('全员撞车：各喝基础罚酒，原地重报，小轮不变，不发令牌', () => {
  const g = makeGame(4);
  pickAll(g, { p0: 1, p1: 1, p2: 2, p3: 2 });
  const r = g.lastResult;
  assert.equal(r.type, 'all_collide');
  assert.equal(r.tokenWinnerId, null);
  Object.values(r.drinks).forEach(d => assert.equal(d, 1));
  g.proceed('p0');
  assert.equal(g.phase, 'collect');
  assert.equal(g.subRound, 1); // 不变
  assert.equal(g.fieldSize(), 4); // 无人出局
});

t('放生不足额：独有数不够时有几个放几个', () => {
  const g = makeGame(9); // 放生名额 3
  // 让只有 1 个独有：8人报1(撞),1人报2(独有)
  pickAll(g, { p0:1,p1:1,p2:1,p3:1,p4:1,p5:1,p6:1,p7:1,p8:2 });
  const r = g.lastResult;
  assert.equal(r.releasedIds.length, 1); // 只放 1 个
  assert.equal(r.releasedIds[0], 'p8');
});

t('令牌抵酒：撞车者用令牌抵 1 杯(3口)', () => {
  const g = makeGame(6);
  // 先制造令牌给 p5：第1轮 p5 报最大独有
  // p0=1,p1=1(撞),p2=2,p3=3,p4=4,p5=5 → 放生最小1名 p2，独有最大 p5 得令牌
  pickAll(g, { p0:1,p1:1,p2:2,p3:3,p4:4,p5:5 });
  g.proceed('p0');
  assert.equal(g.players.get('p5').tokens, 1);
  // 现在 5 人，制造让 p5 撞车并用令牌
  // 注意第2小轮基础罚酒仍 1 口，令牌抵 3 口 → 实付 0
  const alive = g.alivePlayers().map(p=>p.id); // p0,p1,p3,p4,p5
  // 让 p5 与某人撞 1，其余独有
  const m = {}; m[alive[0]]=1; m[alive[1]]=1; m[alive[2]]=2; m[alive[3]]=3; m[alive[4]]=4;
  // 确保 p5 在撞车组：把 p5 设为报1
  // 重新构造：p5 报 1，和另一人撞
  const ids = alive;
  const picks2 = {};
  picks2['p5'] = 1; picks2[ids.find(x=>x!=='p5')] = 1; // 撞
  const rest = ids.filter(x => !(x==='p5') && picks2[x]==null);
  let v = 2; for (const id of rest) picks2[id] = v++;
  pickAll(g, picks2);
  const r = g.lastResult;
  assert.ok(r.eligibleTokenIds.includes('p5'), 'p5 应可用令牌');
  g.toggleToken('p5', true);
  const before = g.players.get('p5').drinks;
  g.proceed('p0');
  assert.equal(g.players.get('p5').tokens, 0, '令牌应被消耗');
  assert.equal(g.players.get('p5').drinks, before, 'p5 实付 0 口（1口被3口令牌覆盖）');
});

console.log('终局斗鸡：');
function toEndgame(g) {
  // 把人数放生到 2 人：循环让最小独有逃生
  let guard = 0;
  while (g.fieldSize() > 2 && guard++ < 50) {
    const alive = g.alivePlayers().map(p => p.id);
    const picks = {}; let v = 1;
    for (const id of alive) picks[id] = v++; // 全独有，从小到大
    pickAll(g, picks);
    g.proceed('p0');
  }
  return g;
}

t('终局拒绝：双方各喝 2 杯', () => {
  const g = toEndgame(makeGame(4));
  assert.equal(g.phase, 'endgame_consent');
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'refuse');
  const r = g.lastResult;
  assert.equal(r.type, 'endgame_refuse');
  two.forEach(id => assert.equal(r.drinks[id], 6));
  g.proceed('p0');
  assert.equal(g.phase, 'gameover');
});

t('终局 1,2：报2者喝6口，报1者获胜', () => {
  const g = toEndgame(makeGame(4));
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'agree');
  g.submitEndgamePick(two[0], 1);
  g.submitEndgamePick(two[1], 2);
  const r = g.lastResult;
  assert.equal(r.drinks[two[1]], 6);
  assert.equal(r.drinks[two[0]], undefined);
  g.proceed('p0');
  assert.equal(g.phase, 'gameover');
  assert.equal(g.players.get(two[0]).escaped, true);
});

t('终局 1,1：并列双输各 12 口', () => {
  const g = toEndgame(makeGame(4));
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'agree');
  g.submitEndgamePick(two[0], 1);
  g.submitEndgamePick(two[1], 1);
  const r = g.lastResult;
  two.forEach(id => assert.equal(r.drinks[id], 12));
});

t('终局 2,2 → 复活 → 接受 → 最终局', () => {
  const g = toEndgame(makeGame(4));
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'agree');
  g.submitEndgamePick(two[0], 2);
  g.submitEndgamePick(two[1], 2);
  assert.equal(g.phase, 'revival_select');
  const invited = g.escapedPlayers()[0].id;
  g.submitRevivalPick(two[0], invited);
  g.submitRevivalPick(two[1], invited);
  assert.equal(g.phase, 'revival_decide');
  g.submitRevivalDecision(invited, 'accept');
  assert.equal(g.phase, 'final_collect');
  assert.equal(g.players.get(invited).tokens, 1, '复活得 1 令牌');
  assert.equal(g.fieldSize(), 3);
  // 最终局 1,2,3 → 报1者逃脱
  const three = g.alivePlayers().map(p => p.id);
  g.submitFinalPick(three[0], 1);
  g.submitFinalPick(three[1], 2);
  g.submitFinalPick(three[2], 3);
  const r = g.lastResult;
  assert.equal(r.type, 'final_result');
  assert.equal(r.drinks[three[0]], undefined); // 报1逃脱
  assert.equal(r.drinks[three[1]], 6);
  assert.equal(r.drinks[three[2]], 6);
  g.proceed('p0');
  assert.equal(g.phase, 'gameover');
});

t('复活拒绝：三人各喝 1 杯', () => {
  const g = toEndgame(makeGame(4));
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'agree');
  g.submitEndgamePick(two[0], 2);
  g.submitEndgamePick(two[1], 2);
  const invited = g.escapedPlayers()[0].id;
  g.submitRevivalPick(two[0], invited);
  g.submitRevivalPick(two[1], invited);
  g.submitRevivalDecision(invited, 'refuse');
  const r = g.lastResult;
  assert.equal(r.type, 'revival_refuse');
  assert.equal(r.drinks[invited], 3);
  two.forEach(id => assert.equal(r.drinks[id], 3));
});

t('最终局无独有：三人垫底各 6 口', () => {
  const g = toEndgame(makeGame(4));
  const two = g.alivePlayers().map(p => p.id);
  g.submitConsent(two[0], 'agree');
  g.submitConsent(two[1], 'agree');
  g.submitEndgamePick(two[0], 2);
  g.submitEndgamePick(two[1], 2);
  const invited = g.escapedPlayers()[0].id;
  g.submitRevivalPick(two[0], invited);
  g.submitRevivalPick(two[1], invited);
  g.submitRevivalDecision(invited, 'accept');
  const three = g.alivePlayers().map(p => p.id);
  g.submitFinalPick(three[0], 1);
  g.submitFinalPick(three[1], 1);
  g.submitFinalPick(three[2], 1);
  const r = g.lastResult;
  three.forEach(id => assert.equal(r.drinks[id], 6));
});

console.log('掉线 / 重连：');
t('开局前清掉未重连的掉线玩家', () => {
  const g = new Game('T');
  for (let i = 0; i < 4; i++) g.addPlayer('p' + i, '玩家' + i);
  g.setConnected('p3', false);
  const r = g.startGame('p0');
  assert.equal(r.ok, true);
  assert.equal(g.players.has('p3'), false);
  assert.equal(g.fieldSize(), 3);
});
t('清掉掉线者后不足 3 人则无法开局', () => {
  const g = new Game('T');
  for (let i = 0; i < 3; i++) g.addPlayer('p' + i, '玩家' + i);
  g.setConnected('p1', false);
  g.setConnected('p2', false);
  assert.equal(g.startGame('p0').ok, false);
});
t('大厅房主掉线先保留身份（等重连）', () => {
  const g = new Game('T');
  for (let i = 0; i < 3; i++) g.addPlayer('p' + i, '玩家' + i);
  g.setConnected('p0', false);
  g.maybeReassignHost();
  assert.equal(g.hostId, 'p0');
});
t('游戏中房主掉线仍迁移给在线玩家', () => {
  const g = makeGame(4);
  g.setConnected('p0', false);
  g.maybeReassignHost();
  assert.notEqual(g.hostId, 'p0');
  assert.equal(g.players.get(g.hostId).connected, true);
});
t('重连保留座位/酒数（addPlayer 幂等）', () => {
  const g = makeGame(4);
  g.players.get('p1').drinks = 5;
  g.setConnected('p1', false);
  const before = g.players.size;
  g.addPlayer('p1', '玩家1'); // 重连
  assert.equal(g.players.size, before, '不应新增玩家');
  assert.equal(g.players.get('p1').connected, true);
  assert.equal(g.players.get('p1').drinks, 5, '酒数应保留');
  assert.equal(g.players.get('p1').alive, true, '仍在场');
});

console.log('房主移除掉线玩家：');
t('非房主不能移除', () => {
  const g = makeGame(4);
  g.setConnected('p3', false);
  assert.equal(g.removeOffline('p1', 'p3').ok, false);
  assert.equal(g.players.has('p3'), true);
});
t('不能移除在线玩家', () => {
  const g = makeGame(4);
  assert.equal(g.removeOffline('p0', 'p1').ok, false);
});
t('移除卡轮的掉线者→本轮立即开牌', () => {
  const g = makeGame(4);
  g.submitPick('p0', 1); g.submitPick('p1', 2); g.submitPick('p2', 3);
  g.setConnected('p3', false); // p3 没出且掉线，卡住本轮
  assert.equal(g.phase, 'collect');
  assert.equal(g.removeOffline('p0', 'p3').ok, true);
  assert.equal(g.players.has('p3'), false);
  assert.equal(g.phase, 'reveal'); // 剩 3 人都出了 → 结算
});
t('移除后只剩 2 人→进入终局', () => {
  const g = makeGame(3);
  g.submitPick('p0', 1); g.submitPick('p1', 2);
  g.setConnected('p2', false);
  g.removeOffline('p0', 'p2');
  assert.equal(g.phase, 'endgame_consent');
  assert.equal(g.fieldSize(), 2);
});
t('移除到只剩 1 人→直接结束，剩者通关', () => {
  const g = makeGame(3);
  g.setConnected('p1', false);
  g.setConnected('p2', false);
  g.removeOffline('p0', 'p1');
  g.removeOffline('p0', 'p2');
  assert.equal(g.phase, 'gameover');
  assert.equal(g.players.get('p0').escaped, true);
});

t('20 人开局可正常跑到终局', () => {
  const g = toEndgame(makeGame(20));
  assert.equal(g.phase, 'endgame_consent');
  assert.equal(g.fieldSize(), 2);
});

console.log(`\n通过 ${passed} 项`);
