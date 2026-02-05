/**
 * Puter AI API Server with Server-Side Authentication
 * Uses Puppeteer to maintain a browser session on the server
 * Login once via web interface, then API works for everyone
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');
const chatStore = require('./chat-store');

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://unlimitaiputer.onrender.com';

// Keep-alive ping every 90 seconds to prevent Render from sleeping
const PING_INTERVAL = 90 * 1000; // 90 seconds
function startKeepAlive() {
    setInterval(async () => {
        try {
            const url = RENDER_URL + '/api/health';
            const https = require('https');
            const http = require('http');
            const client = url.startsWith('https') ? https : http;

            client.get(url, (res) => {
                console.log(`[KeepAlive] Ping ${url} - Status: ${res.statusCode}`);
            }).on('error', (e) => {
                console.log(`[KeepAlive] Ping failed: ${e.message}`);
            });
        } catch (e) {
            console.log('[KeepAlive] Error:', e.message);
        }
    }, PING_INTERVAL);
    console.log(`[KeepAlive] Started - pinging ${RENDER_URL} every ${PING_INTERVAL / 1000}s`);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Global browser state
let browser = null;
let page = null;
let isReady = false;
let isLoggedIn = false;

// =====================
// Browser Management
// =====================

async function initBrowser() {
    console.log('[Browser] Launching...');

    browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Load the puter client page
    const clientHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <script src="https://js.puter.com/v2/"></script>
    </head>
    <body>
        <div id="status">Loading Puter.js...</div>
        <script>
            window.puterReady = false;
            window.isLoggedIn = false;

            // Wait for puter
            function checkPuter() {
                if (typeof puter !== 'undefined' && puter.ai) {
                    window.puterReady = true;
                    window.isLoggedIn = puter.auth.isSignedIn();
                    document.getElementById('status').textContent = 
                        window.isLoggedIn ? 'Logged in!' : 'Not logged in';
                } else {
                    setTimeout(checkPuter, 100);
                }
            }
            checkPuter();

            // Chat function
            window.doChat = async function(prompt, options) {
                if (!window.isLoggedIn) throw new Error('Not logged in');
                const result = await puter.ai.chat(prompt, options);
                if (typeof result === 'string') return { text: result };
                if (result.message?.content) {
                    if (Array.isArray(result.message.content)) {
                        return { text: result.message.content.map(c => c.text || '').join('') };
                    }
                    return { text: result.message.content };
                }
                if (result.text) return { text: result.text };
                return { text: JSON.stringify(result) };
            };

            // Image generation
            window.doImageGen = async function(prompt, options) {
                if (!window.isLoggedIn) throw new Error('Not logged in');
                const img = await puter.ai.txt2img(prompt, options);
                return { src: img.src };
            };

            // Sign in
            window.doSignIn = function() {
                return puter.auth.signIn();
            };

            // Check login
            window.checkLogin = function() {
                window.isLoggedIn = puter.auth.isSignedIn();
                return window.isLoggedIn;
            };
        </script>
    </body>
    </html>`;

    await page.setContent(clientHtml);

    // Wait for Puter to load
    console.log('[Browser] Waiting for Puter.js...');
    await page.waitForFunction(() => window.puterReady === true, { timeout: 30000 });

    isReady = true;
    isLoggedIn = await page.evaluate(() => window.isLoggedIn);
    console.log(`[Browser] Ready! Logged in: ${isLoggedIn}`);
}

// =====================
// API Endpoints
// =====================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        browserReady: isReady,
        loggedIn: isLoggedIn
    });
});

// Get login status
app.get('/api/auth/status', (req, res) => {
    res.json({ loggedIn: isLoggedIn, ready: isReady });
});

// Trigger login popup (returns URL to show in iframe)
app.post('/api/auth/login', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'Browser not ready' });
    }

    try {
        // Trigger sign in and wait for popup
        const popupPromise = new Promise(resolve => {
            browser.once('targetcreated', async target => {
                if (target.type() === 'page') {
                    const popup = await target.page();
                    resolve(popup.url());
                }
            });
            setTimeout(() => resolve(null), 5000);
        });

        await page.evaluate(() => window.doSignIn());
        const popupUrl = await popupPromise;

        res.json({
            message: 'Login popup opened on server. Complete login in the iframe below.',
            popupUrl: popupUrl || 'https://puter.com/action/sign-in'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Check if login completed
app.get('/api/auth/check', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'Browser not ready' });
    }

    try {
        isLoggedIn = await page.evaluate(() => window.checkLogin());
        res.json({ loggedIn: isLoggedIn });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'Browser not ready' });
    }
    if (!isLoggedIn) {
        return res.status(401).json({ error: 'Not logged in. Use /api/auth/login first.' });
    }

    const { prompt, model = 'gemini-3-pro-preview', messages, stream = false, thinking = false } = req.body;

    if (!prompt && !messages) {
        return res.status(400).json({ error: 'prompt or messages required' });
    }

    try {
        const options = { model };
        if (thinking) options.thinking = true;
        if (stream) options.stream = true;

        const input = messages || prompt;
        const result = await page.evaluate(async (input, options) => {
            return await window.doChat(input, options);
        }, input, options);

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Image generation endpoint
app.post('/api/image/generate', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'Browser not ready' });
    }
    if (!isLoggedIn) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    const { prompt, model = 'black-forest-labs/FLUX.1-pro', quality } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'prompt required' });
    }

    try {
        const options = { model };
        if (quality) options.quality = quality;

        const result = await page.evaluate(async (prompt, options) => {
            return await window.doImageGen(prompt, options);
        }, prompt, options);

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Chat management
app.get('/api/chats', (req, res) => res.json(chatStore.getAllChats()));
app.post('/api/chats', (req, res) => {
    const { title, model } = req.body;
    res.status(201).json(chatStore.createChat(title, model));
});
app.get('/api/chats/:id', (req, res) => {
    const chat = chatStore.getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    res.json(chat);
});
app.delete('/api/chats/:id', (req, res) => {
    const deleted = chatStore.deleteChat(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================
// Startup
// =====================

async function start() {
    console.log('='.repeat(50));
    console.log('🚀 Puter AI API Server');
    console.log('='.repeat(50));

    // Start Express
    app.listen(PORT, () => {
        console.log(`Server: http://localhost:${PORT}`);
    });

    // Initialize browser
    try {
        await initBrowser();
        console.log('');
        console.log('Next steps:');
        if (!isLoggedIn) {
            console.log('  1. Open the URL in browser');
            console.log('  2. Click "Login to Puter" button');
            console.log('  3. Complete authentication');
            console.log('  4. API will work for everyone!');
        } else {
            console.log('  ✅ Already logged in! API is ready.');
        }
        console.log('='.repeat(50));
    } catch (e) {
        console.error('[Browser] Failed to initialize:', e.message);
    }

    // Start keep-alive ping
    startKeepAlive();
}

start();
