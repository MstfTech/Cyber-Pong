const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 5000,
    maxHttpBufferSize: 1e4
});

app.use(express.static(__dirname));

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const MAX_SCORE = 5;
const BASE_SPEED = 5;
const MAX_SPEED = 18;
const SPEED_INCREMENT = 0.6;
const PADDLE_HEIGHT = 100;
const PADDLE_WIDTH = 12;
const BALL_RADIUS = 8;
const SERVER_TICK_RATE = 30;
const TICK_INTERVAL = 1000 / SERVER_TICK_RATE;

let waitingPlayer = null;
let rooms = {};
let roomCounter = 0;
let privateRooms = {};
let singleplayerSessions = {};

const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = [];
let chatHistory = [];

function loadLeaderboard() {
    try {
        if (fs.existsSync(LEADERBOARD_FILE)) {
            const data = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
            leaderboard = JSON.parse(data);
        }
    } catch (e) {
        leaderboard = [];
    }
}

function saveLeaderboard() {
    try {
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard), 'utf8');
    } catch (e) {
        console.error('Leaderboard kayıt hatası:', e.message);
    }
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

function getTop10() {
    return leaderboard.slice(0, 10);
}

loadLeaderboard();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (privateRooms[code]);
    return code;
}

function findRoomBySocketId(socketId) {
    for (const rn in rooms) {
        if (rooms[rn].players && rooms[rn].players[socketId]) return rn;
    }
    return null;
}

function cleanupRoom(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    if (room.interval) {
        clearInterval(room.interval);
        room.interval = null;
    }
    for (const code in privateRooms) {
        if (privateRooms[code] === roomName) {
            delete privateRooms[code];
            break;
        }
    }
    delete rooms[roomName];
}

function createRoomState() {
    return {
        players: {},
        ball: {
            x: CANVAS_WIDTH / 2,
            y: CANVAS_HEIGHT / 2,
            dx: 0, dy: 0,
            currentSpeed: BASE_SPEED,
            lastHit: null
        },
        powerup: {
            x: 0, y: 0,
            type: 0, // 0: GROW, 1: SPEED
            active: false
        },
        stats: {
            maxSpeed: BASE_SPEED,
            leftHits: 0,
            rightHits: 0
        },
        countdown: 3,
        rematchRequests: {},
        interval: null,
        status: 'waiting',
        lastState: null,
        frameCount: 0
    };
}

function initMatch(roomName, socket1, profile1, socket2, profile2) {
    const room = rooms[roomName];
    room.players = {
        [socket1.id]: { y: 250, side: 'left', score: 0, lastY: 250, paddleGrowUntil: 0 },
        [socket2.id]: { y: 250, side: 'right', score: 0, lastY: 250, paddleGrowUntil: 0 }
    };
    room.status = 'countdown';
    room.countdown = 3;
    room.ball = {
        x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2,
        dx: 0, dy: 0,
        currentSpeed: BASE_SPEED, lastHit: null
    };
    room.stats = { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 };
    room.rematchRequests = {};
    room.frameCount = 0;

    resetBall(room);

    socket1.join(roomName);
    socket2.join(roomName);

    io.to(socket1.id).emit('init', { side: 'left', opponent: profile2 });
    io.to(socket2.id).emit('init', { side: 'right', opponent: profile1 });
    io.to(roomName).emit('countdownUpdate', room.countdown);

    startGameLoop(roomName);
}

