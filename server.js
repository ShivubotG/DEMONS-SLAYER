const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { execSync } = require('child_process');
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Middleware
app.use(helmet());
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
    if (file.mimetype === 'text/plain' || file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only .txt and .csv files are allowed'));
    }
  }
});

// Global state
const tasks = new Map();
const logs = new Map();

// Chrome installation and setup function
async function setupChrome() {
  console.log('🔧 Setting up Chrome for Puppeteer...');
  
  try {
    // Method 1: Check if system Chromium is available
    let chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                    process.env.CHROME_PATH || 
                    process.env.CHROMIUM_PATH;
    
    if (!chromePath) {
      try {
        // Try to find chromium in common locations
        const locations = [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable'
        ];
        
        for (const location of locations) {
          try {
            await fs.access(location);
            chromePath = location;
            console.log(`✅ Found Chrome at: ${chromePath}`);
            break;
          } catch (e) {
            // Continue checking other locations
          }
        }
      } catch (error) {
        console.log('⚠️ Could not find Chrome in common locations');
      }
    }
    
    // Method 2: Install Chrome via Puppeteer if not found
    if (!chromePath) {
      console.log('📦 Installing Chrome via Puppeteer...');
      try {
        // Download Chrome using Puppeteer
        const { executablePath } = require('puppeteer');
        chromePath = await executablePath();
        console.log(`✅ Chrome installed via Puppeteer at: ${chromePath}`);
      } catch (error) {
        console.log('❌ Failed to install Chrome via Puppeteer:', error.message);
        
        // Method 3: Try to install system chromium
        try {
          console.log('📦 Trying to install system chromium...');
          execSync('apt-get update && apt-get install -y chromium chromium-sandbox', {
            stdio: 'inherit'
          });
          chromePath = '/usr/bin/chromium';
          console.log(`✅ System Chromium installed at: ${chromePath}`);
        } catch (e) {
          console.log('❌ Failed to install system chromium:', e.message);
        }
      }
    }
    
    if (chromePath) {
      process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
      console.log(`✅ Using Chrome executable: ${chromePath}`);
      return chromePath;
    } else {
      throw new Error('Could not find or install Chrome');
    }
    
  } catch (error) {
    console.error('❌ Chrome setup failed:', error);
    return null;
  }
}

// Utility functions
function generateTaskId() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `h4rsh_${randomNum}`;
}

function addLog(taskId, message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logMessage = `[${timestamp}] ${message}`;
  
  if (!logs.has(taskId)) {
    logs.set(taskId, []);
  }
  
  const taskLogs = logs.get(taskId);
  taskLogs.push(logMessage);
  
  // Keep only last 100 logs
  if (taskLogs.length > 100) {
    taskLogs.shift();
  }
  
  // Also log to console
  console.log(`[${taskId}] ${message}`);
}

function parseCookies(cookieString) {
  if (!cookieString) return [];
  
  const cookies = [];
  const lines = cookieString.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const parts = trimmed.split(';');
    const firstPart = parts[0].trim();
    
    if (firstPart.includes('=')) {
      const [name, value] = firstPart.split('=');
      if (name && value) {
        cookies.push({
          name: name.trim(),
          value: value.trim(),
          domain: '.facebook.com',
          path: '/',
          secure: true,
          httpOnly: name.trim() === 'c_user' || name.trim() === 'xs'
        });
      }
    }
  }
  
  return cookies;
}

