/**
 * Puter AI API Server
 * Auth strategy: User provides token -> Server injects into Puppeteer
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

        // Auto-discover Chrome if not set or invalid
        if (!executablePath || !fs.existsSync(executablePath)) {
            console.log('[Browser] Searching for Chrome in .cache...');
            const cacheDir = path.join(__dirname, '.cache', 'puppeteer', 'chrome');
            if (fs.existsSync(cacheDir)) {
                // Find any linux-* directory
                const versions = fs.readdirSync(cacheDir).filter(f => f.startsWith('linux-'));
                if (versions.length > 0) {
                    // Use the first one found (usually only one)
                    executablePath = path.join(cacheDir, versions[0], 'chrome-linux64', 'chrome');
                    console.log(`[Browser] Found Chrome at: ${executablePath}`);
                }
            }
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

        if (executablePath) {
            launchOptions.executablePath = executablePath;
        }

        browser = await puppeteer.launch(launchOptions);
        page = await browser.newPage();

        // Block heavy resources to speed up puter.com load
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type) || req.url().includes('google-analytics')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log('[Browser] Navigating to https://puter.com...');
        await page.goto('https://puter.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Inject helpers
        await injectHelpers();

        isReady = true;
        console.log('[Browser] Ready');

        // Check if we are already logged in (from previous session/cookies)
        isLoggedIn = await page.evaluate(() => window.checkLogin());
        console.log(`[Browser] Initial Status: ${isLoggedIn ? 'Logged In' : 'Guest'}`);

    } catch (e) {
        console.error('[Browser] Init failed:', e);
        process.exit(1);
    }
}

async function injectHelpers() {
    await page.evaluate(() => {
        window.puterReady = true; // Use existing puter instance on the page

        window.checkLogin = () => {
            // Check specific storage keys that indicate login
            return !!(localStorage.getItem('token') || localStorage.getItem('puter_token'));
        };

        window.loginWithToken = (token) => {
            // Set all known keys
            localStorage.setItem('token', token);
            localStorage.setItem('puter_token', token);
            // Reload to apply
            window.location.reload();
        };

        // API wrappers using the global 'puter' object present on the site
        window.doChat = async (prompt, model) => {
            // Need to ensure puter lib is available
            if (typeof puter === 'undefined') throw new Error('Puter lib not found');
            return await puter.ai.chat(prompt, { model: model });
        };

        window.doImage = async (prompt, model) => {
            if (typeof puter === 'undefined') throw new Error('Puter lib not found');
            return await puter.ai.txt2img(prompt, { model: model });
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
        await page.evaluate((t) => {
            localStorage.setItem('puter_auth_token', t); // Try standard name
            // Also try puter cookie via header injection in real scenarios, 
            // but for Puter.js, localStorage is usually key.
            // Puter.js v2 often uses 'puter_token' or internal storage.
            // Let's try setting the common keys.
            localStorage.setItem('token', t);
        }, token);

        // We might need to set a cookie too
        await page.setCookie({
            name: 'token',
            value: token,
            domain: '.puter.com'
        });

        // Forced reload to pick up auth
        await page.reload();
        await page.waitForFunction(() => window.puterReady === true);

        // Wait a bit
        await new Promise(r => setTimeout(r, 2000));

        isLoggedIn = await page.evaluate(() => puter.auth.isSignedIn());
        console.log(`[Auth] Login result: ${isLoggedIn}`);

        res.json({ success: isLoggedIn });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chat', async (req, res) => {
    if (!isLoggedIn) return res.status(401).json({ error: 'Server not authenticated' });

    try {
        const { prompt, model, stream } = req.body;
        // ... (simplified for brevity)
        const result = await page.evaluate(async (p, m) => {
            return await puter.ai.chat(p, { model: m });
        }, prompt, model || 'gemini-3-pro-preview');

        // Extract text
        let text = result?.message?.content || result?.text || JSON.stringify(result);
        if (Array.isArray(text)) text = text.map(c => c.text).join('');

        res.json({ text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bind to 0.0.0.0 for Render
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    initBrowser();
    startKeepAlive();
});