io.on('connection', (socket) => {
    console.log('Bağlandı:', socket.id);

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

    socket.on('createPrivateRoom', (profile) => {
        if (!profile || !profile.name) return;
        if (findRoomBySocketId(socket.id)) return;

        const code = generateRoomCode();
        const roomName = 'private_' + code;
        rooms[roomName] = createRoomState();
        rooms[roomName].hostSocket = socket;
        rooms[roomName].hostProfile = profile;
        privateRooms[code] = roomName;

        socket.emit('privateRoomCreated', { code });
    });

    socket.on('joinPrivateRoom', (data) => {
        if (!data || !data.code || !data.profile) return;
        const code = data.code.toUpperCase().trim();
        const roomName = privateRooms[code];

        if (!roomName || !rooms[roomName]) {
            socket.emit('privateRoomError', 'Oda bulunamadı!');
            return;
        }

        const room = rooms[roomName];
        if (room.status !== 'waiting') {
            socket.emit('privateRoomError', 'Oda dolu veya maç başlamış.');
            return;
        }

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
            const roomName = privateRooms[code];
            const room = rooms[roomName];
            if (room && room.hostSocket && room.hostSocket.id === socket.id) {
                cleanupRoom(roomName);
                break;
            }
        }
    });

    socket.on('cancelMatchmaking', () => {
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
        }
    });

    socket.on('move', (data) => {
        if (typeof data.y !== 'number' || isNaN(data.y)) return;
        const roomName = findRoomBySocketId(socket.id);
        if (roomName && rooms[roomName] && (rooms[roomName].status === 'playing' || rooms[roomName].status === 'countdown')) {
            rooms[roomName].players[socket.id].y = Math.max(0, Math.min(data.y, CANVAS_HEIGHT - PADDLE_HEIGHT));
        }
    });

    socket.on('sendEmote', (emote) => {
        const roomName = findRoomBySocketId(socket.id);
        if (roomName) {
            io.to(roomName).emit('receiveEmote', { id: socket.id, emote });
        }
    });

    socket.on('requestRematch', () => {
        const roomName = findRoomBySocketId(socket.id);
        if (!roomName || !rooms[roomName]) return;
        const room = rooms[roomName];
        room.rematchRequests[socket.id] = true;

        const playerIds = Object.keys(room.players);
        const opponentId = playerIds.find(id => id !== socket.id);

        if (opponentId && room.rematchRequests[opponentId]) {
            // İki oyuncu da kabul etti, maçı sıfırla ve başlat
            room.rematchRequests = {};
            room.status = 'countdown';
            room.countdown = 3;
            room.frameCount = 0;
            room.powerup.active = false;
            room.stats = { maxSpeed: BASE_SPEED, leftHits: 0, rightHits: 0 };
            room.ball = {
                x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2,
                dx: 0, dy: 0,
                currentSpeed: BASE_SPEED, lastHit: null
            };
            playerIds.forEach(pid => {
                room.players[pid].score = 0;
                room.players[pid].y = 250;
                room.players[pid].paddleGrowUntil = 0;
            });
            resetBall(room);
            io.to(roomName).emit('rematchStarted');
            io.to(roomName).emit('countdownUpdate', room.countdown);
        } else if (opponentId) {
            io.to(opponentId).emit('opponentRequestedRematch');
        }
    });

    socket.on('reportStats', (data) => {
        if (!data || !data.name || typeof data.xp !== 'number') return;
        updateLeaderboard(data.name, data.xp, data.level || 1);
    });

    socket.on('getLeaderboard', () => {
        socket.emit('leaderboardData', getTop10());
    });

    socket.on('sendGlobalMessage', (data) => {
        if (!data || !data.name || !data.message) return;
        const msgStr = data.message.trim().substring(0, 100);
        if (!msgStr) return;
        const msgObj = {
            id: Date.now() + Math.random(),
            name: data.name,
            title: data.title || '',
            message: msgStr,
            time: Date.now()
        };
        chatHistory.push(msgObj);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('receiveGlobalMessage', msgObj);
    });

    socket.on('getChatHistory', () => {
        socket.emit('chatHistory', chatHistory);
    });

    socket.on('startSingleplayer', (difficulty) => {
        singleplayerSessions[socket.id] = { startTime: Date.now(), difficulty: difficulty };
    });

    socket.on('singleplayerResult', (data) => {
        if (!data || !data.win || !data.difficulty) return;
        const session = singleplayerSessions[socket.id];
        if (!session || session.difficulty !== data.difficulty) {
            socket.emit('singleplayerReward', { error: 'Geçersiz oturum.' });
            return;
        }

        // [BUG FIX] BOT FARMING GÜVENLİK DUVARI TAMAMEN KALDIRILDI! MAÇ SÜRESİ KONTROLÜ YOKTUR.
        let rewardXp = 0;
        let rewardCoins = 0;
        let caseChance = 0;

        if (data.difficulty === 'easy') { 
            rewardXp = data.win ? 45 : 15; 
            rewardCoins = data.win ? 30 : 9; 
            caseChance = 0.01; 
        } else if (data.difficulty === 'medium') { 
            rewardXp = data.win ? 105 : 35; 
            rewardCoins = data.win ? 70 : 21; 
            caseChance = 0.04; 
        } else if (data.difficulty === 'hard') { 
            rewardXp = data.win ? 180 : 60; 
            rewardCoins = data.win ? 120 : 36; 
            caseChance = 0.12; 
        }
        
        let caseDropped = false;
        if (data.win && Math.random() < caseChance) {
            caseDropped = true;
        }
        
        delete singleplayerSessions[socket.id];
        
        socket.emit('singleplayerReward', {
            xp_granted: rewardXp,
            coins_granted: rewardCoins,
            case_dropped: caseDropped,
            difficulty: data.difficulty
        });
    });

    socket.on('disconnect', () => {
        console.log('Ayrıldı:', socket.id);
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
        }
        delete singleplayerSessions[socket.id];

        for (const code in privateRooms) {
            const roomName = privateRooms[code];
            const room = rooms[roomName];
            if (room && room.hostSocket && room.hostSocket.id === socket.id && room.status === 'waiting') {
                cleanupRoom(roomName);
            }
        }

        const roomName = findRoomBySocketId(socket.id);
        if (roomName && rooms[roomName]) {
            io.to(roomName).emit('opponentLeft');
            cleanupRoom(roomName);
        }
    });
});

