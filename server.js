const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['text/plain', 'text/csv', 'application/octet-stream'];
    if (allowedMimes.includes(file.mimetype) || 
        file.originalname.endsWith('.txt') || 
        file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt and .csv files are allowed'));
    }
  }
});

// Global state
const tasks = new Map();
const logs = new Map();
const allLogs = [];

// Emoji Unicode ranges (infinite variety)
const EMOJI_RANGES = [
  [0x1F600, 0x1F64F], // Emoticons
  [0x1F300, 0x1F5FF], // Misc Symbols and Pictographs
  [0x1F680, 0x1F6FF], // Transport and Map
  [0x1F1E6, 0x1F1FF], // Flags
  [0x2600, 0x26FF],   // Misc symbols
  [0x2700, 0x27BF],   // Dingbats
  [0x1F900, 0x1F9FF], // Supplemental Symbols and Pictographs
  [0x1FA70, 0x1FAFF]  // Symbols and Pictographs Extended-A
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

function addLog(message, type = 'info', taskId = null) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logEntry = `[${timestamp}] ${message}`;
  
  // Add to console
  console.log(`[${type.toUpperCase()}] ${logEntry}`);
  
  // Add to all logs
  allLogs.push(logEntry);
  if (allLogs.length > 1000) allLogs.shift();
  
  // Add to specific task logs
  if (taskId && logs.has(taskId)) {
    const taskLogs = logs.get(taskId);
    taskLogs.push(logEntry);
    if (taskLogs.length > 1000) taskLogs.shift();
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
    
    // Handle both "name=value" and JSON format
    if (trimmed.includes('=')) {
      const [name, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('='); // In case value contains '='
      
      if (name.trim() && value.trim()) {
        cookies.push({
          name: name.trim(),
          value: value.trim().split(';')[0], // Remove any trailing semicolon attributes
          domain: '.facebook.com',
          path: '/',
          secure: true,
          httpOnly: name.trim() === 'c_user' || name.trim() === 'xs' || name.trim() === 'fr'
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
  
  // Add random emoji at the beginning (40% chance)
  if (Math.random() < 0.4) {
    enhancedWords.push(getRandomEmoji());
  }
  
  // Process each word
  for (let i = 0; i < words.length; i++) {
    enhancedWords.push(words[i]);
    
    // Add random emoji between words (30% chance)
    if (Math.random() < 0.3 && i < words.length - 1) {
      enhancedWords.push(getRandomEmoji());
    }
  }
  
  // Add random emoji at the end (40% chance)
  if (Math.random() < 0.4) {
    enhancedWords.push(getRandomEmoji());
  }
  
  return enhancedWords.join(' ');
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  const activeTasks = Array.from(tasks.values()).filter(t => t.status === 'running').length;
  res.json({
    status: 'running',
    version: '1.0.0',
    activeTasks: activeTasks,
    totalTasks: tasks.size,
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
    console.error('Upload error:', error);
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
      time_delay = 10
    } = req.body;
    
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
      status: 'running',
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
      isStopped: false
    };
    
    tasks.set(taskId, task);
    logs.set(taskId, []);
    
    addLog(`Task ${taskId} started`, 'info', taskId);
    addLog(`Cookies: ${parsedCookies.length}`, 'info', taskId);
    addLog(`Messages: ${messageList.length}`, 'info', taskId);
    addLog(`Conversations: ${conversationList.length}`, 'info', taskId);
    addLog(`Total operations: ${totalOperations}`, 'info', taskId);
    
    // Start task in background (non-blocking)
    processTask(taskId).catch(err => {
      console.error(`Task ${taskId} error:`, err);
    });
    
    res.json({ 
      success: true, 
      taskId,
      message: `Task ${taskId} started successfully!`,
      details: {
        totalOperations,
        batchCount,
        batchDelay,
        timeDelay
      }
    });
    
  } catch (error) {
    console.error('Error starting task:', error);
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
      isStopped: task.isStopped
    }
  });
});

app.get('/api/logs/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const taskLogs = logs.get(taskId) || [];
  
  res.json({
    success: true,
    logs: taskLogs.slice(-50) // Return last 50 logs
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
    isStopped: task.isStopped
  }));
  
  res.json({
    success: true,
    tasks: taskList,
    total: taskList.length,
    active: taskList.filter(t => t.status === 'running').length
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
  
  addLog(`Task ${taskId} stopped by user`, 'warning', taskId);
  
  res.json({ 
    success: true, 
    message: `Task ${taskId} stopped successfully` 
  });
});

app.post('/api/stop-all-tasks', (req, res) => {
  let stoppedCount = 0;
  
  for (const [taskId, task] of tasks.entries()) {
    if (task.status === 'running') {
      task.isStopped = true;
      task.status = 'stopped';
      tasks.set(taskId, task);
      stoppedCount++;
      
      addLog(`Task ${taskId} stopped via stop-all`, 'warning', taskId);
    }
  }
  
  res.json({ 
    success: true, 
    message: `Stopped ${stoppedCount} running tasks`,
    stoppedCount
  });
});

// Puppeteer function
async function sendFacebookMessage(cookies, conversationId, message, taskId) {
  let browser = null;
  
  try {
    addLog(`Launching browser for conversation ${conversationId}`, 'info', taskId);
    
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
        '--window-size=1280,720'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
                     '/usr/bin/chromium' || 
                     null
    });
    
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Add cookies
    if (cookies && cookies.length > 0) {
      addLog(`Adding ${cookies.length} cookies`, 'info', taskId);
      
      // Filter out invalid cookies
      const validCookies = cookies.filter(c => 
        c.name && c.value && 
        typeof c.name === 'string' && 
        typeof c.value === 'string'
      );
      
      if (validCookies.length > 0) {
        await page.setCookie(...validCookies);
        addLog(`Added ${validCookies.length} valid cookies`, 'success', taskId);
      } else {
        addLog('No valid cookies to add', 'warning', taskId);
        throw new Error('No valid cookies');
      }
    }
    
    // Navigate to Facebook
    addLog(`Navigating to Facebook...`, 'info', taskId);
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait for page to load
    await page.waitForTimeout(3000);
    
    // Check if logged in
    const isLoggedIn = await page.evaluate(() => {
      const selectors = [
        'a[aria-label="Profile"]',
        'a[aria-label="Your profile"]',
        '[data-testid="royal_profile"]',
        'div[aria-label="Account"]',
        'div[role="navigation"] a[href*="profile.php"]'
      ];
      
      for (const selector of selectors) {
        if (document.querySelector(selector)) return true;
      }
      
      // Check for c_user cookie in page
      return document.cookie.includes('c_user=');
    });
    
    if (!isLoggedIn) {
      addLog('Not logged in - check cookies', 'error', taskId);
      throw new Error('Not logged in');
    }
    
    addLog('Successfully logged in', 'success', taskId);
    
    // Navigate to conversation
    addLog(`Opening conversation: ${conversationId}`, 'info', taskId);
    await page.goto(`https://www.facebook.com/messages/t/${conversationId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Wait for page to load
    await page.waitForTimeout(5000);
    
    // Try to find message input with multiple selectors
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      'div[aria-label*="Message" i]',
      'div[aria-placeholder*="message" i]'
    ];
    
    let messageInput = null;
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   el.offsetWidth > 0 && 
                   el.offsetHeight > 0;
          }, element);
          
          if (isVisible) {
            messageInput = element;
            addLog(`Found message input: ${selector}`, 'success', taskId);
            break;
          }
        }
      } catch (err) {
        // Continue with next selector
      }
    }
    
    if (!messageInput) {
      throw new Error('Message input not found');
    }
    
    // Type message
    addLog(`Typing message: ${message.substring(0, 50)}...`, 'info', taskId);
    await messageInput.click();
    await page.waitForTimeout(1000);
    
    // Clear any existing text
    await page.evaluate(el => {
      el.innerHTML = '';
    }, messageInput);
    
    await page.waitForTimeout(500);
    
    // Type the message character by character
    await messageInput.type(message, { delay: 50 });
    
    await page.waitForTimeout(1000);
    
    // Try to find and click send button
    const sendSelectors = [
      'div[aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      'div[data-testid*="send"]',
      'div[role="button"][aria-label*="Send" i]',
      'div[aria-label="Press Enter to send"]'
    ];
    
    let sent = false;
    for (const selector of sendSelectors) {
      try {
        const sendButton = await page.$(selector);
        if (sendButton) {
          await sendButton.click();
          addLog(`Clicked send button: ${selector}`, 'success', taskId);
          sent = true;
          break;
        }
      } catch (err) {
        // Continue with next selector
      }
    }
    
    // Fallback: press Enter
    if (!sent) {
      addLog('Using Enter key fallback', 'info', taskId);
      await messageInput.press('Enter');
    }
    
    await page.waitForTimeout(2000);
    
    // Verify message was sent
    const messageSent = await page.evaluate(() => {
      // Check if input is cleared
      const inputs = document.querySelectorAll('[contenteditable="true"]');
      for (const input of inputs) {
        if (input.textContent && input.textContent.trim().length > 0) {
          return false;
        }
      }
      return true;
    });
    
    if (messageSent) {
      addLog('Message sent successfully!', 'success', taskId);
    } else {
      addLog('Message may not have been sent', 'warning', taskId);
    }
    
    await browser.close();
    return messageSent;
    
  } catch (error) {
    addLog(`Error: ${error.message}`, 'error', taskId);
    
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        // Ignore close errors
      }
    }
    
    return false;
  }
}

// Task processor
async function processTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    addLog(`Task ${taskId} not found in processTask`, 'error', taskId);
    return;
  }
  
  try {
    addLog(`Starting task processing for ${taskId}`, 'info', taskId);
    
    for (let batch = 0; batch < task.batch_count; batch++) {
      if (task.isStopped) {
        addLog(`Task ${taskId} stopped by user`, 'warning', taskId);
        task.status = 'stopped';
        tasks.set(taskId, task);
        break;
      }
      
      addLog(`Starting batch ${batch + 1}/${task.batch_count}`, 'info', taskId);
      
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
            addLog(`✅ Sent to ${conversation}: ${enhancedMessage.substring(0, 50)}...`, 'success', taskId);
          } else {
            task.failed++;
            addLog(`❌ Failed to send to ${conversation}`, 'error', taskId);
          }
          
          // Update task in map
          tasks.set(taskId, task);
          
          // Delay between messages (if not last)
          if (task.completed < task.total && !task.isStopped) {
            await new Promise(resolve => 
              setTimeout(resolve, task.time_delay * 1000)
            );
          }
        }
      }
      
      // Delay between batches (if not last batch)
      if (batch < task.batch_count - 1 && !task.isStopped) {
        addLog(`Waiting ${task.batch_delay} seconds before next batch...`, 'info', taskId);
        await new Promise(resolve => 
          setTimeout(resolve, task.batch_delay * 1000)
        );
      }
    }
    
    // Finalize task status
    if (!task.isStopped) {
      task.status = 'completed';
      tasks.set(taskId, task);
      addLog(`🎉 Task completed! Success: ${task.success}, Failed: ${task.failed}`, 'success', taskId);
    }
    
  } catch (error) {
    task.status = 'error';
    tasks.set(taskId, task);
    addLog(`Task error: ${error.message}`, 'error', taskId);
  }
}

// Cleanup old tasks (older than 24 hours)
setInterval(() => {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    for (const [taskId, task] of tasks.entries()) {
      const taskTime = new Date(task.startTime);
      if (taskTime < twentyFourHoursAgo && 
          task.status !== 'running' && 
          !task.isStopped) {
        tasks.delete(taskId);
        logs.delete(taskId);
        addLog(`Cleaned up old task: ${taskId}`, 'info');
      }
    }
  } catch (error) {
    console.error('Error in cleanup:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Development mode enabled`);
  console.log(`🔗 http://localhost:${PORT}`);
  console.log(`⏰ Server time: ${new Date().toLocaleString()}`);
});