function enhanceMessage(message) {
  const emojis = ['😈', '⚡', '🔥', '💀', '👿', '🤖', '🎭', '👹', '💥', '🦾'];
  const randomEmoji = () => emojis[Math.floor(Math.random() * emojis.length)];
  
  const words = message.split(' ');
  const enhancedWords = [];
  
  for (let i = 0; i < words.length; i++) {
    enhancedWords.push(words[i]);
    if (Math.random() < 0.3 && i < words.length - 1) {
      enhancedWords.push(randomEmoji());
    }
  }
  
  if (Math.random() < 0.5) {
    enhancedWords.unshift(randomEmoji());
  }
  if (Math.random() < 0.5) {
    enhancedWords.push(randomEmoji());
  }
  
  return enhancedWords.join(' ');
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (req, res) => {
  try {
    // Check Chrome availability
    let chromeStatus = 'unknown';
    let chromePath = null;
    
    try {
      chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      if (!chromePath) {
        // Try to find it
        try {
          execSync('which chromium', { stdio: 'pipe' });
          chromePath = '/usr/bin/chromium';
          process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
        } catch (e) {
          // Try google-chrome
          try {
            execSync('which google-chrome', { stdio: 'pipe' });
            chromePath = '/usr/bin/google-chrome';
            process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
          } catch (e2) {
            // Chrome not found
          }
        }
      }
      
      if (chromePath) {
        chromeStatus = 'available';
      } else {
        chromeStatus = 'not_found';
      }
    } catch (error) {
      chromeStatus = 'error';
    }
    
    res.json({
      status: 'running',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      chrome: {
        status: chromeStatus,
        path: chromePath || 'Not found'
      },
      puppeteer: '24.31.0'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/upload', upload.fields([
  { name: 'cookies_file', maxCount: 1 },
  { name: 'messages_file', maxCount: 1 }
]), (req, res) => {
  try {
    const result = {};
    
    if (req.files?.cookies_file) {
      result.cookies = req.files.cookies_file[0].buffer.toString();
    }
    
    if (req.files?.messages_file) {
      result.messages = req.files.messages_file[0].buffer.toString();
    }
    
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    
    if (!cookies || !messages || !conversation_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    // Setup Chrome before starting task
    const chromePath = await setupChrome();
    if (!chromePath) {
      return res.status(500).json({
        success: false,
        error: 'Chrome not available. Please check server logs.'
      });
    }
    
    const taskId = generateTaskId();
    
    // Parse inputs
    const parsedCookies = parseCookies(cookies);
    const messageList = messages.split('\n').filter(m => m.trim());
    const conversationList = conversation_id.split('\n').filter(c => c.trim());
    
    if (parsedCookies.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid cookies found' 
      });
    }
    
    // Create task
    const task = {
      id: taskId,
      status: 'running',
      progress: 0,
      total: batch_count * messageList.length * conversationList.length,
      completed: 0,
      success: 0,
      failed: 0,
      startTime: new Date().toISOString(),
      cookies: parsedCookies,
      messages: messageList,
      conversations: conversationList,
      batch_count: parseInt(batch_count),
      batch_delay: parseInt(batch_delay),
      time_delay: parseInt(time_delay),
      chromePath: chromePath
    };
    
    tasks.set(taskId, task);
    logs.set(taskId, []);
    
    addLog(taskId, `Task started with ID: ${taskId}`);
    addLog(taskId, `Chrome path: ${chromePath}`);
    addLog(taskId, `Cookies: ${parsedCookies.length}`);
    addLog(taskId, `Messages: ${messageList.length}`);
    addLog(taskId, `Conversations: ${conversationList.length}`);
    
    // Start task in background
    processTask(taskId);
    
    res.json({ 
      success: true, 
      taskId,
      message: `Task ${taskId} started successfully!` 
    });
    
  } catch (error) {
    console.error('Error starting task:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
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
      chromePath: task.chromePath
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

app.post('/api/stop-task/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ 
      success: false, 
      error: 'Task not found' 
    });
  }
  
  task.status = 'stopped';
  addLog(taskId, 'Task stopped by user');
  
  res.json({ 
    success: true, 
    message: `Task ${taskId} stopped` 
  });
});

// Improved Puppeteer function with better Chrome detection
async function sendFacebookMessage(cookies, conversationId, message, taskId) {
  let browser = null;
  
  try {
    addLog(taskId, `Launching browser...`);
    
    // Get Chrome executable path
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    if (!executablePath) {
      // Try to find Chrome
      try {
        const { executablePath: puppeteerPath } = require('puppeteer');
        executablePath = puppeteerPath();
        addLog(taskId, `Found Chrome via Puppeteer: ${executablePath}`);
      } catch (error) {
        addLog(taskId, `Warning: Could not get Chrome path from Puppeteer: ${error.message}`);
      }
    }
    
    const launchOptions = {
      headless: 'new', // Use new headless mode
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials'
      ]
    };
    
    // Add executable path if found
    if (executablePath) {
      launchOptions.executablePath = executablePath;
      addLog(taskId, `Using Chrome executable: ${executablePath}`);
    } else {
      addLog(taskId, 'Using default Chrome from Puppeteer');
    }
    
    browser = await puppeteer.launch(launchOptions);
    
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1366, height: 768 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    // Add cookies
    if (cookies && cookies.length > 0) {
      addLog(taskId, `Adding ${cookies.length} cookies...`);
      await page.setCookie(...cookies);
    }
    
    // Navigate to Facebook messages
    addLog(taskId, `Navigating to conversation: ${conversationId}`);
    await page.goto(`https://www.facebook.com/messages/t/${conversationId}`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    // Wait for page to load
    await page.waitForTimeout(5000);
    
    // Check if logged in with multiple selectors
    const selectors = [
      'a[aria-label="Profile"]',
      'a[aria-label="Your profile"]',
      '[data-testid="royal_profile"]',
      'div[aria-label="Account"]'
    ];
    
    let isLoggedIn = false;
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element) {
        isLoggedIn = true;
        addLog(taskId, `Logged in detected with selector: ${selector}`);
        break;
      }
    }
    
    if (!isLoggedIn) {
      // Check cookies in page context
      const cookiesInPage = await page.cookies();
      const hasFacebookCookie = cookiesInPage.some(cookie => 
        cookie.name === 'c_user' || cookie.name === 'xs'
      );
      
      if (hasFacebookCookie) {
        isLoggedIn = true;
        addLog(taskId, 'Logged in detected via cookies');
      }
    }
    
    if (!isLoggedIn) {
      throw new Error('Not logged in - check cookies');
    }
    
    addLog(taskId, 'Successfully logged in');
    
    // Find message input with multiple selectors
    const inputSelectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'div[aria-label*="Message" i][contenteditable="true"]'
    ];
    
    let messageInput = null;
    for (const selector of inputSelectors) {
      try {
        messageInput = await page.waitForSelector(selector, { timeout: 10000 });
        if (messageInput) {
          addLog(taskId, `Found message input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!messageInput) {
      throw new Error('Message input not found');
    }
    
    // Click and type message
    await messageInput.click();
    await page.waitForTimeout(1000);
    
    // Type the message
    addLog(taskId, `Typing message: ${message.substring(0, 50)}...`);
    await page.keyboard.type(message, { delay: 50 });
    
    // Find and click send button
    const sendSelectors = [
      'div[aria-label="Press Enter to send"]',
      'div[aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      'div[data-testid*="send"]'
    ];
    
    let sent = false;
    for (const selector of sendSelectors) {
      try {
        const sendButton = await page.$(selector);
        if (sendButton) {
          await sendButton.click();
          addLog(taskId, `Clicked send button: ${selector}`);
          sent = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!sent) {
      // Fallback: press Enter
      await page.keyboard.press('Enter');
      addLog(taskId, 'Used Enter key to send');
    }
    
    addLog(taskId, 'Message sent successfully!');
    await page.waitForTimeout(2000);
    
    await browser.close();
    return true;
    
  } catch (error) {
    addLog(taskId, `Error: ${error.message}`);
    
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
    for (let batch = 0; batch < task.batch_count; batch++) {
      if (task.status === 'stopped') break;
      
      addLog(taskId, `Starting batch ${batch + 1}/${task.batch_count}`);
      
      for (const conversation of task.conversations) {
        if (task.status === 'stopped') break;
        
        for (const message of task.messages) {
          if (task.status === 'stopped') break;
          
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
          
          // Update progress
          tasks.set(taskId, task);
          
          // Delay between messages
          if (task.completed < task.total) {
            await new Promise(resolve => 
              setTimeout(resolve, task.time_delay * 1000)
            );
          }
        }
      }
      
      // Delay between batches
      if (batch < task.batch_count - 1) {
        addLog(taskId, `Waiting ${task.batch_delay} seconds before next batch...`);
        await new Promise(resolve => 
          setTimeout(resolve, task.batch_delay * 1000)
        );
      }
    }
    
    task.status = 'completed';
    tasks.set(taskId, task);
    addLog(taskId, `Task completed! Success: ${task.success}, Failed: ${task.failed}`);
    
  } catch (error) {
    task.status = 'error';
    tasks.set(taskId, task);
    addLog(taskId, `Task error: ${error.message}`);
  }
}

// Cleanup old tasks (older than 24 hours)
setInterval(() => {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
  
  for (const [taskId, task] of tasks.entries()) {
    const taskTime = new Date(task.startTime);
    if (taskTime < twentyFourHoursAgo) {
      tasks.delete(taskId);
      logs.delete(taskId);
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Initialize Chrome on startup
async function initializeApp() {
  console.log('🚀 Demons Slayer Initializing...');
  console.log('🔧 Setting up Chrome...');
  
  const chromePath = await setupChrome();
  if (chromePath) {
    console.log(`✅ Chrome setup complete: ${chromePath}`);
  } else {
    console.log('⚠️ Chrome setup failed. Tasks may fail.');
  }
  
  // Start server
  app.listen(PORT, () => {
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`🛠️  Development mode enabled`);
  });
}

// Start the application
initializeApp();
