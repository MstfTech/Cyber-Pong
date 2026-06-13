const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. CSS RECOVERY: Remove 'hidden' from all 'screen' classes
content = content.replace(/class="screen hidden"/g, 'class="screen"');
// Also catch variations like class="screen hidden" style="..."
content = content.replace(/class="screen\s+hidden"/g, 'class="screen"');

// 2. Fix nested DOMContentLoaded (remove inner ones)
content = content.replace(/document\.addEventListener\('DOMContentLoaded',\s*\(\)\s*=>\s*LocalizationManager\.init\(\)\);/g, 'LocalizationManager.init();');

// 3. NULL-SAFE RENDER LOOP & CANVAS
content = content.replace(/function renderLoop\(timestamp\) \{/g, 'function renderLoop(timestamp) {\n                if (!ctx || !canvas) return;\n');
content = content.replace(/function updateAndDrawParticles\(dtFactor\) \{/g, 'function updateAndDrawParticles(dtFactor) {\n                if (!ctx || !canvas) return;\n');

// 4. INTERACTIVE FAIL-SAFE: socket connection check for buttons
const failSafeBtnLogin = `
            if (!socket || !socket.connected) {
                const btn = document.getElementById('btnLogin');
                if (btn) btn.innerText = "BAĞLANIYOR...";
                return;
            }
`;
const failSafeBtnFindMatch = `
            if (!socket || !socket.connected) {
                const btn = document.getElementById('btnFindMatch');
                if (btn) btn.innerText = "BAĞLANIYOR...";
                return;
            }
`;

// Inject fail-safe logic at the beginning of button handlers
content = content.replace(/(document\.getElementById\('btnLogin'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{)/g, `$1${failSafeBtnLogin}`);
content = content.replace(/(document\.getElementById\('btnFindMatch'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{)/g, `$1${failSafeBtnFindMatch}`);

// Remove my previous bad fail-safe if it exists
content = content.replace(/if \(!socket \|\| \(socket && socket\.connected === false\)\) \{[\s\S]*?return;\n\s*\}/g, '');

// 5. EXCEPTION HANDLING: Wrap socket.on bodies in try-catch
// Since regex for matching bracket bodies is hard, we can do a simple line-based injection
// We'll look for "socket.on('...', (data) => {" and add "try {" right after. Then we find the closing "});" of that block.
// Actually, it's safer to just wrap the whole `socket.on` execution dynamically by overriding the socket.on function!
const socketOnOverride = `
                const originalOn = socket.on.bind(socket);
                socket.on = function(eventName, callback) {
                    originalOn(eventName, function(...args) {
                        try {
                            callback(...args);
                        } catch (e) {
                            console.error("Socket Event Error [" + eventName + "]:", e.message);
                        }
                    });
                };
`;

// Insert the override right after socket connects/is initialized
content = content.replace(/socket = io\("https:\/\/cyber-pong\.onrender\.com".*?\);/g, `$&${socketOnOverride}`);

// Also fix the dummy socket to have 'connected: false'
content = content.replace(/socket = \{ on: \(\) => \{\}, emit: \(\) => \{\} \};/g, `socket = { on: () => {}, emit: () => {}, connected: false };`);

fs.writeFileSync(filePath, content, 'utf8');
console.log("Super fixes applied.");
