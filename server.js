/**
 * Puter AI API Server
 * Auth strategy: User provides token -> Server injects into Puppeteer on puter.com origin
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const chatStore = require('./chat-store');

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Global state
let browser = null;
let page = null;
let isReady = false;
let isLoggedIn = false;

// Keep-alive ping
const PING_INTERVAL = 90 * 1000;
function startKeepAlive() {
    setInterval(() => {
        try {
            const http = RENDER_URL.startsWith('https') ? require('https') : require('http');
            http.get(`${RENDER_URL}/api/health`, (res) => {
                // console.log(`[KeepAlive] Status: ${res.statusCode}`);
            }).on('error', () => { });
        } catch (e) { }
    }, PING_INTERVAL);
}

// =====================
// Browser Setup
// =====================

async function initBrowser() {
    console.log('[Browser] Launching...');
    try {
        let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

        // Auto-discover Chrome (Render & Local)
        if (!executablePath || !fs.existsSync(executablePath)) {
            console.log('[Browser] Searching for Chrome...');

            // 1. Try Render Cache (Linux)
            const cacheDir = path.join(__dirname, '.cache', 'puppeteer', 'chrome');
            if (fs.existsSync(cacheDir)) {
                const versions = fs.readdirSync(cacheDir).filter(f => f.startsWith('linux-'));
                if (versions.length > 0) {
                    executablePath = path.join(cacheDir, versions[0], 'chrome-linux64', 'chrome');
                }
            }

            // 2. Try Standard System Paths (Windows/Mac/Linux fallback)
            if (!executablePath) {
                const platform = process.platform;
                const localPaths = [];
                if (platform === 'win32') {
                    localPaths.push(
                        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
                    );
                } else if (platform === 'darwin') {
                    localPaths.push(
                        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
                    );
                } else {
                    localPaths.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
                }

                for (const p of localPaths) {
                    if (fs.existsSync(p)) {
                        executablePath = p;
                        console.log(`[Browser] Found system browser: ${p}`);
                        break;
                    }
                }
            }
        }

        if (!executablePath) {
            console.warn('[Browser] Warning: Browser path not found. Puppeteer might fail launch.');
        }

        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions'
            ]
        };

        if (executablePath) launchOptions.executablePath = executablePath;

        browser = await puppeteer.launch(launchOptions);
        page = await browser.newPage();

        // ENABLE REQUEST INTERCEPTION FOR AUTH INJECTION
        await page.setRequestInterception(true);

        page.on('request', async (req) => {
            const url = req.url();
            const type = req.resourceType();

            // 1. Block heavy resources
            if (['image', 'stylesheet', 'font', 'media'].includes(type) || url.includes('google-analytics')) {
                return req.abort();
            }

            // 2. Inject Authorization Header for API calls
            if (url.includes('api.puter.com') || url.includes('/api/')) {
                const token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) {
                    const headers = req.headers();
                    headers['Authorization'] = `Bearer ${token}`;
                    return req.continue({ headers });
                }
            }

            req.continue();
        });

        console.log('[Browser] Navigating to https://puter.com...');
        try {
            await page.goto('https://puter.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log('[Browser] Navigation timeout (non-fatal).');
        }

        await injectHelpers();
        isReady = true;

        isLoggedIn = await page.evaluate(() => window.checkLogin());
        console.log(`[Browser] Ready. Logged in: ${isLoggedIn}`);

    } catch (e) {
        console.error('[Browser] Init failed:', e);
        // Don't exit process locally, but exit on render to force restart
        if (process.env.RENDER) process.exit(1);
    }
}

async function injectHelpers() {
    await page.evaluate(() => {
        window.puterReady = true;

        window.checkLogin = () => {
            return !!(localStorage.getItem('token') || localStorage.getItem('puter_token'));
        };

        window.injectToken = (token) => {
            localStorage.setItem('token', token);
            localStorage.setItem('puter_token', token);
            document.cookie = `token=${token}; path=/; domain=.puter.com; secure; samesite=lax`;
        };

        window.doChat = async (prompt, model) => {
            // Try to use puter instance if available
            if (typeof puter !== 'undefined' && puter.ai) {
                return await puter.ai.chat(prompt, { model });
            }
            throw new Error('Puter.js not ready');
        };

        window.doImage = async (prompt, model) => {
            if (typeof puter !== 'undefined' && puter.ai) {
                return await puter.ai.txt2img(prompt, { model });
            }
            throw new Error('Puter.js not ready');
        };
    });
}

// =====================
// Endpoints
// =====================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', ready: isReady, loggedIn: isLoggedIn });
});

app.post('/api/auth/token', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!isReady) return res.status(503).json({ error: 'Browser not ready' });

    try {
        console.log('[Auth] Injecting token...');

        // Inject
        await page.evaluate((t) => window.injectToken(t), token);

        // Reload to apply
        console.log('[Auth] Reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded' });

        // Re-inject helpers
        await injectHelpers();

        // Allow puter.js to initialize
        await new Promise(r => setTimeout(r, 3000));

        isLoggedIn = await page.evaluate(() => window.checkLogin());
        console.log(`[Auth] New status: ${isLoggedIn}`);

        res.json({ success: isLoggedIn });
    } catch (e) {
        console.error('[Auth] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chat', async (req, res) => {
    if (!isLoggedIn) return res.status(401).json({ error: 'Server not authenticated' });

    try {
        const { prompt, model = 'gemini-3-pro-preview', messages, stream = false } = req.body;

        const input = messages || prompt;
        if (!input) return res.status(400).json({ error: 'No prompt/messages' });

        const result = await page.evaluate(async (i, m) => {
            return await window.doChat(i, m);
        }, input, model);

        // Normalize response
        let text = '';
        if (typeof result === 'string') text = result;
        else if (result?.message?.content) {
            text = Array.isArray(result.message.content)
                ? result.message.content.map(c => c.text).join('')
                : result.message.content;
        } else if (result?.text) {
            text = result.text;
        } else {
            text = JSON.stringify(result);
        }

        res.json({ text, full: result });

    } catch (e) {
        console.error('[Chat] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/image/generate', async (req, res) => {
    if (!isLoggedIn) return res.status(401).json({ error: 'Not logged in' });
    try {
        const { prompt, model = 'black-forest-labs/FLUX.1-pro' } = req.body;
        const result = await page.evaluate(async (p, m) => {
            return await window.doImage(p, m);
        }, prompt, model);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Chat Management (Simple Store)
app.get('/api/chats', (req, res) => res.json(chatStore.getAllChats()));
app.post('/api/chats', (req, res) => {
    res.status(201).json(chatStore.createChat(req.body.title, req.body.model));
});

// Bind
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    // Delay browser launch slightly to let server start
    setTimeout(initBrowser, 1000);
    startKeepAlive();
});
