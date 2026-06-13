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
const MAX_SPEED = 15;
const SPEED_INCREMENT = 0.5;
const PADDLE_HEIGHT = 100;
const PADDLE_WIDTH = 10;
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
        interval: null,
        status: 'waiting',
        lastState: null,
        frameCount: 0
    };
}

function initMatch(roomName, socket1, profile1, socket2, profile2) {
    const room = rooms[roomName];
    room.players = {
        [socket1.id]: { y: 250, side: 'left', score: 0, lastY: 250 },
        [socket2.id]: { y: 250, side: 'right', score: 0, lastY: 250 }
    };
    room.status = 'playing';
    room.ball = {
        x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2,
        dx: 0, dy: 0,
        currentSpeed: BASE_SPEED, lastHit: null
    };
    room.lastState = null;
    room.frameCount = 0;

    resetBall(room);

    socket1.join(roomName);
    socket2.join(roomName);

    io.to(socket1.id).emit('init', { side: 'left', opponent: profile2 });
    io.to(socket2.id).emit('init', { side: 'right', opponent: profile1 });
    io.to(roomName).emit('startGame');

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
            socket.emit('privateRoomError', 'Oda bulunamadı! Kodu kontrol et.');
            return;
        }

        const room = rooms[roomName];

        if (room.status !== 'waiting') {
            socket.emit('privateRoomError', 'Bu oda zaten dolu veya maç başlamış.');
            return;
        }

        if (!room.hostSocket || !room.hostSocket.connected) {
            cleanupRoom(roomName);
            socket.emit('privateRoomError', 'Oda sahibi bağlantısını kaybetti.');
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
        if (roomName && rooms[roomName] && rooms[roomName].status === 'playing') {
            rooms[roomName].players[socket.id].y = Math.max(0, Math.min(data.y, CANVAS_HEIGHT - PADDLE_HEIGHT));
        }
    });

    socket.on('reportStats', (data) => {
        if (!data || !data.name || typeof data.xp !== 'number') return;
        updateLeaderboard(data.name, data.xp, data.level || 1);
    });

    socket.on('getLeaderboard', () => {
        socket.emit('leaderboardData', getTop10());
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
        
        const duration = Date.now() - session.startTime;
        // Güvenlik Duvarı: 5-0 bile bitse 30 saniyeden kısa sürmesi çok zordur (Hız hilesi koruması)
        if (duration < 30000) {
            socket.emit('singleplayerReward', { error: 'Oyun çok kısa sürdü, hile şüphesi (Bot Farming Engellendi)!' });
            return;
        }

        let rewardXp = 0;
        let rewardCoins = 0;
        let caseChance = 0;

        if (data.difficulty === 'easy') { rewardXp = 20; rewardCoins = 5; caseChance = 0.01; }
        else if (data.difficulty === 'medium') { rewardXp = 50; rewardCoins = 15; caseChance = 0.03; }
        else if (data.difficulty === 'hard') { rewardXp = 200; rewardCoins = 75; caseChance = 0.12; }
        
        let caseDropped = false;
        if (Math.random() < caseChance) {
            caseDropped = true;
        }
        
        delete singleplayerSessions[socket.id]; // Oturumu kapat
        
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
        if (room.status !== 'playing') return;

        const ball = room.ball;
        room.frameCount++;

        const speedMultiplier = ball.currentSpeed / BASE_SPEED;
        const stepsPerTick = 60 / SERVER_TICK_RATE;

        for (let step = 0; step < stepsPerTick; step++) {
            ball.x += ball.dx * speedMultiplier;
            ball.y += ball.dy * speedMultiplier;
        }

        let events = [];

        if (ball.y - BALL_RADIUS <= 0 || ball.y + BALL_RADIUS >= CANVAS_HEIGHT) {
            ball.dy *= -1;
            if (ball.y - BALL_RADIUS <= 0) ball.y = BALL_RADIUS;
            if (ball.y + BALL_RADIUS >= CANVAS_HEIGHT) ball.y = CANVAS_HEIGHT - BALL_RADIUS;
            events.push({ t: 'w' });
        }

        const playerIds = Object.keys(room.players);
        if (playerIds.length < 2) { cleanupRoom(roomName); return; }

        const p1 = room.players[playerIds[0]];
        const p2 = room.players[playerIds[1]];

        const leftPaddleRight = 20 + PADDLE_WIDTH;
        if (ball.x - BALL_RADIUS <= leftPaddleRight && ball.x + BALL_RADIUS >= 20 &&
            ball.y >= p1.y && ball.y <= p1.y + PADDLE_HEIGHT) {
            if (ball.dx < 0) {
                const hitPos = (ball.y - p1.y) / PADDLE_HEIGHT;
                const angle = (hitPos - 0.5) * (Math.PI / 3);
                ball.dx = Math.abs(Math.cos(angle) * BASE_SPEED);
                ball.dy = Math.sin(angle) * BASE_SPEED;
                ball.x = leftPaddleRight + BALL_RADIUS;
                ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                ball.lastHit = 'left';
                events.push({ t: 'p' });
            }
        }

        const rightPaddleLeft = CANVAS_WIDTH - 30;
        if (ball.x + BALL_RADIUS >= rightPaddleLeft && ball.x - BALL_RADIUS <= CANVAS_WIDTH - 30 + PADDLE_WIDTH &&
            ball.y >= p2.y && ball.y <= p2.y + PADDLE_HEIGHT) {
            if (ball.dx > 0) {
                const hitPos = (ball.y - p2.y) / PADDLE_HEIGHT;
                const angle = (hitPos - 0.5) * (Math.PI / 3);
                ball.dx = -Math.abs(Math.cos(angle) * BASE_SPEED);
                ball.dy = Math.sin(angle) * BASE_SPEED;
                ball.x = rightPaddleLeft - BALL_RADIUS;
                ball.currentSpeed = Math.min(ball.currentSpeed + SPEED_INCREMENT, MAX_SPEED);
                ball.lastHit = 'right';
                events.push({ t: 'p' });
            }
        }

        let scored = false;
        let shake = false;
        if (ball.x < 0) { p2.score++; scored = true; }
        else if (ball.x > CANVAS_WIDTH) { p1.score++; scored = true; }

        if (scored) {
            events.push({ t: 's' });
            shake = true;

            if (p1.score >= MAX_SCORE || p2.score >= MAX_SCORE) {
                room.status = 'gameOver';
                const winnerSide = p1.score >= MAX_SCORE ? 'left' : 'right';

                playerIds.forEach(pid => {
                    const player = room.players[pid];
                    const isWinner = player.side === winnerSide;
                    io.to(pid).emit('gameOver', {
                        winner: winnerSide,
                        credits: isWinner ? 100 : 30
                    });
                });

                clearInterval(room.interval);
                room.interval = null;
                setTimeout(() => cleanupRoom(roomName), 5000);
                return;
            } else {
                resetBall(room);
            }
        }

        if (events.length > 0) {
            const soundMap = { 'w': 'wallHit', 'p': 'paddleHit', 's': 'score' };
            const lastEvent = events[events.length - 1];
            io.to(roomName).emit('playSound', { type: soundMap[lastEvent.t], shake });
        }

        const newState = {
            b: [
                Math.round(ball.x * 10) / 10,
                Math.round(ball.y * 10) / 10,
                Math.round(ball.dx * 100) / 100,
                Math.round(ball.dy * 100) / 100,
                Math.round(ball.currentSpeed * 100) / 100,
                ball.lastHit === 'left' ? 0 : ball.lastHit === 'right' ? 1 : 2
            ],
            p: [
                Math.round(p1.y), p1.score,
                Math.round(p2.y), p2.score
            ],
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

setInterval(() => {
    for (const code in privateRooms) {
        const roomName = privateRooms[code];
        const room = rooms[roomName];
        if (room && room.status === 'waiting' && room.hostSocket && !room.hostSocket.connected) {
            cleanupRoom(roomName);
        }
    }
}, 30000);

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
    console.log(`Tick Rate: ${SERVER_TICK_RATE}Hz | Aktif Odalar: ${Object.keys(rooms).length}`);
});
