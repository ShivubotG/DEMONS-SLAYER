// server.js
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    secret: process.env.SECRET_KEY || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// File upload configuration
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Data stores
const userSessions = new Map();
const tasks = new Map();
const systemLogs = [];

// Helper functions
function generateTaskId() {
    return `h4rsh_${Math.floor(10000 + Math.random() * 90000)}`;
}

function logMessage(message, userId = null) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;
    
    console.log(formatted);
    systemLogs.push(formatted);
    
    if (systemLogs.length > 1000) {
        systemLogs.shift();
    }
    
    // Emit to socket if userId provided
    if (userId) {
        io.to(userId).emit('log', formatted);
    }
    
    return formatted;
}

function parseCookies(cookieInput) {
    const cookies = [];
    
    if (!cookieInput || !cookieInput.trim()) {
        return cookies;
    }
    
    cookieInput = cookieInput.trim();
    
    // Try JSON parsing
    if (cookieInput.startsWith('[') && cookieInput.endsWith(']')) {
        try {
            const data = JSON.parse(cookieInput);
            if (Array.isArray(data)) {
                return data.filter(cookie => 
                    cookie && 
                    cookie.name && 
                    cookie.value
                ).map(cookie => ({
                    name: String(cookie.name),
                    value: String(cookie.value),
                    domain: cookie.domain || '.facebook.com',
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly || false
                }));
            }
        } catch (error) {
            logMessage(`JSON parse error: ${error}`);
        }
    }
    
    // Parse string cookies
    const lines = cookieInput.split(/[\n;]/).map(line => line.trim()).filter(line => line);
    
    for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('//')) continue;
        
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
            const name = line.substring(0, eqIndex).trim();
            let value = line.substring(eqIndex + 1).split(';')[0].trim();
            
            // Decode URL encoded values
            try {
                value = decodeURIComponent(value);
            } catch (e) {
                // Keep original value if decoding fails
            }
            
            // Remove quotes
            value = value.replace(/^["']|["']$/g, '');
            
            if (name && value) {
                const domain = name.includes('instagram') ? '.instagram.com' : '.facebook.com';
                cookies.push({
                    name,
                    value,
                    domain,
                    path: '/',
                    secure: true,
                    httpOnly: ['xs', 'fr', 'c_user'].includes(name)
                });
            }
        }
    }
    
    // Remove duplicates
    const uniqueCookies = [];
    const seenNames = new Set();
    
    for (const cookie of cookies) {
        if (!seenNames.has(cookie.name)) {
            uniqueCookies.push(cookie);
            seenNames.add(cookie.name);
        }
    }
    
    return uniqueCookies.slice(0, 30);
}

function enhanceMessage(message) {
    if (!message || !message.trim()) {
        return message;
    }
    
    // Simple emoji enhancement
    const emojis = ['😊', '👍', '🚀', '💬', '✨', '🔥', '⭐', '🎯', '💥', '🌟'];
    const words = message.split(' ');
    
    if (words.length <= 1) {
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        return `${randomEmoji} ${message} ${randomEmoji}`;
    }
    
    const enhancedWords = [];
    for (let i = 0; i < words.length; i++) {
        enhancedWords.push(words[i]);
        if (Math.random() < 0.3 && i < words.length - 1) {
            enhancedWords.push(emojis[Math.floor(Math.random() * emojis.length)]);
        }
    }
    
    if (Math.random() < 0.4) {
        enhancedWords.unshift(emojis[Math.floor(Math.random() * emojis.length)]);
    }
    if (Math.random() < 0.4) {
        enhancedWords.push(emojis[Math.floor(Math.random() * emojis.length)]);
    }
    
    return enhancedWords.join(' ');
}

