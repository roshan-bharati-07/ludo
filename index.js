import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

/* =========================================================
   LUDO SERVER  (Express + Socket.IO)

   The server is the single source of truth: it rolls the
   dice, checks every rule, moves the coins and decides whose
   turn it is. Browsers only send "roll" and "move" and draw
   whatever the server tells them.

   Runs on the local network, so it works over a phone hotspot
   with no internet at all.
   ========================================================= */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
// LUDO_FAST=1 shortens every pause (used only for automated testing)
const T = process.env.LUDO_FAST ? 0.03 : 1;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const frontendPath = path.join(__dirname, 'index.html');
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get(['/', '/game'], (req, res) => {
    if (fs.existsSync(frontendPath)) return res.sendFile(frontendPath);
    res.json({ service: 'ludo-backend', message: 'The game frontend is hosted separately.' });
});

/* the addresses other phones/laptops should type in */
function lanUrls() {
    const urls = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach(name => {
        (nets[name] || []).forEach(n => {
            if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${PORT}`);
        });
    });
    return urls;
}
app.get('/api/info', (req, res) => res.json({ urls: lanUrls() }));

/* =========================================================
   GAME CONSTANTS
   ========================================================= */

const NAMES = { red: 'Red', green: 'Green', blue: 'Blue', yellow: 'Yellow' };

// which colours play, depending on the number of players
const SEAT_COLORS = {
    1: ['red'],
    2: ['red', 'blue'],
    3: ['red', 'green', 'blue'],
    4: ['red', 'green', 'blue', 'yellow']
};

// index of each colour's start square on the 52-square outer track
const START = { red: 0, green: 13, blue: 26, yellow: 39 };

// start squares + star squares (track indexes)
const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);

/*  progress k of a coin
      -1       in the yard
       0       on its start square
       1..50   along the outer track (50 = square where it turns into home)
       51..55  the five coloured home-lane squares (completely safe)
       56      home                                                       */
const HOME_K = 56;

const SELECTABLE_RULES = {
    mustCapture: false,
    captureToEnterHome: false,
    showSafeStars: true,
    extra6: true,
    extraCapture: false,
    extraHome: false
};

const DEFAULT_RULES = {
    ...SELECTABLE_RULES,
    capture: true,
    safeSquares: true,
    exactHome: true
};

function cleanRules(input) {
    const out = { ...DEFAULT_RULES };
    Object.keys(SELECTABLE_RULES).forEach(k => {
        out[k] = (input && typeof input[k] === 'boolean') ? input[k] : DEFAULT_RULES[k];
    });
    return out;
}

/* =========================================================
   ROOMS
   ========================================================= */

const rooms = new Map();

function newCode() {
    let code;
    do {
        code = String(1000 + crypto.randomInt(9000));
    } while ([...rooms.values()].some(room => room.code === code));
    return code;
}

function cleanName(value) {
    return String(value || '').replace(/[<>]/g, '').trim().slice(0, 20);
}

function createRoom(opts, joinable) {
    const players = [2, 3, 4].includes(+opts.players) ? +opts.players : 4;
    const coins   = [2, 3, 4].includes(+opts.coins) ? +opts.coins : 4;
    const rules = cleanRules(opts.rules);
    const id = crypto.randomBytes(16).toString('hex');
    const room = {
        id,
        code: joinable ? newCode() : null,
        config: { players, coins, rules },
        seats: SEAT_COLORS[players].map(color => ({
            color, name: null, token: null, sid: null, connected: false, left: false
        })),
        started: false,
        tokens: [],
        cur: 0, sixes: 0, ones: {}, onePenalty: null, lastRoll: 0,
        state: 'lobby',               // lobby | roll | rolling | choose | anim | over
        pending: [], movable: [],
        message: '', winner: null,
        turnSeq: 0, dead: false, cleanup: null
    };
    rooms.set(id, room);
    return room;
}

function cleanDevicePlayers(value, availableSeats) {
    const count = value === undefined || value === null ? 1 : Number(value);
    return Number.isInteger(count) && count >= 1 && count <= 3 && count <= availableSeats
        ? count
        : null;
}

function cleanPlayerNames(names, fallbackName, count) {
    const cleaned = Array.isArray(names)
        ? names.map(cleanName)
        : Array.from({ length: count }, () => cleanName(fallbackName));
    return cleaned.length === count && cleaned.every(Boolean) ? cleaned : null;
}

function seatsForDevice(room, count) {
    const available = room.seats.filter(seat => !seat.token);
    const colors = room.config.players === 4
        ? ['red', 'blue', 'green', 'yellow']
        : room.seats.map(seat => seat.color);
    return colors.map(color => available.find(seat => seat.color === color))
        .filter(Boolean)
        .slice(0, count);
}

function startWhenFull(room) {
    if (!room.seats.every(seat => seat.token)) return;
    setTimeout(() => {
        if (!room.dead && !room.started && room.seats.every(seat => seat.token)) startGame(room);
    }, 1200 * T);
}

const seatOfColor = (room, color) => room.seats.find(s => s.color === color);
const currentSeat = (room) => room.seats[room.cur];
const label = (seat) => `${seat.name} (${NAMES[seat.color]})`;
const tokenKey = (t) => t.color + t.id;

function publicRoom(room) {
    return {
        code: room.code,
        config: room.config,
        started: room.started,
        seats: room.seats.map(s => ({
            color: s.color, name: s.name, connected: s.connected, left: s.left, taken: !!s.token
        }))
    };
}

function snapshot(room) {
    return {
        ...publicRoom(room),
        order: room.seats.map(s => s.color),
        cur: room.cur,
        state: room.state,
        tokens: room.tokens.map(t => ({ color: t.color, id: t.id, k: t.k, captured: t.captured })),
        movable: room.movable,
        lastRoll: room.lastRoll,
        message: room.message,
        winner: room.winner
    };
}

const emitRoom  = (room) => io.to(room.id).emit('room', publicRoom(room));
function emitState(room, msg) {
    if (msg !== undefined) room.message = msg;
    io.to(room.id).emit('state', snapshot(room));
}

/* run fn later, but only if the game is still on the same turn */
function later(room, ms, fn) {
    const seq = room.turnSeq;
    setTimeout(() => {
        if (room.dead || room.turnSeq !== seq) return;
        try { fn(); } catch (e) { console.error(e); }
    }, ms * T);
}

/* =========================================================
   GAME LOGIC
   ========================================================= */

function startGame(room) {
    room.tokens = [];
    room.seats.forEach(seat => {
        for (let i = 0; i < room.config.coins; i++) {
            room.tokens.push({ color: seat.color, id: i, k: -1, captured: false });
        }
    });
    room.started = true;
    room.cur = 0;
    room.sixes = 0;
    room.ones = Object.fromEntries(room.seats.map(seat => [seat.color, 0]));
    room.onePenalty = null;
    room.lastRoll = 0;
    room.winner = null;
    room.pending = [];
    room.movable = [];
    room.turnSeq++;
    emitRoom(room);
    startTurn(room, `${label(currentSeat(room))} - roll the dice`);
}

function startTurn(room, msg) {
    room.turnSeq++;
    room.state = 'roll';
    room.pending = [];
    room.movable = [];
    emitState(room, msg);
    scheduleSkip(room);
}

function nextTurn(room) {
    room.sixes = 0;
    room.cur = (room.cur + 1) % room.seats.length;
    startTurn(room, `${label(currentSeat(room))} - roll the dice`);
}

/* a player who disconnected (or left) must not freeze the game */
function scheduleSkip(room) {
    if (!room.started || room.state === 'over') return;
    const seat = currentSeat(room);
    if (seat.connected) return;
    later(room, seat.left ? 1200 : 12000, () => {
        if (seat.connected) return;
        if (room.state === 'roll') {
            emitState(room, `${label(seat)} is away - turn skipped`);
            later(room, 1200, () => nextTurn(room));
        } else if (room.state === 'choose' && room.pending.length) {
            performMove(room, room.pending[0]);
        }
    });
}

const trackIdx = (t) => (t.k >= 0 && t.k <= 50) ? (START[t.color] + t.k) % 52 : -1;

function wouldCapture(room, token, to) {
    if (to < 0 || to > 50) return false;
    const index = (START[token.color] + to) % 52;
    if (SAFE.has(index)) return false;
    return room.tokens.some(other => other.color !== token.color && trackIdx(other) === index);
}

function legalMoves(room, color, d, thirdSix) {
    const R    = room.config.rules;
    const mine = room.tokens.filter(t => t.color === color);
    const yard = mine.filter(t => t.k < 0);
    const moves = [];

    // A third consecutive 6 forces a coin out when one is waiting.
    if (thirdSix && yard.length) {
        yard.forEach(t => moves.push({ t, open: true }));
        return moves;
    }
    if (d === 1) {
        yard.forEach(t => moves.push({ t, open: true }));
    }
    mine.filter(t => t.k >= 0 && t.k < HOME_K && (!R.exactHome || t.k + d <= HOME_K))
        .filter(t => !R.captureToEnterHome || t.captured || t.k + d <= 50)
        .forEach(t => moves.push({ t, open: false }));
    if (R.mustCapture) {
        const captures = moves.filter(m => wouldCapture(room, m.t, m.open ? 0 : m.t.k + d));
        if (captures.length) return captures;
    }
    return moves;
}

function handleRoll(room, seat, flick, rollerId) {
    if (!room.started || room.state !== 'roll') return false;
    if (currentSeat(room) !== seat) return false;

    const R = room.config.rules;
    const d = 1 + crypto.randomInt(6);
    room.lastRoll = d;
    room.state = 'rolling';
    room.movable = [];

    if (d === 6) room.sixes++; else room.sixes = 0;
    const thirdSix = d === 6 && room.sixes === 3;
    if (d === 6 && room.sixes === 3) room.sixes = 0;

    room.ones[seat.color] = d === 1 ? (room.ones[seat.color] || 0) + 1 : 0;
    const thirdOne = room.ones[seat.color] === 3;
    if (thirdOne) room.ones[seat.color] = 0;
    room.onePenalty = null;
    if (thirdOne) {
        const farthest = room.tokens
            .filter(token => token.color === seat.color && token.k >= 0 && token.k < HOME_K)
            .sort((a, b) => b.k - a.k || a.id - b.id)[0] || null;
        room.onePenalty = { token: farthest };
    }

    room.pending = thirdOne ? [] : legalMoves(room, seat.color, d, thirdSix);

    // how hard / which way the dice is thrown (in tray-widths per second)
    let vx, vy;
    if (flick && Number.isFinite(flick.vx) && Number.isFinite(flick.vy)) {
        const sp = Math.hypot(flick.vx, flick.vy) || 1;
        const k = Math.min(4.6, Math.max(1.5, sp)) / sp;
        vx = flick.vx * k; vy = flick.vy * k;
    } else {
        const a = Math.random() * Math.PI * 2, s = 2.3 + Math.random() * 1.2;
        vx = Math.cos(a) * s; vy = Math.sin(a) * s;
    }

    io.to(room.id).emit('dice', { color: seat.color, value: d, roller: rollerId, throw: { vx, vy } });
    emitState(room, `${label(seat)} rolled ${d}`);

    later(room, 1700, () => resolveRoll(room, seat, d));
    return true;
}

function resolveRoll(room, seat, d) {
    const name = label(seat);

    if (room.onePenalty) {
        const { token } = room.onePenalty;
        room.onePenalty = null;
        room.state = 'anim';
        room.pending = [];
        room.movable = [];
        let msg = `${name} rolled three 1s - no coin was out to send back`;
        if (token) {
            const from = token.k;
            token.k = -1;
            msg = `${name} rolled three 1s - their farthest coin was sent to the yard`;
            io.to(room.id).emit('move', {
                color: token.color, id: token.id, from, to: -1,
                penalty: true, victims: [], msg
            });
        }
        emitState(room, msg);
        later(room, 650, () => nextTurn(room));
        return;
    }

    if (!room.pending.length) {
        room.state = 'anim';
        emitState(room, `${name} rolled ${d} - no coin can move`);
        later(room, 1500, () => {
            if (d === 6 && room.config.rules.extra6) {
                startTurn(room, `${name} gets another turn - roll again`);
            } else {
                nextTurn(room);
            }
        });
        return;
    }

    // coins at the same progress are interchangeable
    const seen = new Set();
    const uniq = room.pending.filter(m => {
        const key = m.open ? 'open' : m.t.k;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    if (uniq.length === 1) {
        room.state = 'anim';
        emitState(room, `${name} rolled ${d}`);
        later(room, 700, () => performMove(room, uniq[0]));
    } else {
        room.state = 'choose';
        room.movable = room.pending.map(m => tokenKey(m.t));
        emitState(room, `${name} rolled ${d} - pick a coin to move`);
        scheduleSkip(room);
    }
}

function performMove(room, mv) {
    const R = room.config.rules;
    const d = room.lastRoll;
    const t = mv.t;
    const seat = seatOfColor(room, t.color);
    const from = t.k;
    const to = mv.open ? 0 : (R.exactHome ? from + d : Math.min(HOME_K, from + d));

    room.state = 'anim';
    room.movable = [];
    room.pending = [];
    t.k = to;

    let victims = [];
    if (to >= 0 && to <= 50) {
        const idx = trackIdx(t);
        if (!SAFE.has(idx)) {
            victims = room.tokens.filter(o => o.color !== t.color && trackIdx(o) === idx);
            victims.forEach(o => { o.k = -1; });
            if (victims.length) t.captured = true;
        }
    }

    let msg = '';
    if (victims.length) msg = `${label(seat)} sent ${NAMES[victims[0].color]}'s coin back to the yard!`;
    else if (to === HOME_K) msg = `${label(seat)} - a coin reached home!`;

    io.to(room.id).emit('move', {
        color: t.color, id: t.id, from, to, open: !!mv.open,
        victims: victims.map(v => ({ color: v.color, id: v.id })),
        msg
    });

    const ms = (mv.open ? 500 : (to - from) * 215 + 300) + (victims.length ? 900 : 0) + (to === HOME_K ? 600 : 0);
    later(room, ms, () => afterMove(room, t, victims));
}

function afterMove(room, t, victims) {
    const R = room.config.rules;
    const seat = seatOfColor(room, t.color);
    const home = room.tokens.filter(o => o.color === t.color && o.k === HOME_K).length;

    if (home === room.config.coins) {
        room.state = 'over';
        room.winner = t.color;
        emitState(room, `${label(seat)} wins the game!`);
        return;
    }

    const d = room.lastRoll;
    const extra = (R.extra6 && d === 6) ||
        (R.extraCapture && victims.length > 0) ||
        (R.extraHome && t.k === HOME_K);
    if (extra) startTurn(room, `${label(seat)} gets another turn - roll again`);
    else nextTurn(room);
}

function handleMove(room, seat, data) {
    if (!room.started || room.state !== 'choose') return;
    if (currentSeat(room) !== seat) return;
    if (!data || typeof data.color !== 'string') return;
    const id = +data.id;
    const mv = room.pending.find(m => m.t.color === data.color && m.t.id === id) ||
               // any waiting coin works for "bring a coin out"
               (data.color === seat.color && room.pending.find(m => m.open && m.t.color === data.color &&
                   room.tokens.find(t => t.color === data.color && t.id === id && t.k < 0)));
    if (mv) performMove(room, mv);
}

/* =========================================================
   SOCKETS
   ========================================================= */

function attach(socket, room, seats) {
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.token = seats[0].token;
    seats.forEach(seat => {
        seat.sid = socket.id;
        seat.connected = true;
        seat.left = false;
    });
    if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null; }
}

function maybeCleanup(room) {
    if (room.seats.some(s => s.connected)) return;
    if (room.cleanup) clearTimeout(room.cleanup);
    room.cleanup = setTimeout(() => {
        room.dead = true;
        rooms.delete(room.id);
    }, 10 * 60 * 1000);
}

function getCtx(socket) {
    const room = rooms.get(socket.data.roomId);
    if (!room) return {};
    const seat = currentSeat(room).token === socket.data.token
        ? currentSeat(room)
        : room.seats.find(ownedSeat => ownedSeat.token === socket.data.token);
    return seat ? { room, seat } : {};
}

io.on('connection', (socket) => {

    socket.on('create', (data, cb) => {
        cb = typeof cb === 'function' ? cb : () => {};
        data = data || {};
        const playerCount = Number(data.players);
        if (![2, 3, 4].includes(playerCount)) {
            return cb({ ok: false, error: 'A game must have at least 2 players.' });
        }
        const count = cleanDevicePlayers(data.devicePlayers, playerCount);
        if (!count) {
            return cb({ ok: false, error: `Choose between 1 and ${Math.min(3, playerCount)} players for this device.` });
        }
        const names = cleanPlayerNames(data.names, data.name, count);
        if (!names) return cb({ ok: false, error: `Enter a name for each of the ${count} players on this device.` });
        const room = createRoom(data, count < playerCount);
        const seats = seatsForDevice(room, count);
        const token = crypto.randomBytes(12).toString('hex');
        seats.forEach((seat, index) => { seat.name = names[index]; seat.token = token; });
        room.hostToken = token;
        attach(socket, room, seats);
        cb({
            ok: true, code: room.code, sessionId: room.id,
            color: seats[0].color, colors: seats.map(seat => seat.color),
            token, isHost: true
        });
        emitRoom(room);
        startWhenFull(room);
    });

    socket.on('join', (data, cb) => {
        cb = typeof cb === 'function' ? cb : () => {};
        data = data || {};
        const code = String(data.code || '').trim();
        const room = [...rooms.values()].find(candidate => candidate.code === code);
        if (!room)        return cb({ ok: false, error: 'No game found with that code.' });
        if (room.started) return cb({ ok: false, error: 'That game has already started.' });
        const availableSeats = room.seats.filter(seat => !seat.token).length;
        const count = cleanDevicePlayers(data.devicePlayers, availableSeats);
        if (!count) {
            return cb({ ok: false, error: availableSeats
                ? `Only ${availableSeats} player seat${availableSeats === 1 ? '' : 's'} remain. Choose no more than ${Math.min(3, availableSeats)} player${availableSeats === 1 ? '' : 's'} for this device.`
                : 'That game is full.' });
        }
        const names = cleanPlayerNames(data.names, data.name, count);
        if (!names) return cb({ ok: false, error: `Enter a name for each of the ${count} players on this device.` });
        const seats = seatsForDevice(room, count);
        const token = crypto.randomBytes(12).toString('hex');

        seats.forEach((seat, index) => { seat.name = names[index]; seat.token = token; });
        attach(socket, room, seats);
        cb({
            ok: true, code: room.code, sessionId: room.id,
            color: seats[0].color, colors: seats.map(seat => seat.color),
            token, isHost: false
        });
        emitRoom(room);

        startWhenFull(room);
    });

    /* coming back after a reload / flaky hotspot connection */
    socket.on('rejoin', (data, cb) => {
        cb = typeof cb === 'function' ? cb : () => {};
        data = data || {};
        const room = rooms.get(String(data.sessionId || data.code || ''));
        const seats = room && room.seats.filter(s => s.token && s.token === data.token);
        if (!room || !seats.length) return cb({ ok: false });
        attach(socket, room, seats);
        cb({
            ok: true, code: room.code, sessionId: room.id, color: seats[0].color,
            colors: seats.map(seat => seat.color), isHost: room.hostToken === seats[0].token
        });
        emitRoom(room);
        if (room.started) socket.emit('state', snapshot(room));
    });

    socket.on('roll', (flick, cb) => {
        cb = typeof cb === 'function' ? cb : () => {};
        const { room, seat } = getCtx(socket);
        cb({ ok: !!(room && seat && handleRoll(room, seat, flick, socket.id)) });
    });

    socket.on('move', (data) => {
        const { room, seat } = getCtx(socket);
        if (room && seat) handleMove(room, seat, data);
    });

    socket.on('rematch', () => {
        const { room, seat } = getCtx(socket);
        if (!room || !seat || room.hostToken !== seat.token) return;
        if (room.state === 'over') startGame(room);
    });

    socket.on('leave', () => {
        const { room, seat } = getCtx(socket);
        if (!room || !seat) return;
        socket.leave(room.id);
        socket.data.roomId = null;

        const ownedSeats = room.seats.filter(s => s.token === socket.data.token);
        if (!room.started) {
            if (room.hostToken === seat.token) {          // host left the lobby: close it
                io.to(room.id).emit('closed');
                room.dead = true;
                rooms.delete(room.id);
                return;
            }
            ownedSeats.forEach(ownedSeat => {
                ownedSeat.name = null; ownedSeat.token = null; ownedSeat.sid = null; ownedSeat.connected = false;
            });
            emitRoom(room);
            return;
        }
        ownedSeats.forEach(ownedSeat => {
            ownedSeat.connected = false;
            ownedSeat.left = true;
            ownedSeat.sid = null;
        });
        emitRoom(room);
        if (currentSeat(room).token === socket.data.token) scheduleSkip(room);
        maybeCleanup(room);
    });

    socket.on('disconnect', () => {
        const { room, seat } = getCtx(socket);
        if (!room || !seat || seat.sid !== socket.id) return;
        room.seats.filter(ownedSeat => ownedSeat.token === socket.data.token).forEach(ownedSeat => {
            if (ownedSeat.sid !== socket.id) return;
            ownedSeat.connected = false;
            ownedSeat.sid = null;
        });
        emitRoom(room);
        if (room.started && currentSeat(room).token === socket.data.token) scheduleSkip(room);
        maybeCleanup(room);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  LUDO server is running\n');
    console.log(`  On this computer : http://localhost:${PORT}`);
    const urls = lanUrls();
    if (urls.length) {
        console.log('  Friends on the same hotspot / Wi-Fi open:');
        urls.forEach(u => console.log('      ' + u));
    } else {
        console.log('  (no network address found - connect to the hotspot first)');
    }
    console.log('');
});