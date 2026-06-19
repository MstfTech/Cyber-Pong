// ═══════════════════════════════════════════════════════════════════════════
// CYBER PONG — server.js  (Discord Webhook Entegreli Tam Sürüm)
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fetch = require('node-fetch'); // Bu satırı ekle
const express = require('express');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    pingInterval: 10000,
    pingTimeout : 5000,
    maxHttpBufferSize: 1e4
});

app.use(express.static(__dirname));

// ─── Discord Webhook Entegrasyonu ─────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function sendDiscordLog(title, message, color = 0x00ff00) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: title,
                    description: message,
                    color: color,
                    timestamp: new Date().toISOString()
                }]
            })
        });
    } catch (err) {
        console.log("Discord webhook hatası:", err.message);
    }
}

// ─── Sabitler ────────────────────────────────────────────────────────────────
const CANVAS_WIDTH    = 800;
const CANVAS_HEIGHT   = 600;
const MAX_SCORE       = 5;
const BASE_SPEED      = 5;
const MAX_SPEED       = 18;
const SPEED_INCREMENT = 0.6;
const PADDLE_HEIGHT   = 100;
const PADDLE_WIDTH    = 12;
const BALL_RADIUS     = 8;
const SERVER_TICK_RATE = 30;
const TICK_INTERVAL    = 1000 / SERVER_TICK_RATE;
const REMATCH_WINDOW   = 45000;

// ─── Sunucu Durumu ────────────────────────────────────────────────────────────
let waitingPlayer = null;
let rooms         = {};
let roomCounter   = 0;
let privateRooms  = {};
let singleplayerSessions = {};
let socketRoomMap = {}; 

// ─── Liderlik Tablosu ─────────────────────────────────────────────────────────
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = [];
let chatHistory = [];

function loadLeaderboard() {
    try {
        if (fs.existsSync(LEADERBOARD_FILE)) {
            leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
        }
    } catch (e) { leaderboard = []; }
}

function saveLeaderboard() {
    try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard), 'utf8'); }
    catch (e) { console.error('Leaderboard kayıt hatası:', e.message); }
}

function updateLeaderboard(name, xp, level) {
    if (!name || typeof xp !== 'number') return;
    const existing = leaderboard.find(e => e.name === name);
    if (existing) {
        if (xp > existing.xp) { existing.xp = xp; existing.level = level; }
    } else {
        leaderboard.push({ name, xp, level });
    }
    leaderboard.sort((a, b) => b.xp - a.xp);
    leaderboard = leaderboard.slice(0, 50);
    saveLeaderboard();
}

function getTop10() { return leaderboard.slice(0, 10); }
loadLeaderboard();

// ─── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (privateRooms[code]);
    return code;
}

function findRoomBySocketId(socketId) {
    return socketRoomMap[socketId] || null;
}

function cleanupRoom(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    if (room.interval) { clearInterval(room.interval); room.interval = null; }
    if (room._rematchTimeout) { clearTimeout(room._rematchTimeout); room._rematchTimeout = null; }
    if (room._arenaEventTimeout) { clearTimeout(room._arenaEventTimeout); room._arenaEventTimeout = null; }
    for (const code in privateRooms) {
        if (privateRooms[code] === roomName) { delete privateRooms[code]; break; }
    }
    for (const pid in room.players) {
        delete socketRoomMap[pid];
    }
    delete rooms[roomName];
}

function createRoomState() {
    return {
        players: {},
        ball: {
            x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2,
            dx: 0, dy: 0,
            currentSpeed: BASE_SPEED, lastHit: null
        },
        powerup: { x: 0, y: 0, type: 0, active: false },
        stats: { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 },
        countdown: 3,
        rematchRequests: {},
        interval: null,
        _rematchTimeout: null,
        _arenaEventTimeout: null,
        status: 'waiting',
        frameCount: 0,
        arenaEvent: null   
    };
}

