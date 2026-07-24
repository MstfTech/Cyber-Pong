// ═══════════════════════════════════════════════════════════════════════════
// CYBER PONG v4.0 — server.js  (Mega Update: Telegram + NVIDIA NIM AI + Achievements)
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
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
app.use(express.json());

const https = require('https');

// ─── Environment Variables ────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1517560647674499133/27Hu13fCJc9but-U11750f-WbqLq1MXArWBGp6jt9KFS2bMs5MRVT4gXN7hH06tXFAfN";
const NVIDIA_NIM_API_KEY  = process.env.NVIDIA_NIM_API_KEY  || "";
const TELEGRAM_TOKEN      = process.env.TELEGRAM_TOKEN      || "";
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID    || "";

// ─── Load .env manually (no dotenv dependency) ───────────────────────────────
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) return;
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        });
    }
} catch(e) { console.log('Could not load .env:', e.message); }

// Re-read after .env load
const _NVIDIA_KEY   = process.env.NVIDIA_NIM_API_KEY  || NVIDIA_NIM_API_KEY;
const _TG_TOKEN     = process.env.TELEGRAM_TOKEN       || TELEGRAM_TOKEN;
const _TG_CHAT_ID   = process.env.TELEGRAM_CHAT_ID     || TELEGRAM_CHAT_ID;
const _DISCORD_URL  = process.env.DISCORD_WEBHOOK_URL  || DISCORD_WEBHOOK_URL;

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

// ─── Yetenek Sabitleri ────────────────────────────────────────────────────────
const ABILITY_DEFS = {
    cyber_shield: { cost: 40, duration: 2500, cooldown: 8000 },
    chrono_pulse: { cost: 60, duration: 2000, cooldown: 10000 },
    data_glitch:  { cost: 35, duration: 1500, cooldown: 6000  }
};
const CREDIT_PER_HIT        = 10;
const MIN_SPEED_FOR_CREDITS = BASE_SPEED * 0.6;

// ─── Server Stats ─────────────────────────────────────────────────────────────
let serverStats = {
    totalGamesPlayed: 0,
    totalGamesToday: 0,
    uniquePlayersToday: new Set(),
    topPlayerToday: { name: '', xp: 0 },
    lastDailyReset: Date.now(),
    onlinePlayers: 0
};

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

// ═══════════════════════════════════════════════════════════════════════════
// Discord Webhook
// ═══════════════════════════════════════════════════════════════════════════
async function sendDiscordLog(title, message, color = 0x00ff00) {
    if (!_DISCORD_URL) return;

    try {
        const payload = JSON.stringify({
            embeds: [{
                title: title,
                description: message,
                color: color,
                timestamp: new Date().toISOString()
            }]
        });

        const url = new URL(_DISCORD_URL);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                console.log("Discord webhook başarısız oldu:", res.statusCode);
            }
        });

        req.on('error', (err) => {
            console.log("Discord webhook ağ hatası:", err.message);
        });

        req.write(payload);
        req.end();
    } catch (err) {
        console.log("Discord webhook hatası:", err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Bot Integration
// ═══════════════════════════════════════════════════════════════════════════
function sendTelegramMessage(text, parseMode = 'HTML') {
    if (!_TG_TOKEN || !_TG_CHAT_ID) return;

    try {
        const payload = JSON.stringify({
            chat_id: _TG_CHAT_ID,
            text: text,
            parse_mode: parseMode
        });

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${_TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    console.log("Telegram mesaj hatası:", res.statusCode, data);
                }
            });
        });

        req.on('error', (err) => {
            console.log("Telegram ağ hatası:", err.message);
        });

        req.write(payload);
        req.end();
    } catch (err) {
        console.log("Telegram hatası:", err.message);
    }
}

function telegramMatchStart(p1Name, p2Name) {
    sendTelegramMessage(
        `⚔️ <b>Maç Başladı!</b>\n` +
        `🎮 <b>${p1Name}</b> vs <b>${p2Name}</b>\n` +
        `🕐 ${new Date().toLocaleTimeString('tr-TR')}`
    );
}

