const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CONCURRENT_TASKS = 40; // Support 40-50 tasks
const MAX_TASKS_PER_USER = 10;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200
});
app.use('/api/', limiter);

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/plain', 'text/csv', 'application/octet-stream'];
    const allowedExtensions = ['.txt', '.csv', '.json'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .csv, and .json files are allowed'));
    }
  }
});

// Global state
const tasks = new Map();
const logs = new Map();
const taskQueue = [];
let activeTasks = 0;

// Emoji Unicode ranges for infinite variety
const EMOJI_RANGES = [
  [0x1F600, 0x1F64F], // Emoticons
  [0x1F300, 0x1F5FF], // Misc Symbols and Pictographs
  [0x1F680, 0x1F6FF], // Transport and Map
  [0x1F1E6, 0x1F1FF], // Flags
  [0x2600, 0x26FF],   // Misc symbols
  [0x2700, 0x27BF],   // Dingbats
  [0x1F900, 0x1F9FF], // Supplemental Symbols
  [0x1FA70, 0x1FAFF], // Symbols Extended-A
  [0x1F400, 0x1F4FF], // Animals & Nature
  [0x1F500, 0x1F5FF]  // Symbols
];

// Utility functions
function generateTaskId() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `h4rsh_${randomNum}`;
}

function getRandomEmoji() {
  const range = EMOJI_RANGES[Math.floor(Math.random() * EMOJI_RANGES.length)];
  const codePoint = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
  return String.fromCodePoint(codePoint);
}

function addLog(taskId, message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logEntry = `[${timestamp}] ${message}`;
  
  console.log(`[${taskId}] ${logEntry}`);
  
  if (!logs.has(taskId)) {
    logs.set(taskId, []);
  }
  
  const taskLogs = logs.get(taskId);
  taskLogs.push(`[${type.toUpperCase()}] ${logEntry}`);
  
  if (taskLogs.length > 500) {
    taskLogs.shift();
  }
  
  return logEntry;
}

function parseCookies(cookieString) {
  if (!cookieString || !cookieString.trim()) return [];
  
  const cookies = [];
  const lines = cookieString.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    
    // Handle name=value format
    if (trimmed.includes('=')) {
      const [name, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      
      if (name.trim() && value.trim()) {
        const cookieValue = value.split(';')[0].trim();
        cookies.push({
          name: name.trim(),
          value: cookieValue,
          domain: '.facebook.com',
          path: '/',
          secure: true,
          httpOnly: ['c_user', 'xs', 'fr', 'datr'].includes(name.trim())
        });
      }
    }
  }
  
  // Remove duplicates
  const uniqueCookies = [];
  const seen = new Set();
  for (const cookie of cookies) {
    const key = cookie.name;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCookies.push(cookie);
    }
  }
  
  return uniqueCookies;
}

function enhanceMessage(message) {
  if (!message || !message.trim()) return message;
  
  const words = message.trim().split(/\s+/);
  const enhancedWords = [];
  
  // Add emoji at start (40% chance)
  if (Math.random() < 0.4) {
    enhancedWords.push(getRandomEmoji());
  }
  
  // Process words
  for (let i = 0; i < words.length; i++) {
    enhancedWords.push(words[i]);
    
    // Add emoji between words (25% chance)
    if (Math.random() < 0.25 && i < words.length - 1) {
      enhancedWords.push(getRandomEmoji());
    }
  }
  
  // Add emoji at end (40% chance)
  if (Math.random() < 0.4) {
    enhancedWords.push(getRandomEmoji());
  }
  
  return enhancedWords.join(' ');
}