function resetBall(room) {
    room.ball.x = CANVAS_WIDTH / 2;
    room.ball.y = CANVAS_HEIGHT / 2;
    room.ball.currentSpeed = BASE_SPEED;
    room.ball.lastHit = null;

    const signX    = Math.random() < 0.5 ? 1 : -1;
    const signY    = Math.random() < 0.5 ? 1 : -1;
    const minAngle = Math.PI / 6;
    const maxAngle = Math.PI / 3;
    const angle    = Math.random() * (maxAngle - minAngle) + minAngle;
    room.ball.dx   = Math.cos(angle) * BASE_SPEED * signX;
    room.ball.dy   = Math.sin(angle) * BASE_SPEED * signY;
}

// ─── Maç Başlatma ─────────────────────────────────────────────────────────────
function initMatch(roomName, socket1, profile1, socket2, profile2) {
    const room = rooms[roomName];
    // Profilleri odaya ekledik ki maç sonunda Discord loguna isimleri düşsün
    room.players = {
        [socket1.id]: { y: 250, side: 'left',  score: 0, lastY: 250, paddleGrowUntil: 0, profile: profile1 },
        [socket2.id]: { y: 250, side: 'right', score: 0, lastY: 250, paddleGrowUntil: 0, profile: profile2 }
    };
    room.status    = 'countdown';
    room.countdown = 3;
    room.ball      = { x: CANVAS_WIDTH/2, y: CANVAS_HEIGHT/2, dx:0, dy:0, currentSpeed: BASE_SPEED, lastHit: null };
    room.stats     = { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 };
    room.rematchRequests = {};
    room.frameCount = 0;
    room.arenaEvent = null;

    resetBall(room);

    socket1.join(roomName);
    socket2.join(roomName);
    socketRoomMap[socket1.id] = roomName;
    socketRoomMap[socket2.id] = roomName;

    io.to(socket1.id).emit('init', { side: 'left',  opponent: profile2 });
    io.to(socket2.id).emit('init', { side: 'right', opponent: profile1 });
    io.to(roomName).emit('countdownUpdate', room.countdown);

    // Discord Log: Maç başladı
    sendDiscordLog("⚔️ Siber Arena Eşleşmesi!", `**${profile1.name}** ve **${profile2.name}** karşı karşıya geliyor. Maç başlıyor!`, 0x00ffff);

    startGameLoop(roomName);
}

