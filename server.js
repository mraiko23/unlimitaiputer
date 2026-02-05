/**
 * Puter AI API Server
 * Auth strategy: User provides token -> Server injects into Puppeteer
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
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
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        page = await browser.newPage();

        // Block heavy resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await loadPuterClient();
        isReady = true;
        console.log('[Browser] Ready');

        // Check initial auth status
        isLoggedIn = await page.evaluate(() => window.checkLogin());
        console.log(`[Browser] Logged in: ${isLoggedIn}`);

    } catch (e) {
        console.error('[Browser] Init failed:', e);
        process.exit(1); // Exit if browser fails so Render restarts
    }
}

async function loadPuterClient() {
    const clientHtml = `
    <!DOCTYPE html>
    <html>
    <head><script src="https://js.puter.com/v2/"></script></head>
    <body>
        <script>
            window.puterReady = false;
            window.checkLogin = () => puter.auth.isSignedIn();
            
            // Wait for puter
            const timer = setInterval(() => {
                if (typeof puter !== 'undefined' && puter.ai) {
                    window.puterReady = true;
                    clearInterval(timer);
                }
            }, 100);

            // Token injection
            window.loginWithToken = (token) => {
                localStorage.setItem('puter_token', token);
                localStorage.setItem('puter_token_expiry', Date.now() + 86400000); // Fake expiry
                location.reload();
            };

            window.doChat = async (p, o) => await puter.ai.chat(p, o);
            window.doImage = async (p, o) => await puter.ai.txt2img(p, o);
        </script>
    </body>
    </html>`;

    await page.setContent(clientHtml);
    await page.waitForFunction(() => window.puterReady === true, { timeout: 30000 });
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
