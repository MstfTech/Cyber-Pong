const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// Extract the main script block (the big one, not the socket.io src)
const scriptStart = html.indexOf('<script>', html.indexOf('socket.io/socket.io.js'));
const scriptEnd = html.indexOf('</script>', scriptStart);
const js = html.substring(scriptStart + 8, scriptEnd);

// Count braces
let opens = 0;
let closes = 0;
const lines = js.split('\n');
const stack = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
        if (ch === '{') {
            opens++;
            stack.push(i + 1);
        }
        if (ch === '}') {
            closes++;
            if (stack.length > 0) stack.pop();
        }
    }
}

console.log(`Open braces: ${opens}`);
console.log(`Close braces: ${closes}`);
console.log(`Difference: ${opens - closes}`);

if (stack.length > 0) {
    console.log(`\nUnclosed braces from lines: ${stack.join(', ')}`);
}

// Also check parens
let parenOpen = 0;
let parenClose = 0;
for (const ch of js) {
    if (ch === '(') parenOpen++;
    if (ch === ')') parenClose++;
}
console.log(`\nOpen parens: ${parenOpen}`);
console.log(`Close parens: ${parenClose}`);
console.log(`Paren diff: ${parenOpen - parenClose}`);
