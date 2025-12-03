const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const { chromium } = require('playwright');
const { Server } = require('socket.io');
const http = require('http');

// Create app
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SECRET_KEY || 'fb-bot-' + Date.now(),
    resave: false,
    saveUninitialized: true
}));

// Global state
const users = new Map();
const systemLogs = [];
const EMOJI_RANGES = [[0x1F600, 0x1F64F], [0x1F300, 0x1F5FF]];

// ==================== UTILITY FUNCTIONS ====================
function log(msg, userId = null) {
    const time = new Date().toTimeString().split(' ')[0];
    const logMsg = `[${time}] ${msg}`;
    console.log(logMsg);
    systemLogs.push(logMsg);
    if (systemLogs.length > 500) systemLogs.shift();
    
    if (userId && users.has(userId)) {
        const user = users.get(userId);
        user.logs.push(logMsg);
        if (user.logs.length > 500) user.logs.shift();
        io.to(userId).emit('log', logMsg);
    }
    io.emit('log', logMsg);
}

function getEmoji() {
    const [s, e] = EMOJI_RANGES[Math.floor(Math.random() * EMOJI_RANGES.length)];
    return String.fromCodePoint(Math.floor(Math.random() * (e - s + 1)) + s);
}

function enhanceMsg(text) {
    if (!text) return text;
    const words = text.split(' ');
    const result = [];
    if (Math.random() > 0.5) result.push(getEmoji());
    words.forEach((word, i) => {
        result.push(word);
        if (Math.random() < 0.3 && i < words.length - 1) result.push(getEmoji());
    });
    if (Math.random() > 0.5) result.push(getEmoji());
    return result.join(' ');
}

