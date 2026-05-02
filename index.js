const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';
const expo = new Expo();

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Initialize data structure
const initData = {
  pushTokens: [],
  logs: [],
  availableCourts: [],
  lastCheck: null,
  botStatus: 'idle'
};

// Load or create data file
async function loadData() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('Creating new data file...');
    await saveData(initData);
    return initData;
  }
}

async function saveData(data) {
  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Add log entry
async function addLog(message, type = 'info') {
  const data = await loadData();
  const logEntry = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    message,
    type
  };
  data.logs.unshift(logEntry);
  // Keep only last 100 logs
  data.logs = data.logs.slice(0, 100);
  await saveData(data);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Send push notification
async function sendNotification(message, courts) {
  const data = await loadData();
  if (!data.pushTokens.length) {
    await addLog('No push tokens registered', 'warning');
    return;
  }

  const messages = data.pushTokens
    .filter(token => Expo.isExpoPushToken(token))
    .map(token => ({
      to: token,
      sound: 'default',
      title: 'Tennis Courts Available!',
      body: message,
      data: { courts }
    }));

  if (messages.length === 0) {
    await addLog('No valid push tokens', 'warning');
    return;
  }

  try {
    const chunks = expo.chunkPushNotifications(messages);
    const results = [];
    
    for (const chunk of chunks) {
      const result = await expo.sendPushNotificationsAsync(chunk);
      results.push(...result);
    }
    
    await addLog(`Sent ${messages.length} push notifications`, 'success');
  } catch (error) {
    await addLog(`Failed to send notifications: ${error.message}`, 'error');
  }
}

// Scrape court availability
async function scrapeCourts() {
  let browser;
  try {
    await addLog('Starting court availability check...', 'info');
    
    const data = await loadData();
    data.botStatus = 'running';
    data.lastCheck = new Date().toISOString();
    await saveData(data);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    // Navigate to SF Rec & Parks reservation system
    await page.goto('https://secure.rec.sf.gov/Account/Login?ReturnUrl=%2f', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    await addLog('Loaded SF Rec & Parks website', 'info');
    
    // Look for DiMaggio courts (simulate finding courts)
    // In a real implementation, you'd navigate through the booking system
    await page.waitForTimeout(2000);
    
    // Get upcoming Fridays
    const upcomingFridays = getUpcomingFridays();
    const availableCourts = [];
    
    for (const friday of upcomingFridays) {
      // Simulate checking availability for each Friday
      const dateStr = friday.toDateString();
      await addLog(`Checking availability for ${dateStr}`, 'info');
      
      // Simulate finding available courts (replace with real scraping logic)
      const mockAvailability = Math.random() > 0.7;
      if (mockAvailability) {
        const court = {
          date: dateStr,
          time: '10:00 AM - 12:00 PM',
          court: `Court ${Math.floor(Math.random() * 6) + 1}`,
          location: 'Joe DiMaggio Park',
          available: true
        };
        availableCourts.push(court);
        await addLog(`Found available court: ${court.court} on ${court.date}`, 'success');
      }
    }
    
    // Update data with results
    const updatedData = await loadData();
    const previousCount = updatedData.availableCourts.length;
    updatedData.availableCourts = availableCourts;
    updatedData.botStatus = 'idle';
    await saveData(updatedData);
    
    if (availableCourts.length > previousCount) {
      const newCourts = availableCourts.length - previousCount;
      const message = `Found ${newCourts} new available courts for upcoming Fridays!`;
      await sendNotification(message, availableCourts);
    }
    
    await addLog(`Scan complete. Found ${availableCourts.length} available courts`, 'success');
    
  } catch (error) {
    await addLog(`Scraping error: ${error.message}`, 'error');
    const data = await loadData();
    data.botStatus = 'error';
    await saveData(data);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Get next 4 Fridays
function getUpcomingFridays() {
  const fridays = [];
  const today = new Date();
  let current = new Date(today);
  
  // Find next Friday
  current.setDate(current.getDate() + (5 - current.getDay() + 7) % 7);
  if (current.getDay() === 5 && current <= today) {
    current.setDate(current.getDate() + 7);
  }
  
  for (let i = 0; i < 4; i++) {
    fridays.push(new Date(current));
    current.setDate(current.getDate() + 7);
  }
  
  return fridays;
}

// Schedule bot to run every 30 minutes
cron.schedule('*/30 * * * *', () => {
  console.log('Running scheduled court check...');
  scrapeCourts();
});

// API Routes
app.get('/', (req, res) => {
  res.json({ status: 'Court Bot Server Running', timestamp: new Date().toISOString() });
});

app.post('/register-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || !Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: 'Invalid push token' });
    }
    
    const data = await loadData();
    if (!data.pushTokens.includes(token)) {
      data.pushTokens.push(token);
      await saveData(data);
      await addLog(`New push token registered: ${token.substring(0, 20)}...`, 'info');
    }
    
    res.json({ success: true, message: 'Token registered successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register token' });
  }
});

app.get('/status', async (req, res) => {
  try {
    const data = await loadData();
    res.json({
      botStatus: data.botStatus,
      lastCheck: data.lastCheck,
      availableCourts: data.availableCourts.length,
      registeredTokens: data.pushTokens.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.get('/courts', async (req, res) => {
  try {
    const data = await loadData();
    res.json({
      courts: data.availableCourts,
      lastCheck: data.lastCheck
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get courts' });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const data = await loadData();
    res.json({
      logs: data.logs.slice(0, 50) // Return last 50 logs
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

app.post('/manual-check', async (req, res) => {
  try {
    // Run manual check in background
    setImmediate(scrapeCourts);
    res.json({ success: true, message: 'Manual check started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start manual check' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  addLog('Court Bot Server started', 'info');
  
  // Run initial check after 10 seconds
  setTimeout(() => {
    scrapeCourts();
  }, 10000);
});