function telegramMatchEnd(winnerName, loserName, winScore, loseScore, stats) {
    const maxSpd = stats.maxSpeed ? stats.maxSpeed.toFixed(1) : '?';
    const totalHits = (stats.leftHits || 0) + (stats.rightHits || 0);
    sendTelegramMessage(
        `🏆 <b>Maç Bitti!</b>\n\n` +
        `👑 Kazanan: <b>${winnerName}</b>\n` +
        `💀 Kaybeden: <b>${loserName}</b>\n` +
        `📊 Skor: <b>${winScore} - ${loseScore}</b>\n` +
        `⚡ Max Hız: <b>${maxSpd}</b>\n` +
        `🎯 Toplam Vuruş: <b>${totalHits}</b>\n` +
        `👥 Aktif Oyuncu: <b>${serverStats.onlinePlayers}</b>`
    );
}

function telegramMilestone(playerName, milestone, detail) {
    sendTelegramMessage(
        `🌟 <b>Kilometre Taşı!</b>\n\n` +
        `🎮 <b>${playerName}</b> ${milestone}\n` +
        `${detail}`
    );
}

function telegramDailyStats() {
    sendTelegramMessage(
        `📊 <b>Günlük İstatistikler</b>\n\n` +
        `🎮 Bugün Oynanan Maç: <b>${serverStats.totalGamesToday}</b>\n` +
        `👥 Tekil Oyuncu: <b>${serverStats.uniquePlayersToday.size}</b>\n` +
        `🏆 Günün Oyuncusu: <b>${serverStats.topPlayerToday.name || '—'}</b>\n` +
        `📈 Toplam Maç (tüm zamanlar): <b>${serverStats.totalGamesPlayed}</b>\n` +
        `👤 Şu An Online: <b>${serverStats.onlinePlayers}</b>`
    );
}

// Daily stats reset (every 24h)
setInterval(() => {
    const now = Date.now();
    if (now - serverStats.lastDailyReset > 86400000) {
        telegramDailyStats();
        serverStats.totalGamesToday = 0;
        serverStats.uniquePlayersToday = new Set();
        serverStats.topPlayerToday = { name: '', xp: 0 };
        serverStats.lastDailyReset = now;
    }
}, 3600000); // Check every hour

// ═══════════════════════════════════════════════════════════════════════════
// NVIDIA NIM AI Commentary
// ═══════════════════════════════════════════════════════════════════════════
let lastAICallTime = 0;
const AI_RATE_LIMIT_MS = 5000; // Min 5s between calls