// ─── Oyun Döngüsü ─────────────────────────────────────────────────────────────
function startGameLoop(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    if (room.interval) {
        clearInterval(room.interval);
        room.interval = null;
    }

    room.interval = setInterval(() => {
        if (!rooms[roomName]) { clearInterval(room.interval); return; }

        room.frameCount++;

        if (room.status === 'countdown') {
            if (room.frameCount % SERVER_TICK_RATE === 0) {
                room.countdown--;
                io.to(roomName).emit('countdownUpdate', room.countdown);
                if (room.countdown <= 0) {
                    room.status  = 'playing';
                    room.frameCount = 0; 
                    io.to(roomName).emit('startGame');
                }
            }
            sendRoomState(roomName);
            return;
        }

        if (room.status !== 'playing') return;

        const ball      = room.ball;
        const playerIds = Object.keys(room.players);
        if (playerIds.length < 2) { cleanupRoom(roomName); return; }

        const p1 = room.players[playerIds[0]]; // left
        const p2 = room.players[playerIds[1]]; // right

        const now = Date.now();
        const p1Height = (p1.paddleGrowUntil && p1.paddleGrowUntil > now) ? PADDLE_HEIGHT * 1.5 : PADDLE_HEIGHT;
        const p2Height = (p2.paddleGrowUntil && p2.paddleGrowUntil > now) ? PADDLE_HEIGHT * 1.5 : PADDLE_HEIGHT;

        // Power-up Üretimi
        if (!room.powerup.active && room.frameCount % 360 === 0 && Math.random() < 0.7) {
            room.powerup.x    = Math.random() * (CANVAS_WIDTH - 300) + 150;
            room.powerup.y    = Math.random() * (CANVAS_HEIGHT - 150) + 75;
            room.powerup.type = Math.random() < 0.5 ? 0 : 1; 
            room.powerup.active = true;
            io.to(roomName).emit('powerupSpawned', { x: room.powerup.x, y: room.powerup.y, type: room.powerup.type });
        }

        // Arena Olayları
        if (room.frameCount % 600 === 0 && !room.arenaEvent && Math.random() < 0.4) {
            const events = ['speedSurge', 'mirrorBall', 'gravityFlip'];
            const evt    = events[Math.floor(Math.random() * events.length)];
            room.arenaEvent = evt;
            io.to(roomName).emit('arenaEvent', { type: evt });

            room._arenaEventTimeout = setTimeout(() => {
                if (rooms[roomName]) {
                    rooms[roomName].arenaEvent = null;
                    io.to(roomName).emit('arenaEventEnd');
                }
            }, 5000);
        }

        // Top Hareketi
        const arenaSpeedMul = room.arenaEvent === 'speedSurge' ? 1.5 : 1.0;
        const speedMul      = (ball.currentSpeed / BASE_SPEED) * arenaSpeedMul;
        const stepsPerTick  = 60 / SERVER_TICK_RATE;

        for (let step = 0; step < stepsPerTick; step++) {
            ball.x += ball.dx * speedMul;
            ball.y += ball.dy * speedMul;

            if (room.arenaEvent === 'gravityFlip') {
                ball.y -= 0.15;
            }
        }

        // Duvar Çarpışması
        if (ball.y - BALL_RADIUS <= 0 || ball.y + BALL_RADIUS >= CANVAS_HEIGHT) {
            ball.dy *= -1;
            ball.y   = (ball.y - BALL_RADIUS <= 0) ? BALL_RADIUS : CANVAS_HEIGHT - BALL_RADIUS;
            io.to(roomName).emit('playSound', { type: 'wallHit', shake: false });
        }

        if (room.arenaEvent === 'mirrorBall') {
            if (ball.x - BALL_RADIUS <= 30 || ball.x + BALL_RADIUS >= CANVAS_WIDTH - 30) {
                ball.dx *= -1;
            }
        }

        // Sol Raket
        const leftEdge = 20 + PADDLE_WIDTH;
        if (ball.x - BALL_RADIUS <= leftEdge && ball.x + BALL_RADIUS >= 20 &&
            ball.y >= p1.y && ball.y <= p1.y + p1Height) {
            if (ball.dx < 0) {
                const hitPos = (ball.y - p1.y) / p1Height;
                const angle  = (hitPos - 0.5) * (Math.PI / 3);
                ball.dx = Math.abs(Math.cos(angle) * BASE_SPEED);
                ball.dy = Math.sin(angle) * BASE_SPEED;
                ball.x  = leftEdge + BALL_RADIUS;
                ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                ball.lastHit = 'left';
                room.stats.leftHits++;
                if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
            }
        }

        // Sağ Raket
        const rightEdge = CANVAS_WIDTH - 30;
        if (ball.x + BALL_RADIUS >= rightEdge && ball.x - BALL_RADIUS <= rightEdge + PADDLE_WIDTH &&
            ball.y >= p2.y && ball.y <= p2.y + p2Height) {
            if (ball.dx > 0) {
                const hitPos = (ball.y - p2.y) / p2Height;
                const angle  = (hitPos - 0.5) * (Math.PI / 3);
                ball.dx = -Math.abs(Math.cos(angle) * BASE_SPEED);
                ball.dy = Math.sin(angle) * BASE_SPEED;
                ball.x  = rightEdge - BALL_RADIUS;
                ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                ball.lastHit = 'right';
                room.stats.rightHits++;
                if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
            }
        }

        // Power-up
        if (room.powerup.active) {
            const dx = ball.x - room.powerup.x;
            const dy = ball.y - room.powerup.y;
            if (Math.sqrt(dx*dx + dy*dy) < BALL_RADIUS + 20) {
                room.powerup.active = false;
                const targetSide    = ball.lastHit || (ball.dx > 0 ? 'left' : 'right');

                if (room.powerup.type === 0) {
                    if (targetSide === 'left')  p1.paddleGrowUntil = now + 8000;
                    else                        p2.paddleGrowUntil = now + 8000;
                } else {
                    ball.currentSpeed = Math.min(ball.currentSpeed + 3.5, MAX_SPEED);
                }
                io.to(roomName).emit('powerupActivated', { type: room.powerup.type, side: targetSide });
                io.to(roomName).emit('playSound', { type: 'powerup', shake: true });
            }
        }

        // Skor
        let scored    = false;
        let scoringSide = null;
        if (ball.x < 0)                 { p2.score++; scored = true; scoringSide = 'right'; }
        else if (ball.x > CANVAS_WIDTH) { p1.score++; scored = true; scoringSide = 'left'; }

        if (scored) {
            io.to(roomName).emit('playSound', { type: 'score', shake: true });
            io.to(roomName).emit('scored', { side: scoringSide, left: p1.score, right: p2.score });

            if (p1.score >= MAX_SCORE || p2.score >= MAX_SCORE) {
                // Oyun Bitti
                room.status = 'gameOver';
                const winnerSide = p1.score >= MAX_SCORE ? 'left' : 'right';

                // Discord Log: Maç Bitişi
                const p1Profile = room.players[playerIds[0]].profile || {name: "Sol Oyuncu"};
                const p2Profile = room.players[playerIds[1]].profile || {name: "Sağ Oyuncu"};
                const winnerName = winnerSide === 'left' ? p1Profile.name : p2Profile.name;
                const loserName = winnerSide === 'left' ? p2Profile.name : p1Profile.name;
                const winScore = winnerSide === 'left' ? p1.score : p2.score;
                const loseScore = winnerSide === 'left' ? p2.score : p1.score;

                sendDiscordLog(
                    "🏆 Maç Sona Erdi!", 
                    `**${winnerName}** (${winScore}) rakibi **${loserName}** (${loseScore}) oyuncusunu mağlup etti!`, 
                    0x00ff00
                );

                playerIds.forEach(pid => {
                    const player = room.players[pid];
                    io.to(pid).emit('gameOver', {
                        winner: winnerSide,
                        credits: player.side === winnerSide ? 100 : 30,
                        stats: {
                            maxSpeed : Math.round(room.stats.maxSpeed * 10) / 10,
                            totalHits: room.stats.leftHits + room.stats.rightHits,
                            yourHits : player.side === 'left' ? room.stats.leftHits : room.stats.rightHits,
                            leftScore : p1.score,
                            rightScore: p2.score
                        }
                    });
                });

                clearInterval(room.interval);
                room.interval = null;

                room._rematchTimeout = setTimeout(() => {
                    if (rooms[roomName] && rooms[roomName].status === 'gameOver') {
                        cleanupRoom(roomName);
                    }
                }, REMATCH_WINDOW);

                return;
            } else {
                room.arenaEvent = null; 
                resetBall(room);
            }
        }

        sendRoomState(roomName);
    }, TICK_INTERVAL);
}