function startGameLoop(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    room.interval = setInterval(() => {
        if (!rooms[roomName]) { clearInterval(room.interval); return; }
        
        room.frameCount++;

        // Geri Sayım Yönetimi
        if (room.status === 'countdown') {
            if (room.frameCount % SERVER_TICK_RATE === 0) {
                room.countdown--;
                io.to(roomName).emit('countdownUpdate', room.countdown);
                if (room.countdown <= 0) {
                    room.status = 'playing';
                    io.to(roomName).emit('startGame');
                }
            }
        }

        const ball = room.ball;
        const playerIds = Object.keys(room.players);
        if (playerIds.length < 2) { cleanupRoom(roomName); return; }

        const p1 = room.players[playerIds[0]];
        const p2 = room.players[playerIds[1]];

        // Aktif raket boyut hesaplamaları (Power-up etkileri)
        const p1Height = (p1.paddleGrowUntil && p1.paddleGrowUntil > Date.now()) ? PADDLE_HEIGHT * 1.5 : PADDLE_HEIGHT;
        const p2Height = (p2.paddleGrowUntil && p2.paddleGrowUntil > Date.now()) ? PADDLE_HEIGHT * 1.5 : PADDLE_HEIGHT;

        if (room.status === 'playing') {
            // Dinamik Power-up Üretimi (Her 12 saniyede bir şans)
            if (!room.powerup.active && room.frameCount % 360 === 0 && Math.random() < 0.7) {
                room.powerup.x = Math.random() * (CANVAS_WIDTH - 300) + 150;
                room.powerup.y = Math.random() * (CANVAS_HEIGHT - 150) + 75;
                room.powerup.type = Math.random() < 0.5 ? 0 : 1; // 0: Genişleme, 1: Hızlanma
                room.powerup.active = true;
            }

            // Top Hareketi
            const speedMultiplier = ball.currentSpeed / BASE_SPEED;
            const stepsPerTick = 60 / SERVER_TICK_RATE;
            for (let step = 0; step < stepsPerTick; step++) {
                ball.x += ball.dx * speedMultiplier;
                ball.y += ball.dy * speedMultiplier;
            }

            // Duvar Çarpışmaları
            if (ball.y - BALL_RADIUS <= 0 || ball.y + BALL_RADIUS >= CANVAS_HEIGHT) {
                ball.dy *= -1;
                if (ball.y - BALL_RADIUS <= 0) ball.y = BALL_RADIUS;
                if (ball.y + BALL_RADIUS >= CANVAS_HEIGHT) ball.y = CANVAS_HEIGHT - BALL_RADIUS;
                io.to(roomName).emit('playSound', { type: 'wallHit', shake: true });
            }

            // Sol Raket Çarpışma
            const leftPaddleRight = 20 + PADDLE_WIDTH;
            if (ball.x - BALL_RADIUS <= leftPaddleRight && ball.x + BALL_RADIUS >= 20 &&
                ball.y >= p1.y && ball.y <= p1.y + p1Height) {
                if (ball.dx < 0) {
                    const hitPos = (ball.y - p1.y) / p1Height;
                    const angle = (hitPos - 0.5) * (Math.PI / 3);
                    ball.dx = Math.abs(Math.cos(angle) * BASE_SPEED);
                    ball.dy = Math.sin(angle) * BASE_SPEED;
                    ball.x = leftPaddleRight + BALL_RADIUS;
                    ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                    ball.lastHit = 'left';
                    room.stats.leftHits++;
                    if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                    io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
                }
            }

            // Sağ Raket Çarpışma
            const rightPaddleLeft = CANVAS_WIDTH - 30;
            if (ball.x + BALL_RADIUS >= rightPaddleLeft && ball.x - BALL_RADIUS <= CANVAS_WIDTH - 30 + PADDLE_WIDTH &&
                ball.y >= p2.y && ball.y <= p2.y + p2Height) {
                if (ball.dx > 0) {
                    const hitPos = (ball.y - p2.y) / p2Height;
                    const angle = (hitPos - 0.5) * (Math.PI / 3);
                    ball.dx = -Math.abs(Math.cos(angle) * BASE_SPEED);
                    ball.dy = Math.sin(angle) * BASE_SPEED;
                    ball.x = rightPaddleLeft - BALL_RADIUS;
                    ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                    ball.lastHit = 'right';
                    room.stats.rightHits++;
                    if (ball.currentSpeed > room.stats.maxSpeed) room.stats.maxSpeed = ball.currentSpeed;
                    io.to(roomName).emit('playSound', { type: 'paddleHit', shake: true });
                }
            }

            // Power-up ile Topun Çarpışması
            if (room.powerup.active) {
                const distX = ball.x - room.powerup.x;
                const distY = ball.y - room.powerup.y;
                const distance = Math.sqrt(distX * distX + distY * distY);
                if (distance < BALL_RADIUS + 20) {
                    room.powerup.active = false;
                    const targetSide = ball.lastHit || (ball.dx > 0 ? 'left' : 'right');
                    
                    if (room.powerup.type === 0) {
                        // Raket Genişletme (8 Saniye)
                        if (targetSide === 'left') p1.paddleGrowUntil = Date.now() + 8000;
                        else p2.paddleGrowUntil = Date.now() + 8000;
                    } else {
                        // Topu Anında Çılgınca Hızlandırma
                        ball.currentSpeed = Math.min(ball.currentSpeed + 3.5, MAX_SPEED);
                    }
                    io.to(roomName).emit('powerupActivated', { type: room.powerup.type, side: targetSide });
                    io.to(roomName).emit('playSound', { type: 'powerup', shake: true });
                }
            }

            // Skor Kontrolleri
            let scored = false;
            if (ball.x < 0) { p2.score++; scored = true; }
            else if (ball.x > CANVAS_WIDTH) { p1.score++; scored = true; }

            if (scored) {
                io.to(roomName).emit('playSound', { type: 'score', shake: true });
                if (p1.score >= MAX_SCORE || p2.score >= MAX_SCORE) {
                    room.status = 'gameOver';
                    const winnerSide = p1.score >= MAX_SCORE ? 'left' : 'right';

                    playerIds.forEach(pid => {
                        const player = room.players[pid];
                        io.to(pid).emit('gameOver', {
                            winner: winnerSide,
                            credits: player.side === winnerSide ? 100 : 30,
                            stats: {
                                maxSpeed: Math.round(room.stats.maxSpeed * 10) / 10,
                                totalHits: room.stats.leftHits + room.stats.rightHits,
                                yourHits: player.side === 'left' ? room.stats.leftHits : room.stats.rightHits
                            }
                        });
                    });

                    clearInterval(room.interval);
                    room.interval = null;
                    return;
                } else {
                    resetBall(room);
                }
            }
        }

        // Optimize Edilmiş Paket Gönderimi (Interpolation Desteği İçin Veriler Ekli)
        const newState = {
            b: [
                Math.round(ball.x * 10) / 10, Math.round(ball.y * 10) / 10,
                Math.round(ball.dx * 100) / 100, Math.round(ball.dy * 100) / 100,
                Math.round(ball.currentSpeed * 100) / 100,
                ball.lastHit === 'left' ? 0 : ball.lastHit === 'right' ? 1 : 2
            ],
            p: [
                Math.round(p1.y), p1.score, (p1.paddleGrowUntil > Date.now() ? 1 : 0),
                Math.round(p2.y), p2.score, (p2.paddleGrowUntil > Date.now() ? 1 : 0)
            ],
            pw: [
                room.powerup.active ? 1 : 0,
                Math.round(room.powerup.x), Math.round(room.powerup.y),
                room.powerup.type
            ],
            st: room.status,
            c: room.countdown,
            f: room.frameCount,
            t: Date.now()
        };
        io.to(roomName).emit('gs', newState);

    }, TICK_INTERVAL);
}

function resetBall(room) {
    room.ball.x = CANVAS_WIDTH / 2;
    room.ball.y = CANVAS_HEIGHT / 2;
    room.ball.currentSpeed = BASE_SPEED;
    room.ball.lastHit = null;

    const signX = Math.random() < 0.5 ? 1 : -1;
    const signY = Math.random() < 0.5 ? 1 : -1;
    const minAngle = Math.PI / 6;
    const maxAngle = Math.PI / 3;
    const angle = Math.random() * (maxAngle - minAngle) + minAngle;

    room.ball.dx = Math.cos(angle) * BASE_SPEED * signX;
    room.ball.dy = Math.sin(angle) * BASE_SPEED * signY;
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Cyber Pong Sunucusu Aktif: http://localhost:${PORT}`);
});