// Wait function replacement for waitForTimeout
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  const runningTasks = Array.from(tasks.values()).filter(t => t.status === 'running').length;
  const queuedTasks = taskQueue.length;
  
  res.json({
    status: 'running',
    version: '2.0.0',
    activeTasks: activeTasks,
    runningTasks: runningTasks,
    queuedTasks: queuedTasks,
    totalTasks: tasks.size,
    maxConcurrent: MAX_CONCURRENT_TASKS,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/upload', upload.fields([
  { name: 'cookies_file', maxCount: 1 },
  { name: 'messages_file', maxCount: 1 }
]), (req, res) => {
  try {
    const result = {};
    
    if (req.files?.cookies_file) {
      const file = req.files.cookies_file[0];
      result.cookies = file.buffer.toString('utf-8');
      result.cookies_filename = file.originalname;
    }
    
    if (req.files?.messages_file) {
      const file = req.files.messages_file[0];
      result.messages = file.buffer.toString('utf-8');
      result.messages_filename = file.originalname;
    }
    
    res.json({ 
      success: true, 
      data: result,
      message: 'Files uploaded successfully'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/start-task', async (req, res) => {
  try {
    const {
      cookies,
      messages,
      conversation_id,
      batch_count = 1,
      batch_delay = 5,
      time_delay = 10,
      user_id = 'anonymous'
    } = req.body;
    
    // Validation
    if (!cookies || !cookies.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cookies are required' 
      });
    }
    
    if (!messages || !messages.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Messages are required' 
      });
    }
    
    if (!conversation_id || !conversation_id.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Conversation ID is required' 
      });
    }
    
    // Check task limits
    const userTaskCount = Array.from(tasks.values())
      .filter(t => t.user_id === user_id && t.status === 'running').length;
    
    if (userTaskCount >= MAX_TASKS_PER_USER) {
      return res.status(429).json({ 
        success: false, 
        error: `Maximum ${MAX_TASKS_PER_USER} tasks per user allowed` 
      });
    }
    
    const taskId = generateTaskId();
    
    // Parse inputs
    const parsedCookies = parseCookies(cookies);
    const messageList = messages.split('\n')
      .map(m => m.trim())
      .filter(m => m.length > 0);
    const conversationList = conversation_id.split('\n')
      .map(c => c.trim())
      .filter(c => c.length > 0);
    
    if (parsedCookies.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid cookies found. Format: name=value' 
      });
    }
    
    if (messageList.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid messages found' 
      });
    }
    
    if (conversationList.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid conversation IDs found' 
      });
    }
    
    const batchCount = Math.min(Math.max(1, parseInt(batch_count) || 1), 100);
    const batchDelay = Math.min(Math.max(1, parseInt(batch_delay) || 5), 300);
    const timeDelay = Math.min(Math.max(1, parseInt(time_delay) || 10), 600);
    
    const totalOperations = batchCount * messageList.length * conversationList.length;
    
    // Create task
    const task = {
      id: taskId,
      status: 'queued',
      progress: 0,
      total: totalOperations,
      completed: 0,
      success: 0,
      failed: 0,
      startTime: new Date().toISOString(),
      cookies: parsedCookies,
      messages: messageList,
      conversations: conversationList,
      batch_count: batchCount,
      batch_delay: batchDelay,
      time_delay: timeDelay,
      isStopped: false,
      user_id: user_id
    };
    
    tasks.set(taskId, task);
    logs.set(taskId, []);
    
    addLog(taskId, `Task created and queued`, 'info');
    addLog(taskId, `Cookies: ${parsedCookies.length}`, 'info');
    addLog(taskId, `Messages: ${messageList.length}`, 'info');
    addLog(taskId, `Conversations: ${conversationList.length}`, 'info');
    addLog(taskId, `Total operations: ${totalOperations}`, 'info');
    
    // Add to queue
    taskQueue.push(taskId);
    processTaskQueue();
    
    res.json({ 
      success: true, 
      taskId,
      status: 'queued',
      message: `Task ${taskId} queued successfully!`,
      details: {
        totalOperations,
        batchCount,
        batchDelay,
        timeDelay,
        positionInQueue: taskQueue.length
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error'
    });
  }
});

app.get('/api/task/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ 
      success: false, 
      error: 'Task not found' 
    });
  }
  
  res.json({
    success: true,
    task: {
      id: task.id,
      status: task.status,
      progress: task.progress,
      total: task.total,
      completed: task.completed,
      success: task.success,
      failed: task.failed,
      startTime: task.startTime,
      isStopped: task.isStopped,
      user_id: task.user_id
    }
  });
});

app.get('/api/logs/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const taskLogs = logs.get(taskId) || [];
  
  res.json({
    success: true,
    logs: taskLogs.slice(-100)
  });
});

app.get('/api/all-tasks', (req, res) => {
  const taskList = Array.from(tasks.entries()).map(([id, task]) => ({
    id: task.id,
    status: task.status,
    progress: task.progress,
    completed: task.completed,
    total: task.total,
    success: task.success,
    failed: task.failed,
    startTime: task.startTime,
    isStopped: task.isStopped,
    user_id: task.user_id
  }));
  
  const runningTasks = taskList.filter(t => t.status === 'running').length;
  const queuedTasks = taskQueue.length;
  
  res.json({
    success: true,
    tasks: taskList,
    total: taskList.length,
    running: runningTasks,
    queued: queuedTasks,
    active: activeTasks,
    maxConcurrent: MAX_CONCURRENT_TASKS
  });
});