// Facebook message sending function
async function sendFacebookMessage(cookies, conversationId, message, taskId, userId) {
    let browser = null;
    
    try {
        logMessage(`[${taskId}] 🚀 Starting browser...`, userId);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser'
        });
        
        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Set cookies
        for (const cookie of cookies) {
            try {
                await page.setCookie(cookie);
            } catch (error) {
                logMessage(`[${taskId}] ❌ Error setting cookie ${cookie.name}: ${error}`, userId);
            }
        }
        
        // Navigate to Facebook
        logMessage(`[${taskId}] 🌐 Navigating to Facebook...`, userId);
        await page.goto('https://www.facebook.com', { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        await page.waitForTimeout(3000);
        
        // Check if logged in
        const isLoggedIn = await page.evaluate(() => {
            return document.querySelector('[aria-label="Your profile"]') !== null ||
                   document.querySelector('[data-testid="royal_profile"]') !== null ||
                   document.querySelector('a[href*="profile.php"]') !== null;
        });
        
        if (!isLoggedIn) {
            logMessage(`[${taskId}] ❌ Not logged in`, userId);
            await browser.close();
            return false;
        }
        
        logMessage(`[${taskId}] ✅ Successfully logged in`, userId);
        
        // Go to conversation
        const conversationUrl = `https://www.facebook.com/messages/t/${conversationId}`;
        logMessage(`[${taskId}] 💬 Navigating to conversation: ${conversationId}`, userId);
        
        await page.goto(conversationUrl, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        await page.waitForTimeout(5000);
        
        // Find message input
        logMessage(`[${taskId}] 🔍 Looking for message input...`, userId);
        
        const messageInputSelector = 'div[contenteditable="true"][role="textbox"]';
        await page.waitForSelector(messageInputSelector, { timeout: 30000 });
        
        const messageInput = await page.$(messageInputSelector);
        
        if (!messageInput) {
            logMessage(`[${taskId}] ❌ Message input not found`, userId);
            await browser.close();
            return false;
        }
        
        // Type message
        logMessage(`[${taskId}] 📝 Typing message...`, userId);
        await messageInput.click();
        await page.waitForTimeout(1000);
        
        // Type character by character for realism
        for (const char of message) {
            await messageInput.type(char, { delay: Math.random() * 50 + 20 });
        }
        
        await page.waitForTimeout(1000);
        
        // Send message
        await page.keyboard.press('Enter');
        logMessage(`[${taskId}] ✅ Message sent!`, userId);
        
        await page.waitForTimeout(2000);
        await browser.close();
        
        return true;
        
    } catch (error) {
        logMessage(`[${taskId}] ❌ Error: ${error.message}`, userId);
        if (browser) {
            await browser.close();
        }
        return false;
    }
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/start', upload.fields([
    { name: 'cookies_file', maxCount: 1 },
    { name: 'messages_file', maxCount: 1 },
    { name: 'conversations_file', maxCount: 1 }
]), async (req, res) => {
    try {
        const userId = req.session.userId || uuidv4();
        req.session.userId = userId;
        
        const taskId = generateTaskId();
        const batchCount = parseInt(req.body.batch_count) || 1;
        const batchDelay = parseInt(req.body.batch_delay) || 30;
        const timeDelay = parseInt(req.body.time_delay) || 10;
        
        // Parse inputs
        let cookies = [];
        if (req.body.cookies_text) {
            cookies = req.body.cookies_text.split('\n').filter(line => line.trim());
        }
        if (req.files && req.files.cookies_file) {
            const fileContent = req.files.cookies_file[0].buffer.toString();
            cookies = cookies.concat(fileContent.split('\n').filter(line => line.trim()));
        }
        
        let messages = [];
        if (req.body.messages_text) {
            messages = req.body.messages_text.split('\n').filter(line => line.trim());
        }
        if (req.files && req.files.messages_file) {
            const fileContent = req.files.messages_file[0].buffer.toString();
            messages = messages.concat(fileContent.split('\n').filter(line => line.trim()));
        }
        
        let conversations = [];
        if (req.body.conversations_text) {
            conversations = req.body.conversations_text.split('\n').filter(line => line.trim());
        }
        if (req.files && req.files.conversations_file) {
            const fileContent = req.files.conversations_file[0].buffer.toString();
            conversations = conversations.concat(fileContent.split('\n').filter(line => line.trim()));
        }
        
        if (cookies.length === 0 || messages.length === 0 || conversations.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Please provide cookies, messages, and conversations'
            });
        }
        
        // Create task
        const task = {
            id: taskId,
            userId: userId,
            cookies: cookies,
            messages: messages,
            conversations: conversations,
            batchCount: batchCount,
            batchDelay: batchDelay,
            timeDelay: timeDelay,
            status: 'running',
            progress: 0,
            sent: 0,
            failed: 0,
            total: cookies.length * messages.length * conversations.length * batchCount,
            startTime: new Date().toISOString()
        };
        
        tasks.set(taskId, task);
        
        // Start task in background
        (async () => {
            try {
                for (let batch = 0; batch < batchCount; batch++) {
                    logMessage(`[${taskId}] 🔄 Starting batch ${batch + 1}/${batchCount}`, userId);
                    
                    for (const cookieStr of cookies) {
                        const parsedCookies = parseCookies(cookieStr);
                        
                        for (const conversationId of conversations) {
                            for (const message of messages) {
                                if (task.status !== 'running') break;
                                
                                const enhancedMsg = enhanceMessage(message);
                                
                                logMessage(`[${taskId}] Sending: "${enhancedMsg.substring(0, 50)}..." → ${conversationId}`, userId);
                                
                                const success = await sendFacebookMessage(
                                    parsedCookies,
                                    conversationId,
                                    enhancedMsg,
                                    taskId,
                                    userId
                                );
                                
                                if (success) {
                                    task.sent++;
                                    logMessage(`[${taskId}] ✅ Sent successfully (${task.sent}/${task.total})`, userId);
                                } else {
                                    task.failed++;
                                    logMessage(`[${taskId}] ❌ Failed to send`, userId);
                                }
                                
                                task.progress = Math.round(((task.sent + task.failed) / task.total) * 100);
                                
                                // Update task in map
                                tasks.set(taskId, task);
                                
                                // Emit progress
                                io.to(userId).emit('taskProgress', {
                                    taskId: taskId,
                                    progress: task.progress,
                                    sent: task.sent,
                                    failed: task.failed,
                                    total: task.total
                                });
                                
                                // Delay between messages
                                await new Promise(resolve => 
                                    setTimeout(resolve, timeDelay * 1000)
                                );
                            }
                        }
                    }
                    
                    // Delay between batches (except for last batch)
                    if (batch < batchCount - 1) {
                        logMessage(`[${taskId}] ⏳ Waiting ${batchDelay} seconds before next batch...`, userId);
                        await new Promise(resolve => 
                            setTimeout(resolve, batchDelay * 1000)
                        );
                    }
                }
                
                // Task completed
                task.status = 'completed';
                task.endTime = new Date().toISOString();
                tasks.set(taskId, task);
                
                logMessage(`[${taskId}] 🏁 Task completed! Sent: ${task.sent}, Failed: ${task.failed}`, userId);
                
            } catch (error) {
                logMessage(`[${taskId}] 💥 Task error: ${error.message}`, userId);
                task.status = 'failed';
                tasks.set(taskId, task);
            }
        })();
        
        res.json({
            success: true,
            taskId: taskId,
            message: `Task ${taskId} started successfully!`
        });
        
    } catch (error) {
        console.error('Start task error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

app.post('/api/stop/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const task = tasks.get(taskId);
    
    if (task) {
        task.status = 'stopped';
        tasks.set(taskId, task);
        res.json({ success: true, message: `Task ${taskId} stopped` });
    } else {
        res.status(404).json({ success: false, message: 'Task not found' });
    }
});

app.get('/api/tasks', (req, res) => {
    const userId = req.session.userId;
    const userTasks = Array.from(tasks.values())
        .filter(task => task.userId === userId)
        .map(task => ({
            id: task.id,
            status: task.status,
            progress: task.progress,
            sent: task.sent,
            failed: task.failed,
            total: task.total,
            startTime: task.startTime,
            endTime: task.endTime
        }));
    
    res.json({ tasks: userTasks });
});

app.get('/api/logs', (req, res) => {
    res.json({ logs: systemLogs.slice(-100) });
});

// Socket.IO connection
io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    if (userId) {
        socket.join(userId);
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