function parseCookies(input) {
    const cookies = [];
    if (!input) return cookies;
    
    const lines = input.split('\n');
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        
        if (line.includes('=')) {
            const [name, ...valueParts] = line.split('=');
            let value = valueParts.join('=');
            const cleanName = name.trim().replace(/[;"']/g, '');
            value = value.split(';')[0].trim().replace(/["']/g, '');
            
            if (cleanName && value && !cleanName.includes(' ')) {
                cookies.push({
                    name: cleanName,
                    value: value,
                    domain: '.facebook.com',
                    path: '/',
                    secure: true,
                    httpOnly: ['xs', 'c_user', 'fr'].includes(cleanName)
                });
            }
        }
    });
    
    return cookies.filter((c, i, a) => a.findIndex(x => x.name === c.name) === i);
}

// ==================== FACEBOOK MESSENGER CORE ====================
async function sendMessage(cookies, convId, message, taskId, userId) {
    try {
        log(`[${taskId}] 🚀 Starting browser (headless: true)...`, userId);
        
        // Launch browser - HEADLESS MODE FOR RENDER
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
            timeout: 60000
        });
        
        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        // Add cookies
        await context.addCookies(cookies);
        log(`[${taskId}] ✅ Cookies loaded: ${cookies.length}`, userId);
        
        const page = await context.newPage();
        
        // Check login
        log(`[${taskId}] 🔐 Checking login...`, userId);
        await page.goto('https://m.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        // Verify login
        const loggedIn = await page.evaluate(() => 
            !document.querySelector('input[name="email"], input[name="pass"]')
        );
        
        if (!loggedIn) {
            log(`[${taskId}] ❌ Login failed`, userId);
            await browser.close();
            return false;
        }
        
        log(`[${taskId}] ✅ Login successful`, userId);
        
        // Get profile name
        await page.goto('https://www.facebook.com/profile.php', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        
        const profileName = await page.evaluate(() => {
            const nameEl = document.querySelector('h1, [data-testid="profile_name"], span[dir="auto"]');
            return nameEl ? nameEl.textContent.trim().substring(0, 30) : 'Facebook User';
        });
        
        log(`[${taskId}] 👤 Logged in as: ${profileName}`, userId);
        
        // Go to conversation
        log(`[${taskId}] 💬 Opening conversation...`, userId);
        await page.goto(`https://www.facebook.com/messages/t/${convId}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        await page.waitForTimeout(8000);
        
        // Find message input
        log(`[${taskId}] 🔍 Finding message box...`, userId);
        const msgSelectors = [
            'div[contenteditable="true"][role="textbox"]',
            'div[aria-label*="Message" i]',
            '[contenteditable="true"]'
        ];
        
        let msgBox = null;
        for (const selector of msgSelectors) {
            const elements = await page.$$(selector);
            for (const el of elements) {
                if (await el.isVisible()) {
                    msgBox = el;
                    break;
                }
            }
            if (msgBox) break;
        }
        
        if (!msgBox) {
            log(`[${taskId}] ❌ Message box not found`, userId);
            await browser.close();
            return false;
        }
        
        log(`[${taskId}] ✅ Message box found`, userId);
        
        // Send message
        await msgBox.click();
        await page.waitForTimeout(2000);
        
        // Clear and type
        await page.keyboard.press('Control+A');
        await page.waitForTimeout(500);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(1000);
        
        // Type with human-like delay
        await page.keyboard.type(message, { delay: 30 + Math.random() * 40 });
        await page.waitForTimeout(2000);
        
        // Send
        await page.keyboard.press('Enter');
        log(`[${taskId}] ✅ Message sent`, userId);
        await page.waitForTimeout(5000);
        
        await browser.close();
        return true;
        
    } catch (error) {
        log(`[${taskId}] ❌ Error: ${error.message}`, userId);
        return false;
    }
}

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    if (!req.session.userId) req.session.userId = uuidv4();
    if (!users.has(req.session.userId)) {
        users.set(req.session.userId, { logs: [...systemLogs], tasks: new Map() });
    }
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Facebook Messenger Bot</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial; background: #f0f2f5; color: #1c1e21; }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header { background: #1877f2; color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
            .header h1 { display: flex; align-items: center; gap: 10px; }
            .header h1:before { content: "💬"; }
            .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
            .tab { padding: 10px 20px; background: white; border: none; border-radius: 5px; cursor: pointer; }
            .tab.active { background: #1877f2; color: white; }
            .content { display: none; background: white; padding: 20px; border-radius: 10px; }
            .content.active { display: block; }
            .form-group { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; min-height: 150px; font-family: monospace; }
            .btn { background: #1877f2; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
            .btn:hover { background: #166fe5; }
            .btn.stop { background: #ff4444; }
            .logs { background: #1c1e21; color: #00ff00; padding: 15px; border-radius: 5px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px; }
            .log-line { margin-bottom: 5px; border-bottom: 1px solid #333; padding-bottom: 5px; }
            .status { background: white; padding: 15px; border-radius: 5px; margin-bottom: 15px; }
            .task { background: #f8f9fa; padding: 10px; border-radius: 5px; margin-bottom: 10px; }
            .progress { height: 10px; background: #e4e6eb; border-radius: 5px; overflow: hidden; }
            .progress-bar { height: 100%; background: #1877f2; width: 0%; transition: width 0.3s; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Facebook Messenger Bot</h1>
                <p>Send messages to Facebook groups using cookies</p>
            </div>
            
            <div class="tabs">
                <button class="tab active" onclick="showTab('send')">Send Messages</button>
                <button class="tab" onclick="showTab('logs')">Live Logs</button>
                <button class="tab" onclick="showTab('tasks')">Tasks</button>
            </div>
            
            <div id="send" class="content active">
                <div class="form-group">
                    <label>Facebook Cookies (one per line):</label>
                    <textarea id="cookies" placeholder="c_user=123456789...&#10;xs=abc123...&#10;fr=xyz456..."></textarea>
                    <small>Paste cookies from browser. Format: name=value</small>
                </div>
                
                <div class="form-group">
                    <label>Messages (one per line):</label>
                    <textarea id="messages" placeholder="Hello friends! 👋&#10;How are you? 😊&#10;Check this out! 🚀"></textarea>
                    <small>Messages will be enhanced with emojis automatically</small>
                </div>
                
                <div class="form-group">
                    <label>Group/Conversation IDs (one per line):</label>
                    <textarea id="conversations" placeholder="1581775349513033&#10;100012345678901"></textarea>
                    <small>Get from URL: facebook.com/messages/t/ID</small>
                </div>
                
                <button class="btn" onclick="startSending()">🚀 Start Sending</button>
                <button class="btn stop" onclick="stopAll()">🛑 Stop All</button>
            </div>
            
            <div id="logs" class="content">
                <h3>Live Console</h3>
                <div class="logs" id="logContainer"></div>
                <button class="btn" onclick="clearLogs()">Clear Logs</button>
            </div>
            
            <div id="tasks" class="content">
                <h3>Active Tasks</h3>
                <div id="tasksList">No active tasks</div>
            </div>
            
            <div class="status">
                <p><strong>Status:</strong> <span id="status">Ready</span></p>
                <p><strong>Mode:</strong> Headless (Render Compatible)</p>
            </div>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const userId = '${req.session.userId}';
            
            function showTab(tabName) {
                document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.getElementById(tabName).classList.add('active');
                event.target.classList.add('active');
            }
            
            function addLog(msg) {
                const container = document.getElementById('logContainer');
                const line = document.createElement('div');
                line.className = 'log-line';
                line.textContent = msg;
                container.appendChild(line);
                container.scrollTop = container.scrollHeight;
            }
            
            function clearLogs() {
                document.getElementById('logContainer').innerHTML = '';
            }
            
            async function startSending() {
                const cookies = document.getElementById('cookies').value;
                const messages = document.getElementById('messages').value;
                const conversations = document.getElementById('conversations').value;
                
                if (!cookies || !messages || !conversations) {
                    alert('Please fill all fields!');
                    return;
                }
                
                const response = await fetch('/api/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies, messages, conversations })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Task started: ' + data.taskId);
                    loadTasks();
                } else {
                    alert('Error: ' + data.message);
                }
            }
            
            async function stopAll() {
                const response = await fetch('/api/stop-all', { method: 'POST' });
                const data = await response.json();
                alert(data.message);
                loadTasks();
            }
            
            async function loadTasks() {
                const response = await fetch('/api/tasks');
                const data = await response.json();
                const container = document.getElementById('tasksList');
                
                if (data.tasks.length === 0) {
                    container.innerHTML = 'No active tasks';
                    return;
                }
                
                container.innerHTML = data.tasks.map(task => \`
                    <div class="task">
                        <strong>\${task.id}</strong>
                        <div>\${task.active ? '🟢 Active' : '🔴 Stopped'} | Success: \${task.success}/\${task.total}</div>
                        <div class="progress">
                            <div class="progress-bar" style="width: \${task.progress}%"></div>
                        </div>
                        <button onclick="stopTask('\${task.id}')">Stop</button>
                    </div>
                \`).join('');
            }
            
            async function stopTask(taskId) {
                await fetch(\`/api/stop/\${taskId}\`, { method: 'POST' });
                loadTasks();
            }
            
            // Socket listeners
            socket.on('connect', () => {
                document.getElementById('status').textContent = 'Connected';
            });
            
            socket.on('log', (msg) => {
                addLog(msg);
            });
            
            // Initial load
            loadTasks();
            setInterval(loadTasks, 5000);
        </script>
    </body>
    </html>
    `);
});

// API Routes
app.post('/api/start', async (req, res) => {
    const { cookies, messages, conversations } = req.body;
    const userId = req.session.userId;
    
    if (!cookies || !messages || !conversations) {
        return res.json({ success: false, message: 'All fields required' });
    }
    
    const cookiesList = cookies.split('\n').filter(l => l.trim());
    const messagesList = messages.split('\n').filter(l => l.trim());
    const convList = conversations.split('\n').filter(l => l.trim());
    
    const taskId = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const user = users.get(userId);
    
    const task = {
        active: true,
        cookies: cookiesList,
        messages: messagesList,
        conversations: convList,
        index: 0,
        success: 0,
        total: messagesList.length * convList.length * cookiesList.length
    };
    
    user.tasks.set(taskId, task);
    
    // Start task in background
    (async () => {
        while (task.active && task.index < task.total) {
            const msgIdx = task.index % messagesList.length;
            const convIdx = Math.floor(task.index / messagesList.length) % convList.length;
            const cookieIdx = Math.floor(task.index / (messagesList.length * convList.length)) % cookiesList.length;
            
            const message = enhanceMsg(messagesList[msgIdx]);
            const convId = convList[convIdx];
            const cookieInput = cookiesList[cookieIdx];
            
            const parsedCookies = parseCookies(cookieInput);
            
            if (parsedCookies.length > 0) {
                log(`[${taskId}] Sending: "${message.substring(0, 30)}..." → ${convId}`, userId);
                
                const success = await sendMessage(parsedCookies, convId, message, taskId, userId);
                
                if (success) {
                    task.success++;
                    log(`[${taskId}] ✅ Success! (${task.success}/${task.total})`, userId);
                } else {
                    log(`[${taskId}] ❌ Failed`, userId);
                }
            } else {
                log(`[${taskId}] ❌ No valid cookies`, userId);
            }
            
            task.index++;
            
            // Delay
            await new Promise(r => setTimeout(r, 8000 + Math.random() * 7000));
        }
        
        task.active = false;
        log(`[${taskId}] 🏁 Finished: ${task.success}/${task.total} successful`, userId);
    })();
    
    res.json({ success: true, taskId, message: 'Task started' });
});

app.post('/api/stop/:taskId', (req, res) => {
    const userId = req.session.userId;
    const user = users.get(userId);
    if (user && user.tasks.has(req.params.taskId)) {
        user.tasks.get(req.params.taskId).active = false;
    }
    res.json({ success: true, message: 'Task stopped' });
});

app.post('/api/stop-all', (req, res) => {
    const userId = req.session.userId;
    const user = users.get(userId);
    if (user) {
        user.tasks.forEach(task => task.active = false);
    }
    res.json({ success: true, message: 'All tasks stopped' });
});

app.get('/api/tasks', (req, res) => {
    const userId = req.session.userId;
    const user = users.get(userId);
    const tasks = [];
    
    if (user) {
        user.tasks.forEach((task, id) => {
            tasks.push({
                id,
                active: task.active,
                success: task.success,
                total: task.total,
                progress: task.total > 0 ? Math.round((task.index / task.total) * 100) : 0
            });
        });
    }
    
    res.json({ tasks });
});

// Socket connection
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.join(userId);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open: http://localhost:${PORT}`);
    console.log(`🖥️  Headless mode: Ready for Render`);
});