app.post('/api/stop-task/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ 
      success: false, 
      error: 'Task not found' 
    });
  }
  
  task.isStopped = true;
  task.status = 'stopped';
  tasks.set(taskId, task);
  
  // Remove from queue if present
  const queueIndex = taskQueue.indexOf(taskId);
  if (queueIndex > -1) {
    taskQueue.splice(queueIndex, 1);
  }
  
  addLog(taskId, `Task stopped by user`, 'warning');
  
  res.json({ 
    success: true, 
    message: `Task ${taskId} stopped successfully` 
  });
});

app.post('/api/stop-all-tasks', (req, res) => {
  let stoppedCount = 0;
  
  for (const [taskId, task] of tasks.entries()) {
    if (task.status === 'running' || task.status === 'queued') {
      task.isStopped = true;
      task.status = 'stopped';
      tasks.set(taskId, task);
      stoppedCount++;
      
      addLog(taskId, `Task stopped via stop-all`, 'warning');
    }
  }
  
  // Clear queue
  taskQueue.length = 0;
  activeTasks = 0;
  
  res.json({ 
    success: true, 
    message: `Stopped ${stoppedCount} tasks`,
    stoppedCount
  });
});

// Facebook message sending with improved stability
async function sendFacebookMessage(cookies, conversationId, message, taskId) {
  let browser = null;
  
  try {
    addLog(taskId, `Launching browser for ${conversationId}`, 'info');
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      ignoreHTTPSErrors: true,
      defaultViewport: null
    });
    
    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Add cookies
    if (cookies && cookies.length > 0) {
      addLog(taskId, `Adding ${cookies.length} cookies`, 'info');
      
      const validCookies = cookies.filter(c => 
        c.name && c.value && 
        typeof c.name === 'string' && 
        typeof c.value === 'string'
      );
      
      if (validCookies.length > 0) {
        await page.setCookie(...validCookies);
        addLog(taskId, `Added ${validCookies.length} cookies`, 'success');
      }
    }
    
    // Navigate to Facebook homepage first to activate cookies
    addLog(taskId, `Navigating to Facebook...`, 'info');
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await wait(3000);
    
    // Check login status
    const isLoggedIn = await page.evaluate(() => {
      const checkSelectors = [
        'a[aria-label="Profile"]',
        'a[aria-label="Your profile"]',
        '[data-testid="royal_profile"]',
        'div[aria-label="Account"]',
        'div[role="navigation"]'
      ];
      
      return checkSelectors.some(selector => 
        document.querySelector(selector) !== null
      ) || document.cookie.includes('c_user=');
    });
    
    if (!isLoggedIn) {
      throw new Error('Login failed - invalid or expired cookies');
    }
    
    addLog(taskId, 'Login successful', 'success');
    
    // Navigate to conversation (supports both group and individual)
    addLog(taskId, `Opening conversation: ${conversationId}`, 'info');
    
    // Try different URL patterns for group/e2e
    const urlPatterns = [
      `https://www.facebook.com/messages/t/${conversationId}`,
      `https://www.facebook.com/${conversationId}`,
      `https://m.facebook.com/messages/t/${conversationId}`
    ];
    
    let navigationSuccess = false;
    for (const url of urlPatterns) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });
        await wait(4000);
        navigationSuccess = true;
        break;
      } catch (e) {
        continue;
      }
    }
    
    if (!navigationSuccess) {
      throw new Error('Failed to navigate to conversation');
    }
    
    // Wait for message input with multiple selectors
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      'div[aria-label*="Message" i]',
      'div[aria-placeholder*="message" i]',
      'div[data-text="true"]',
      'div[spellcheck="true"][contenteditable="true"]'
    ];
    
    let messageInput = null;
    for (const selector of selectors) {
      try {
        const element = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
        if (element) {
          const isVisible = await page.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && 
                   window.getComputedStyle(el).display !== 'none';
          }, element);
          
          if (isVisible) {
            messageInput = element;
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!messageInput) {
      throw new Error('Message input not found');
    }
    
    addLog(taskId, 'Found message input', 'success');
    
    // Type message
    addLog(taskId, `Typing: ${message.substring(0, 50)}...`, 'info');
    
    await messageInput.click();
    await wait(1000);
    
    // Clear any existing text
    await page.evaluate(el => {
      el.textContent = '';
      el.innerHTML = '';
    }, messageInput);
    
    await wait(500);
    
    // Type message with delay
    await messageInput.type(message, { delay: 30 });
    await wait(1000);
    
    // Try to send with multiple methods
    const sendSelectors = [
      'div[aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      'div[data-testid*="send"]',
      'div[role="button"][aria-label*="Send" i]',
      'div[aria-label="Press Enter to send"]',
      'svg[aria-label="Send"]',
      'path[d*="M16"]' // Send icon SVG path
    ];
    
    let sent = false;
    for (const selector of sendSelectors) {
      try {
        const sendButton = await page.$(selector);
        if (sendButton) {
          await sendButton.click();
          addLog(taskId, `Clicked send button`, 'success');
          sent = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    // Fallback: press Enter
    if (!sent) {
      addLog(taskId, 'Using Enter key fallback', 'info');
      await page.keyboard.press('Enter');
    }
    
    await wait(2000);
    
    // Verify message was sent
    const isCleared = await page.evaluate((selector) => {
      const input = document.querySelector(selector);
      return input ? input.textContent.trim() === '' : true;
    }, selectors[0]);
    
    if (isCleared) {
      addLog(taskId, 'Message sent successfully!', 'success');
    } else {
      addLog(taskId, 'Message may not have sent', 'warning');
    }
    
    await browser.close();
    return true;
    
  } catch (error) {
    addLog(taskId, `Error: ${error.message}`, 'error');
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    
    return false;
  }
}

// Task processor
async function processTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  
  try {
    task.status = 'running';
    activeTasks++;
    tasks.set(taskId, task);
    
    addLog(taskId, `Task started processing`, 'info');
    
    for (let batch = 0; batch < task.batch_count; batch++) {
      if (task.isStopped) break;
      
      addLog(taskId, `Batch ${batch + 1}/${task.batch_count}`, 'info');
      
      for (const conversation of task.conversations) {
        if (task.isStopped) break;
        
        for (const message of task.messages) {
          if (task.isStopped) break;
          
          const enhancedMessage = enhanceMessage(message);
          const success = await sendFacebookMessage(
            task.cookies,
            conversation,
            enhancedMessage,
            taskId
          );
          
          task.completed++;
          task.progress = Math.round((task.completed / task.total) * 100);
          
          if (success) {
            task.success++;
          } else {
            task.failed++;
          }
          
          tasks.set(taskId, task);
          
          // Delay between messages
          if (task.completed < task.total && !task.isStopped) {
            await wait(task.time_delay * 1000);
          }
        }
      }
      
      // Delay between batches
      if (batch < task.batch_count - 1 && !task.isStopped) {
        addLog(taskId, `Waiting ${task.batch_delay}s for next batch`, 'info');
        await wait(task.batch_delay * 1000);
      }
    }
    
    // Finalize
    if (!task.isStopped) {
      task.status = 'completed';
      addLog(taskId, `✅ Task completed! Success: ${task.success}, Failed: ${task.failed}`, 'success');
    } else {
      task.status = 'stopped';
      addLog(taskId, `⏹️ Task stopped`, 'warning');
    }
    
  } catch (error) {
    task.status = 'error';
    addLog(taskId, `❌ Task error: ${error.message}`, 'error');
  } finally {
    activeTasks--;
    tasks.set(taskId, task);
    processTaskQueue(); // Start next task
  }
}

// Task queue processor
async function processTaskQueue() {
  while (activeTasks < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
    const taskId = taskQueue.shift();
    const task = tasks.get(taskId);
    
    if (task && task.status === 'queued' && !task.isStopped) {
      processTask(taskId).catch(error => {
        console.error(`Task ${taskId} failed:`, error);
      });
    }
  }
}

// Cleanup old tasks
setInterval(() => {
  try {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    for (const [taskId, task] of tasks.entries()) {
      const taskTime = new Date(task.startTime);
      if (taskTime < cutoffTime && task.status !== 'running') {
        tasks.delete(taskId);
        logs.delete(taskId);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 30 * 60 * 1000); // Every 30 minutes

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Demons Slayer Server v2.0`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`⚡ Max concurrent tasks: ${MAX_CONCURRENT_TASKS}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
        