async function generateAICommentary(matchData) {
    if (!_NVIDIA_KEY) return null;
    
    const now = Date.now();
    if (now - lastAICallTime < AI_RATE_LIMIT_MS) return null;
    lastAICallTime = now;

    return new Promise((resolve) => {
        try {
            const prompt = `You are a futuristic cyber sports commentator for "Cyber Pong", a neon-themed competitive pong game. Generate a SHORT (2-3 sentences max), exciting, witty match commentary in TURKISH. Use cyber/neon themed language. Be dramatic and fun.

Match Data:
- Winner: ${matchData.winnerName}
- Loser: ${matchData.loserName}  
- Score: ${matchData.winScore}-${matchData.loseScore}
- Max Ball Speed: ${matchData.maxSpeed}
- Total Hits: ${matchData.totalHits}
- Winner's Hits: ${matchData.winnerHits}

Generate commentary:`;

            const payload = JSON.stringify({
                model: "meta/llama-3.1-8b-instruct",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.9,
                max_tokens: 150
            });

            const options = {
                hostname: 'integrate.api.nvidia.com',
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_NVIDIA_KEY}`,
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const commentary = json.choices?.[0]?.message?.content || null;
                        resolve(commentary);
                    } catch(e) {
                        console.log("NIM parse hatası:", e.message);
                        resolve(null);
                    }
                });
            });

            req.on('error', (err) => {
                console.log("NIM ağ hatası:", err.message);
                resolve(null);
            });

            // 10s timeout
            req.setTimeout(10000, () => {
                req.destroy();
                resolve(null);
            });

            req.write(payload);
            req.end();
        } catch (err) {
            console.log("NIM hatası:", err.message);
            resolve(null);
        }
    });
}

// AI Chat Bot for global chat
async function generateAIChatReply(playerName, message) {
    if (!_NVIDIA_KEY) return null;

    const now = Date.now();
    if (now - lastAICallTime < AI_RATE_LIMIT_MS) return null;
    lastAICallTime = now;

    return new Promise((resolve) => {
        try {
            const prompt = `You are "NEON", a friendly AI bot in "Cyber Pong" game's global chat. You speak both Turkish and English, matching the language of the player. Keep responses SHORT (1-2 sentences), fun, and cyber/gaming themed. Be encouraging and witty.

Player "${playerName}" says: "${message}"

Your reply as NEON:`;

            const payload = JSON.stringify({
                model: "meta/llama-3.1-8b-instruct",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.8,
                max_tokens: 80
            });

            const options = {
                hostname: 'integrate.api.nvidia.com',
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_NVIDIA_KEY}`,
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const reply = json.choices?.[0]?.message?.content || null;
                        resolve(reply ? reply.trim().substring(0, 150) : null);
                    } catch(e) {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => { req.destroy(); resolve(null); });
            req.write(payload);
            req.end();
        } catch (err) {
            resolve(null);
        }
    });
}

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
        stats: { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 },
        countdown: 3,
        rematchRequests: {},
        interval: null,
        _rematchTimeout: null,
        _arenaEventTimeout: null,
        status: 'waiting',
        frameCount: 0,
        arenaEvent: null,
        // Yetenek & Ekonomi
        matchCredits: {},       // { socketId: number }
        abilities: {},          // { socketId: { shield, chrono, glitch } each: { activeUntil, cooldownUntil } }
        chronoZone: null,       // { side: 'left'|'right', until: timestamp }
        rallyCount: 0           // v4: hit counter for rally tracking
    };
}

function resetBall(room) {
    room.ball.x = CANVAS_WIDTH / 2;
    room.ball.y = CANVAS_HEIGHT / 2;
    room.ball.currentSpeed = BASE_SPEED;
    room.ball.lastHit = null;
    room.rallyCount = 0;

    const signX    = Math.random() < 0.5 ? 1 : -1;
    const signY    = Math.random() < 0.5 ? 1 : -1;
    const minAngle = Math.PI / 6;
    const maxAngle = Math.PI / 3;
    const angle    = Math.random() * (maxAngle - minAngle) + minAngle;
    room.ball.dx   = Math.cos(angle) * BASE_SPEED * signX;
    room.ball.dy   = Math.sin(angle) * BASE_SPEED * signY;
}

// ─── Maç Başlatma ─────────────────────────────────────────────────────────────
function createAbilityState() {
    return {
        cyber_shield: { activeUntil: 0, cooldownUntil: 0 },
        chrono_pulse: { activeUntil: 0, cooldownUntil: 0 },
        data_glitch:  { activeUntil: 0, cooldownUntil: 0 }
    };
}

