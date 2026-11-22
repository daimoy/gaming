'use strict';
// 十点半·暗夜赌局 —— 服务端权威状态机
// 房间：两名玩家 + 任意观战者；快速匹配自动配对；暗牌按视角脱敏。

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
const START_CHIPS = 20; // 筹码改少：每人 20

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 牌与点数 ---------- */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
/** @returns {{rank:string,suit:string,value:number}[]} */
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) {
    const value = r === 'A' ? 1 : (['J', 'Q', 'K'].includes(r) ? 0.5 : Number(r));
    d.push({ rank: r, suit: s, value });
  }
  d.push({ rank: 'JOKER', suit: '🃏', value: 0.5 });
  d.push({ rank: 'JOKER', suit: '🃏', value: 0.5 });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
/** @param {{value:number}[]} cards */
function score(cards) { return cards.reduce((a, c) => a + c.value, 0); }
/** 皇家十点半：恰好两张且一张10一张半点 */
function isRoyal(cards) {
  return cards.length === 2 && cards.some(c => c.value === 10) && cards.some(c => c.value === 0.5);
}

/* ---------- 房间 ---------- */
/** @type {Map<string, Room>} */
const rooms = new Map();
const waiting = []; // 快速匹配队列：{id, name}
let roomSeq = 0;
function newCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {any[]} 索引0/1是玩家，其余null占位 */
    this.slots = [null, null];
    /** @type {Set<string>} socket ids */
    this.spectators = new Set();
    this.phase = 'waiting'; // waiting|betting|drawing|result|gameover
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.turn = 0;
    this.bets = [0, 0];
    this.acted = [false, false];
    this.result = null;
    this.winnerSeat = -1;
    this.roundNo = 0;          // 局数计数
    this.lastNote = '';
  }
  get players() { return this.slots.filter(Boolean); }
  /** 东家 = 座位最靠前的玩家（创建者）；东家离开后自动转移给剩余玩家 */
  get hostSeat() { return this.slots.findIndex(p => p); }
  playerCount() { return this.players.length; }
  empty() { return this.playerCount() === 0 && this.spectators.size === 0; }
  /** 找空座位，返回索引或-1 */
  freeSeat() { return this.slots.findIndex(s => s === null); }
  addPlayer(id, name) {
    const seat = this.freeSeat();
    if (seat === -1) return -1;
    this.slots[seat] = { id, name, chips: START_CHIPS, cards: [], stood: false, bust: false };
    if (this.playerCount() === 2) this.beginBetting();
    return seat;
  }
  removeParticipant(id) {
    const seat = this.slots.findIndex(s => s && s.id === id);
    if (seat !== -1) this.slots[seat] = null;
    this.spectators.delete(id);
    if (this.playerCount() < 2 && (this.phase === 'betting' || this.phase === 'drawing')) {
      this.phase = 'waiting';
      this.result = null;
      this.slots.forEach(p => { if (p) { p.cards = []; p.stood = false; p.bust = false; } });
      this.pot = 0; this.bets = [0, 0]; this.acted = [false, false]; this.currentBet = 0;
    }
  }

  beginBetting() {
    this.roundNo += 1;
    this.phase = 'betting';
    this.pot = 0; this.currentBet = 0; this.bets = [0, 0];
    this.acted = [false, false]; this.turn = 0; this.result = null;
    this.winnerSeat = -1;
    this.deck = [];
    // 关键：彻底清空上一局的牌和状态，避免残留显示
    this.slots.forEach(p => { if (p) { p.cards = []; p.stood = false; p.bust = false; } });
    this.lastNote = `第 ${this.roundNo} 局 · 请玩家下注`;
    this.broadcastAll();
  }

  /** 下注动作：action in {bet|call|raise|fold}, amount 仅 bet/raise 有效 */
  handleBet(seat, action, amount) {
    if (this.phase !== 'betting' || this.turn !== seat) return;
    const me = this.slots[seat], other = this.slots[1 - seat];
    if (!me || !other) return;
    if (action === 'fold') {
      this.finish(1 - seat, { fold: true, text: `${me.name} 弃牌，${other.name} 赢得底池` });
      return;
    }
    const otherAllIn = other.chips === 0;
    let target = 0;
    if (action === 'bet') target = Math.max(1, Math.floor(amount) || 1);
    // 对手已 all-in 时不允许再加，只能跟到上限，避免死循环
    if (action === 'raise') target = otherAllIn ? this.currentBet : Math.max(this.currentBet + 1, Math.floor(amount) || 0);
    if (action === 'call') target = this.currentBet;
    const need = Math.max(0, target - this.bets[seat]);
    const pay = Math.min(need, me.chips); // 筹码不足则 all-in
    me.chips -= pay; this.bets[seat] += pay; this.pot += pay;
    if (this.bets[seat] > this.currentBet) {
      this.currentBet = this.bets[seat];
      this.acted[1 - seat] = false; // 加注后对方需重新响应（哪怕自己已 all-in）
    }
    this.acted[seat] = true;

    const matched = this.bets[0] === this.bets[1];
    const bothAllIn = this.slots.every(p => !p || p.chips === 0);
    const settled = this.acted[0] && this.acted[1] && (matched || bothAllIn);
    if (settled) {
      this.beginDrawing();
    } else {
      this.turn = 1 - seat;
      this.broadcastAll();
    }
  }

  beginDrawing() {
    this.phase = 'drawing';
    this.deck = makeDeck();
    this.slots.forEach(p => { if (p) { p.cards = [this.deck.pop()]; p.stood = false; p.bust = false; } });
    this.turn = 0;
    this.lastNote = '暗牌已发 · 玩家1选择要牌或停牌';
    this.broadcastAll();
  }

  handleDraw(seat, action) {
    if (this.phase !== 'drawing' || this.turn !== seat) return;
    const me = this.slots[seat], other = this.slots[1 - seat];
    if (!me || !other) return;
    if (action === 'hit') {
      me.cards.push(this.deck.pop());
      if (score(me.cards) > 10.5) {
        me.bust = true;
        this.finish(1 - seat, { bustSeat: seat, text: `${me.name} 爆牌！${other.name} 获胜` });
        return;
      }
      this.broadcastAll();
      return;
    }
    if (action === 'stand') {
      me.stood = true;
      const next = this.slots.findIndex(p => p && !p.stood && !p.bust);
      if (next === -1) { this.showdown(); return; }
      this.turn = next;
      this.broadcastAll();
    }
  }

  showdown() {
    const s0 = this.slots[0], s1 = this.slots[1];
    const v0 = score(s0.cards), v1 = score(s1.cards);
    let win = -1;
    if (v0 > v1) win = 0; else if (v1 > v0) win = 1;
    let mult = 1, royal = false;
    if (win !== -1 && isRoyal(this.slots[win].cards)) { mult = 3; royal = true; }
    const text = win === -1
      ? `平局（${v0} : ${v1}），退还各自赌注`
      : `${this.slots[win].name} 获胜（${v0} : ${v1}）${royal ? ' · 皇家十点半三倍赔付！' : ''}`;
    if (win === -1) {
      s0.chips += this.bets[0]; s1.chips += this.bets[1];
      this.finish(-1, { draw: true, text, v0, v1 });
    } else {
      this.finish(win, { text, v0, v1, royal, mult });
    }
  }

  finish(winnerSeat, result) {
    if (winnerSeat !== -1) {
      const w = this.slots[winnerSeat];
      const mult = result.mult || 1;
      w.chips += this.pot * mult;
    }
    this.winnerSeat = winnerSeat;
    this.result = result;
    const brokeIdx = this.slots.findIndex(p => p && p.chips <= 0);
    if (brokeIdx !== -1) {
      // 筹码耗尽：明确告诉玩家最终输赢
      const champion = 1 - brokeIdx;
      result.gameOver = true;
      result.brokeSeat = brokeIdx;
      result.championSeat = champion;
      result.finalText = `${this.slots[champion].name} 赢下整场 · ${this.slots[brokeIdx].name} 筹码输光`;
      this.lastNote = result.finalText;
      this.phase = 'gameover';
    } else {
      this.phase = 'result';
    }
    this.broadcastAll();
  }

  nextRound(seat) {
    if (this.phase !== 'result') return;
    if (seat !== this.hostSeat) return; // 只有东家能开下一局
    this.beginBetting();
  }
  restart(seat) {
    if (seat !== this.hostSeat) return; // 只有东家能重开
    this.roundNo = 0;
    this.slots.forEach(p => { if (p) p.chips = START_CHIPS; });
    this.beginBetting();
  }

  note(text) { this.lastNote = text; this.broadcastAll(); }

  /** 按视角生成状态：暗牌仅本人可见；结果/结束时全员可见；观战者始终可见 */
  stateFor(viewerId) {
    const seat = this.slots.findIndex(p => p && p.id === viewerId);
    const isSpectator = this.spectators.has(viewerId);
    const reveal = this.phase === 'result' || this.phase === 'gameover';
    const seats = this.slots.map((p, i) => {
      if (!p) return null;
      const cards = p.cards.map((c, ci) => {
        const hidden = ci === 0 && !reveal && !isSpectator && seat !== i;
        return hidden ? { hidden: true } : c;
      });
      return { name: p.name, chips: p.chips, bet: this.bets[i], cards,
               stood: p.stood, bust: p.bust, score: reveal || isSpectator ? score(p.cards) : (seat === i ? score(p.cards) : null) };
    });
    return {
      room: this.code, phase: this.phase, seats,
      spectators: this.spectators.size, you: seat, isSpectator,
      pot: this.pot, currentBet: this.currentBet, turn: this.turn,
      result: this.result, note: this.lastNote || '',
      winnerSeat: this.winnerSeat,
      hostSeat: this.hostSeat, roundNo: this.roundNo,
      startChips: START_CHIPS
    };
  }
  broadcastAll() {
    for (const p of this.slots) if (p) io.to(p.id).emit('state', this.stateFor(p.id));
    for (const sid of this.spectators) io.to(sid).emit('state', this.stateFor(sid));
  }
}