function sendRoomState(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    const ball = room.ball;
    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return;
    const p1  = room.players[playerIds[0]];
    const p2  = room.players[playerIds[1]];
    const now = Date.now();

    io.to(roomName).emit('gs', {
        b: [
            Math.round(ball.x * 10) / 10,
            Math.round(ball.y * 10) / 10,
            Math.round(ball.dx * 100) / 100,
            Math.round(ball.dy * 100) / 100,
            Math.round(ball.currentSpeed * 100) / 100,
            ball.lastHit === 'left' ? 0 : ball.lastHit === 'right' ? 1 : 2
        ],
        p: [
            Math.round(p1.y), p1.score, (p1.paddleGrowUntil > now ? 1 : 0),
            Math.round(p2.y), p2.score, (p2.paddleGrowUntil > now ? 1 : 0)
        ],
        pw: [
            room.powerup.active ? 1 : 0,
            Math.round(room.powerup.x), Math.round(room.powerup.y),
            room.powerup.type
        ],
        ae: room.arenaEvent || null,
        st: room.status,
        c : room.countdown,
        f : room.frameCount,
        t : now
    });
}

// ─── Socket.io Bağlantıları ───────────────────────────────────────────────────
io.on('connection', (socket) => {
    
    socket.on('joinMatchmaking', (profile) => {
        if (!profile || !profile.name) return;
        if (findRoomBySocketId(socket.id)) return;
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) return;

        if (waitingPlayer) {
            const roomName = 'room_' + roomCounter++;
            rooms[roomName] = createRoomState();
            initMatch(roomName, waitingPlayer.socket, waitingPlayer.profile, socket, profile);
            waitingPlayer = null;
        } else {
            waitingPlayer = { socket, profile };
            socket.emit('waiting', 'Siber Arena İçin Rakip Aranıyor...');
        }
    });

    socket.on('cancelMatchmaking', () => {
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) waitingPlayer = null;
    });

    socket.on('createPrivateRoom', (profile) => {
        if (!profile || !profile.name) return;
        if (findRoomBySocketId(socket.id)) return;
        const code     = generateRoomCode();
        const roomName = 'private_' + code;
        rooms[roomName]        = createRoomState();
        rooms[roomName].hostSocket  = socket;
        rooms[roomName].hostProfile = profile;
        privateRooms[code]     = roomName;
        socket.emit('privateRoomCreated', { code });
    });

    socket.on('joinPrivateRoom', (data) => {
        if (!data || !data.code || !data.profile) return;
        const code     = data.code.toUpperCase().trim();
        const roomName = privateRooms[code];
        if (!roomName || !rooms[roomName]) { socket.emit('privateRoomError', 'Oda bulunamadı!'); return; }
        const room = rooms[roomName];
        if (room.status !== 'waiting') { socket.emit('privateRoomError', 'Oda dolu veya maç başlamış.'); return; }
        if (!room.hostSocket || !room.hostSocket.connected) {
            cleanupRoom(roomName);
            socket.emit('privateRoomError', 'Oda sahibi ayrıldı.');
            return;
        }
        initMatch(roomName, room.hostSocket, room.hostProfile, socket, data.profile);
        delete room.hostSocket;
        delete room.hostProfile;
    });

    socket.on('cancelPrivateRoom', () => {
        for (const code in privateRooms) {
            const rn   = privateRooms[code];
            const room = rooms[rn];
            if (room && room.hostSocket && room.hostSocket.id === socket.id) {
                cleanupRoom(rn);
                break;
            }
        }
    });

    socket.on('move', (data) => {
        if (typeof data.y !== 'number' || isNaN(data.y)) return;
        const roomName = findRoomBySocketId(socket.id);
        if (!roomName || !rooms[roomName]) return;
        const room = rooms[roomName];
        if (room.status === 'playing' || room.status === 'countdown') {
            room.players[socket.id].y = Math.max(0, Math.min(data.y, CANVAS_HEIGHT - PADDLE_HEIGHT));
        }
    });

    socket.on('sendEmote', (emote) => {
        const ALLOWED_EMOTES = ['🔥','😎','💀','⚡','👍','😂','🎯','💥'];
        if (!ALLOWED_EMOTES.includes(emote)) return;
        const roomName = findRoomBySocketId(socket.id);
        if (roomName && rooms[roomName]) {
            const room = rooms[roomName];
            const player = room.players[socket.id];
            if (player) {
                io.to(roomName).emit('receiveEmote', { side: player.side, emote });
            }
        }
    });

    socket.on('requestRematch', () => {
        const roomName = findRoomBySocketId(socket.id);
        if (!roomName || !rooms[roomName]) return;
        const room = rooms[roomName];

        if (room.status !== 'gameOver') return;

        room.rematchRequests[socket.id] = true;
        const playerIds  = Object.keys(room.players);
        const opponentId = playerIds.find(id => id !== socket.id);

        if (opponentId && room.rematchRequests[opponentId]) {
            if (room._rematchTimeout) { clearTimeout(room._rematchTimeout); room._rematchTimeout = null; }

            room.rematchRequests = {};
            room.status          = 'countdown';
            room.countdown       = 3;
            room.frameCount      = 0;
            room.powerup.active  = false;
            room.arenaEvent      = null;
            room.stats           = { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 };
            room.ball            = { x: CANVAS_WIDTH/2, y: CANVAS_HEIGHT/2, dx:0, dy:0, currentSpeed: BASE_SPEED, lastHit: null };

            playerIds.forEach(pid => {
                room.players[pid].score          = 0;
                room.players[pid].y              = 250;
                room.players[pid].paddleGrowUntil = 0;
            });
            resetBall(room);
            io.to(roomName).emit('rematchStarted');
            io.to(roomName).emit('countdownUpdate', room.countdown);

            startGameLoop(roomName);
        } else if (opponentId) {
            io.to(opponentId).emit('opponentRequestedRematch');
        }
    });

    socket.on('declineRematch', () => {
        const roomName = findRoomBySocketId(socket.id);
        if (!roomName) return;
        const room = rooms[roomName];
        if (!room || room.status !== 'gameOver') return;

        let opponentId = null;
        for (const pid in room.players) {
            if (pid !== socket.id) opponentId = pid;
        }

        if (opponentId) {
            io.to(opponentId).emit('rematchDeclined');
        }
        cleanupRoom(roomName);
    });

    socket.on('startSingleplayer', (difficulty) => {
        singleplayerSessions[socket.id] = { startTime: Date.now(), difficulty };
    });

    socket.on('singleplayerResult', (data) => {
        if (!data || !data.win === undefined || !data.difficulty) return;
        const session = singleplayerSessions[socket.id];
        if (!session || session.difficulty !== data.difficulty) {
            socket.emit('singleplayerReward', { error: 'Geçersiz oturum.' });
            return;
        }
        let rewardXp = 0, rewardCoins = 0, caseChance = 0;
        if (data.difficulty === 'easy')   { rewardXp = data.win ? 45 : 15;   rewardCoins = data.win ? 30 : 9;   caseChance = 0.01; }
        else if (data.difficulty === 'medium') { rewardXp = data.win ? 105 : 35; rewardCoins = data.win ? 70 : 21;  caseChance = 0.04; }
        else if (data.difficulty === 'hard')   { rewardXp = data.win ? 180 : 60; rewardCoins = data.win ? 120 : 36; caseChance = 0.12; }

        let caseDropped = data.win && Math.random() < caseChance;
        delete singleplayerSessions[socket.id];
        socket.emit('singleplayerReward', {
            xp_granted: rewardXp, coins_granted: rewardCoins,
            case_dropped: caseDropped, difficulty: data.difficulty
        });
    });

    socket.on('reportStats', (data) => {
        if (!data || !data.name || typeof data.xp !== 'number') return;
        updateLeaderboard(data.name, data.xp, data.level || 1);
    });

    socket.on('getLeaderboard', () => socket.emit('leaderboardData', getTop10()));

    socket.on('sendGlobalMessage', (data) => {
        if (!data || !data.name || !data.message) return;
        const msgStr = data.message.trim().substring(0, 100);
        if (!msgStr) return;
        const msgObj = { id: Date.now() + Math.random(), name: data.name, title: data.title || '', message: msgStr, time: Date.now() };
        chatHistory.push(msgObj);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('receiveGlobalMessage', msgObj);

        // Discord Log: Global Chat mesajları
        sendDiscordLog("💬 Global Chat", `**[${data.title || 'Oyuncu'}] ${data.name}:** ${msgStr}`, 0x888888);
    });

    socket.on('getChatHistory', () => socket.emit('chatHistory', chatHistory));

    socket.on('ping_check', (ts) => { socket.emit('pong_check', ts); });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) waitingPlayer = null;
        delete singleplayerSessions[socket.id];

        for (const code in privateRooms) {
            const rn   = privateRooms[code];
            const room = rooms[rn];
            if (room && room.hostSocket && room.hostSocket.id === socket.id && room.status === 'waiting') {
                cleanupRoom(rn);
            }
        }

        const roomName = findRoomBySocketId(socket.id);
        if (roomName && rooms[roomName]) {
            const room = rooms[roomName];
            if (room.status === 'gameOver') {
                io.to(roomName).emit('rematchUnavailable');
            } else {
                io.to(roomName).emit('opponentLeft');
            }
            cleanupRoom(roomName);
        }
    });
});

// ─── Sunucu Başlat ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`⚡ Cyber Pong Sunucusu Aktif: http://localhost:${PORT}`);
    // Discord Log: Sunucu Başlatıldı
    sendDiscordLog("🚀 Sunucu Başlatıldı", `Cyber Pong sunucusu port ${PORT} üzerinde aktif hale geldi. Sistem çevrimiçi!`, 0xffaa00);
});