function initMatch(roomName, socket1, profile1, socket2, profile2) {
    const room = rooms[roomName];
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
    room.rallyCount = 0;
    // Reset match economy & abilities
    room.matchCredits = { [socket1.id]: 0, [socket2.id]: 0 };
    room.abilities    = { [socket1.id]: createAbilityState(), [socket2.id]: createAbilityState() };
    room.chronoZone   = null;

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

    // Telegram: Maç başladı
    telegramMatchStart(profile1.name, profile2.name);

    // Track server stats
    serverStats.totalGamesPlayed++;
    serverStats.totalGamesToday++;
    serverStats.uniquePlayersToday.add(profile1.name);
    serverStats.uniquePlayersToday.add(profile2.name);

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

        // ── Yetenek Süresi Kontrolü ──────────────────────────────────────────────
        playerIds.forEach(pid => {
            const ab = room.abilities[pid];
            if (!ab) return;
            if (ab.cyber_shield.activeUntil && now > ab.cyber_shield.activeUntil) {
                ab.cyber_shield.activeUntil = 0;
                room.players[pid].paddleGrowUntil = 0;
            }
            if (ab.chrono_pulse.activeUntil && now > ab.chrono_pulse.activeUntil) {
                ab.chrono_pulse.activeUntil = 0;
                if (room.chronoZone && room.chronoZone.owner === pid) room.chronoZone = null;
            }
            if (ab.data_glitch.activeUntil && now > ab.data_glitch.activeUntil) {
                ab.data_glitch.activeUntil = 0;
            }
        });

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
        let   chronoMul     = 1.0;
        if (room.chronoZone && now < room.chronoZone.until) {
            const cz    = room.chronoZone;
            const ballX = ball.x;
            if (cz.side === 'left'  && ballX < CANVAS_WIDTH / 2) chronoMul = 0.7;
            if (cz.side === 'right' && ballX > CANVAS_WIDTH / 2) chronoMul = 0.7;
        }
        const speedMul  = (ball.currentSpeed / BASE_SPEED) * arenaSpeedMul * chronoMul;
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
                room.rallyCount++;
                if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                // +10 Maç kredisi (anti-farming: minimum hız kontrolü)
                if (ball.currentSpeed >= MIN_SPEED_FOR_CREDITS) {
                    room.matchCredits[playerIds[0]] = (room.matchCredits[playerIds[0]] || 0) + CREDIT_PER_HIT;
                    io.to(playerIds[0]).emit('credits_update', { credits: room.matchCredits[playerIds[0]] });
                }
                io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
                io.to(roomName).emit('rallyUpdate', { count: room.rallyCount });
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
                room.rallyCount++;
                if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                // +10 Maç kredisi (anti-farming: minimum hız kontrolü)
                if (ball.currentSpeed >= MIN_SPEED_FOR_CREDITS) {
                    room.matchCredits[playerIds[1]] = (room.matchCredits[playerIds[1]] || 0) + CREDIT_PER_HIT;
                    io.to(playerIds[1]).emit('credits_update', { credits: room.matchCredits[playerIds[1]] });
                }
                io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
                io.to(roomName).emit('rallyUpdate', { count: room.rallyCount });
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

                const p1Profile = room.players[playerIds[0]].profile || {name: "Sol Oyuncu"};
                const p2Profile = room.players[playerIds[1]].profile || {name: "Sağ Oyuncu"};
                const winnerName = winnerSide === 'left' ? p1Profile.name : p2Profile.name;
                const loserName = winnerSide === 'left' ? p2Profile.name : p1Profile.name;
                const winScore = winnerSide === 'left' ? p1.score : p2.score;
                const loseScore = winnerSide === 'left' ? p2.score : p1.score;
                const winnerHits = winnerSide === 'left' ? room.stats.leftHits : room.stats.rightHits;

                // Discord Log: Maç Bitişi
                sendDiscordLog(
                    "🏆 Maç Sona Erdi!", 
                    `**${winnerName}** (${winScore}) rakibi **${loserName}** (${loseScore}) oyuncusunu mağlup etti!`, 
                    0x00ff00
                );

                // Telegram: Maç bitişi
                telegramMatchEnd(winnerName, loserName, winScore, loseScore, room.stats);

                // AI Commentary (async, non-blocking)
                generateAICommentary({
                    winnerName, loserName, winScore, loseScore,
                    maxSpeed: room.stats.maxSpeed,
                    totalHits: room.stats.leftHits + room.stats.rightHits,
                    winnerHits
                }).then(commentary => {
                    if (commentary) {
                        playerIds.forEach(pid => {
                            io.to(pid).emit('aiCommentary', { text: commentary });
                        });
                        // Also post to global chat
                        const aiMsg = { id: Date.now(), name: '🤖 NEON AI', title: 'Yorumcu', message: commentary.substring(0, 200), time: Date.now() };
                        chatHistory.push(aiMsg);
                        if (chatHistory.length > 50) chatHistory.shift();
                        io.emit('receiveGlobalMessage', aiMsg);
                    }
                }).catch(() => {});

                // Perfect win check
                const isPerfect = loseScore === 0;

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
                            rightScore: p2.score,
                            isPerfect: isPerfect && player.side === winnerSide
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

    // Yetenek durumlarını her oyuncuya ayrı gönder
    playerIds.forEach(pid => {
        const ab  = room.abilities[pid] || {};
        const opp = playerIds.find(id => id !== pid);
        const oppAb = room.abilities[opp] || {};
        io.to(pid).emit('gs', {
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
            ae: room.arenaEvent || null,
            st: room.status,
            c : room.countdown,
            f : room.frameCount,
            t : now,
            rc: room.rallyCount || 0,
            // Yetenek durumları (my side + opponent side)
            ab: {
                my:  {
                    shield_active: (ab.cyber_shield?.activeUntil  || 0) > now,
                    chrono_active: (ab.chrono_pulse?.activeUntil  || 0) > now,
                    glitch_active: (ab.data_glitch?.activeUntil   || 0) > now,
                    shield_cd:  Math.max(0, (ab.cyber_shield?.cooldownUntil || 0) - now),
                    chrono_cd:  Math.max(0, (ab.chrono_pulse?.cooldownUntil || 0) - now),
                    glitch_cd:  Math.max(0, (ab.data_glitch?.cooldownUntil  || 0) - now)
                },
                opp: {
                    shield_active: (oppAb.cyber_shield?.activeUntil || 0) > now,
                    chrono_active: (oppAb.chrono_pulse?.activeUntil || 0) > now
                },
                chrono_side: room.chronoZone ? room.chronoZone.side : null
            }
        });
    });
}