/* ---------- 连接与路由 ---------- */
let currentRoom = null;
io.on('connection', socket => {
  let roomCode = null;

  socket.on('create', name => {
    let code = newCode();
    while (rooms.has(code)) code = newCode();
    const room = new Room(code);
    rooms.set(code, room);
    currentRoom = room;
    join(socket, room, name);
  });

  socket.on('join', ({ code, name }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) { socket.emit('error', '房间不存在，请检查房间号'); return; }
    join(socket, room, name);
  });

  socket.on('quickmatch', name => {
    const idx = waiting.findIndex(w => w.id !== socket.id);
    if (idx !== -1) {
      const other = waiting.splice(idx, 1)[0];
      let code = newCode();
      while (rooms.has(code)) code = newCode();
      const room = new Room(code);
      rooms.set(code, room);
      join(io.sockets.sockets.get(other.id), room, other.name);
      join(socket, room, name);
    } else {
      waiting.push({ id: socket.id, name });
      socket.emit('waiting', true);
    }
  });

  function join(sock, room, name) {
    if (!sock) return;
    socketLeave(sock); // 先离开旧房间
    const seat = room.addPlayer(sock.id, name || `玩家${room.playerCount() + 1}`);
    if (seat === -1) {
      room.spectators.add(sock.id);
      roomCodeBind.set(sock.id, room.code); // 观战者也绑定，便于聊天/离开
      sock.emit('joined', { code: room.code, role: 'spectator' });
    } else {
      roomCodeBind.set(sock.id, room.code);
      sock.emit('joined', { code: room.code, role: 'player', seat });
    }
    room.broadcastAll();
  }

  socket.on('bet', ({ action, amount }) => {
    const room = rooms.get(roomCodeBind.get(socket.id));
    if (!room) return;
    const seat = room.slots.findIndex(p => p && p.id === socket.id);
    if (seat !== -1) room.handleBet(seat, action, amount);
  });
  socket.on('draw', action => {
    const room = rooms.get(roomCodeBind.get(socket.id));
    if (!room) return;
    const seat = room.slots.findIndex(p => p && p.id === socket.id);
    if (seat !== -1) room.handleDraw(seat, action);
  });
  socket.on('next', () => {
    const room = rooms.get(roomCodeBind.get(socket.id));
    if (!room) return;
    const seat = room.slots.findIndex(p => p && p.id === socket.id);
    room.nextRound(seat);
  });
  socket.on('restart', () => {
    const room = rooms.get(roomCodeBind.get(socket.id));
    if (!room) return;
    const seat = room.slots.findIndex(p => p && p.id === socket.id);
    room.restart(seat);
  });

  // 房间聊天：玩家和观战者都能发言
  socket.on('chat', text => {
    const room = rooms.get(roomCodeBind.get(socket.id));
    if (!room) return;
    const p = room.slots.find(p => p && p.id === socket.id);
    const name = p ? p.name : '👁观众';
    const safe = String(text || '').slice(0, 80);
    if (!safe.trim()) return;
    const payload = { name, text: safe, spectator: !p };
    for (const sp of room.players) io.to(sp.id).emit('chat', payload);
    for (const sid of room.spectators) io.to(sid).emit('chat', payload);
  });

  socket.on('disconnect', () => {
    const wi = waiting.findIndex(w => w.id === socket.id);
    if (wi !== -1) waiting.splice(wi, 1);
    socketLeave(socket);
  });

  function socketLeave(sock) {
    const code = roomCodeBind.get(sock.id);
    if (code) {
      const room = rooms.get(code);
      if (room) {
        room.removeParticipant(sock.id);
        if (room.empty()) rooms.delete(code);
      }
      roomCodeBind.delete(sock.id);
    } else {
      // 观战者可能没绑 code
      for (const room of rooms.values()) if (room.spectators.delete(sock.id)) break;
    }
  }
});

const roomCodeBind = new Map(); // socket id -> room code（玩家）

server.listen(PORT, () => console.log(`十点半服务器运行于 http://localhost:${PORT}`));