// ─── Online Player Count ──────────────────────────────────────────────────────
function broadcastOnlineCount() {
    io.emit('onlineCount', { count: serverStats.onlinePlayers });
}

// ─── Socket.io Bağlantıları ───────────────────────────────────────────────────
io.on('connection', (socket) => {
    serverStats.onlinePlayers++;
    broadcastOnlineCount();

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

    // ─── Yetenek Kullanımı ────────────────────────────────────────────────────
    socket.on('use_ability', (data) => {
        if (!data || !data.type) return;
        const roomName = findRoomBySocketId(socket.id);
        if (!roomName || !rooms[roomName]) return;
        const room = rooms[roomName];
        if (room.status !== 'playing') return;

        const def = ABILITY_DEFS[data.type];
        if (!def) return;

        const playerCredits = room.matchCredits[socket.id] || 0;
        if (playerCredits < def.cost) {
            io.to(socket.id).emit('ability_error', { msg: 'Yetersiz Siber Kredi!' });
            return;
        }

        const ab  = room.abilities[socket.id];
        const now = Date.now();
        if (!ab || (ab[data.type].cooldownUntil || 0) > now) {
            io.to(socket.id).emit('ability_error', { msg: 'Bekleme süresi dolmadı!' });
            return;
        }

        // Krediyi düş
        room.matchCredits[socket.id] -= def.cost;
        io.to(socket.id).emit('credits_update', { credits: room.matchCredits[socket.id] });

        // Yeteneği etkinleştir
        ab[data.type].activeUntil  = now + def.duration;
        ab[data.type].cooldownUntil = now + def.cooldown;

        const player   = room.players[socket.id];
        const playerIds = Object.keys(room.players);
        const opponentId = playerIds.find(id => id !== socket.id);

        if (data.type === 'cyber_shield') {
            player.paddleGrowUntil = now + def.duration;
        }
        if (data.type === 'chrono_pulse') {
            room.chronoZone = { side: player.side, owner: socket.id, until: now + def.duration };
        }
        if (data.type === 'data_glitch' && opponentId) {
            io.to(opponentId).emit('ability_activated', {
                type: 'data_glitch', side: player.side, duration: def.duration
            });
        }

        // Tüm odaya telegraph bildir (rakip de görür)
        io.to(roomName).emit('ability_activated', {
            type: data.type, side: player.side, duration: def.duration
        });
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
            room.arenaEvent      = null;
            room.stats           = { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 };
            room.ball            = { x: CANVAS_WIDTH/2, y: CANVAS_HEIGHT/2, dx:0, dy:0, currentSpeed: BASE_SPEED, lastHit: null };
            room.rallyCount      = 0;
            // Rövanşta yetenek & kredi resetle
            room.matchCredits = {};
            room.abilities    = {};
            room.chronoZone   = null;
            playerIds.forEach(pid => {
                room.matchCredits[pid] = 0;
                room.abilities[pid]    = createAbilityState();
                io.to(pid).emit('credits_update', { credits: 0 });
            });

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
        // Track top player of the day
        if (data.xp > serverStats.topPlayerToday.xp) {
            serverStats.topPlayerToday = { name: data.name, xp: data.xp };
        }
    });

    socket.on('getLeaderboard', () => socket.emit('leaderboardData', getTop10()));

    socket.on('sendGlobalMessage', async (data) => {
        if (!data || !data.name || !data.message) return;
        const msgStr = data.message.trim().substring(0, 100);
        if (!msgStr) return;
        const msgObj = { id: Date.now() + Math.random(), name: data.name, title: data.title || '', message: msgStr, time: Date.now() };
        chatHistory.push(msgObj);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('receiveGlobalMessage', msgObj);

        // Discord Log: Global Chat mesajları
        sendDiscordLog("💬 Global Chat", `**[${data.title || 'Oyuncu'}] ${data.name}:** ${msgStr}`, 0x888888);

        // AI Bot: respond if mentioned with @bot or @ai or @neon
        const lowerMsg = msgStr.toLowerCase();
        if (lowerMsg.includes('@bot') || lowerMsg.includes('@ai') || lowerMsg.includes('@neon')) {
            const aiReply = await generateAIChatReply(data.name, msgStr);
            if (aiReply) {
                const aiMsg = { id: Date.now() + Math.random(), name: '🤖 NEON', title: 'AI Bot', message: aiReply, time: Date.now() };
                chatHistory.push(aiMsg);
                if (chatHistory.length > 50) chatHistory.shift();
                io.emit('receiveGlobalMessage', aiMsg);
            }
        }
    });

    socket.on('getChatHistory', () => socket.emit('chatHistory', chatHistory));

    // ─── Get Server Stats ─────────────────────────────────────────────────────
    socket.on('getServerStats', () => {
        socket.emit('serverStats', {
            online: serverStats.onlinePlayers,
            totalGames: serverStats.totalGamesPlayed,
            gamesToday: serverStats.totalGamesToday,
            topPlayer: serverStats.topPlayerToday.name || '—'
        });
    });

    socket.on('ping_check', (ts) => { socket.emit('pong_check', ts); });

    socket.on('disconnect', () => {
        serverStats.onlinePlayers = Math.max(0, serverStats.onlinePlayers - 1);
        broadcastOnlineCount();

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
    console.log(`⚡ Cyber Pong v4.0 Sunucusu Aktif: http://localhost:${PORT}`);
    // Discord Log: Sunucu Başlatıldı
    sendDiscordLog("🚀 Sunucu Başlatıldı", `Cyber Pong v4.0 sunucusu port ${PORT} üzerinde aktif hale geldi. Mega Update yüklendi!`, 0xffaa00);
    // Telegram: Sunucu Başlatıldı
    sendTelegramMessage(
        `🚀 <b>Cyber Pong v4.0 Aktif!</b>\n` +
        `🌐 Port: <b>${PORT}</b>\n` +
        `📡 Mega Update yüklendi!\n` +
        `🕐 ${new Date().toLocaleString('tr-TR')}`
    );
});