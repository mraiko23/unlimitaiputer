/**
 * Puter AI API Server
 * Strategy: Zero-Downtime Session Pool
 * - Maintains 2 concurrent browser sessions (Active + Backup).
 * - On Limit (429/Quota): Instantly switches to Backup, kills Old, spawns New Backup.
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
// Keep-alive ping
const PING_INTERVAL = 90 * 1000; // 90 seconds (1.5 minutes)
function startKeepAlive() {
    setInterval(() => {
        try {
            const http = RENDER_URL.startsWith('https') ? require('https') : require('http');
            console.log('[KeepAlive] Pinging self...');
            http.get(`${RENDER_URL}/api/health`, (res) => { }).on('error', () => { });
        } catch (e) { }
    }, PING_INTERVAL);
}

// =====================
// Session Manager
// =====================

class BrowserSession {
    constructor(id) {
        this.id = id;
        this.browser = null;
        this.page = null;
        this.isReady = false;
        this.status = 'initializing'; // initializing, ready, dead
    }

    async init() {
        console.log(`[Session #${this.id}] Launching...`);
        try {
            let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            if (!executablePath || !fs.existsSync(executablePath)) {
                const localPaths = [
                    // Windows
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    // Linux (Render, Ubuntu, etc)
                    '/usr/bin/google-chrome',
                    '/usr/bin/google-chrome-stable',
                    '/usr/bin/chromium',
                    '/usr/bin/chromium-browser',
                    // macOS
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                ];
                for (const p of localPaths) {
                    if (fs.existsSync(p)) { executablePath = p; break; }
                }
            }

            if (!executablePath) {
                throw new Error('Chrome not found! Set PUPPETEER_EXECUTABLE_PATH env var.');
            }

            // Use headless on Render (production)
            const isProduction = process.env.NODE_ENV === 'production';

            this.browser = await puppeteer.launch({
                headless: isProduction ? 'new' : false,
                defaultViewport: null,
                dumpio: true, // Show browser console logs in terminal
                executablePath,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--start-maximized',
                    '--incognito',
                    '--disable-blink-features=AutomationControlled',
                    // Render/Headless optimizations
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--enable-unsafe-swiftshader',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-extensions'
                ]
            });

            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

            console.log(`[Session #${this.id}] Navigating to puter.com...`);
            await this.page.goto('https://puter.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(`[Session #${this.id}] Nav warning:`, e.message));

            await this.waitForLogin();

        } catch (e) {
            console.error(`[Session #${this.id}] FATAL INIT ERROR:`, e.message);
            this.close();
            throw e;
        }
    }

    async waitForLogin() {
        console.log(`[Session #${this.id}] Waiting for Guest Login...`);
        let loggedIn = false;

        for (let i = 0; i < 40; i++) { // 80 seconds max
            await new Promise(r => setTimeout(r, 2000));

            // 1. Clicker Logic
            try {
                await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const startBtn = buttons.find(b =>
                        b.innerText.match(/Get Started|Start|Guest|Try/i) && b.offsetParent !== null
                    );
                    if (startBtn) startBtn.click();
                });
            } catch (e) { }

            // 2. Inject & Check
            await this.injectHelpers();

            // Check Visual & API & Token
            const status = await this.page.evaluate(() => {
                const visual = window.checkLogin();
                // We strictly need the token now
                const hasToken = (typeof puter !== 'undefined' && (puter.authToken || puter.token));
                const api = (typeof puter !== 'undefined' && !!puter.ai);
                return { visual, api, hasToken };
            });

            if (status.visual) {
                if (status.api && status.hasToken) {
                    loggedIn = true;
                    break;
                } else {
                    console.log(`[Session #${this.id}] Visual OK, waiting for API/Token... (API: ${status.api}, Token: ${status.hasToken})`);
                }
            }

            // Reload if stuck
            if (i === 15 && !status.visual) {
                console.log(`[Session #${this.id}] Stuck? Reloading...`);
                await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
            }
        }

        if (loggedIn) {
            // Extract and log token info
            const tokenInfo = await this.page.evaluate(() => {
                // TRY 1: Get directly from Puter object (Best)
                let token = null;
                if (typeof puter !== 'undefined') {
                    token = puter.authToken || puter.token;
                }

                // TRY 2: LocalStorage fallback
                if (!token) {
                    token = localStorage.getItem('puter.auth.token') ||
                        localStorage.getItem('token') ||
                        localStorage.getItem('puter_token');
                }

                // Debug log in browser console
                console.log('ANTIGRAVITY DEBUG: Found Token:', token);

                const user = localStorage.getItem('puter.auth.user');
                return {
                    hasToken: !!token,
                    tokenPreview: token ? token.substring(0, 50) + '...' : null,
                    user: user ? JSON.parse(user).username : 'Guest'
                };
            });
            console.log(`[Session #${this.id}] READY! ✅`);
            console.log(`[Session #${this.id}] User: ${tokenInfo.user}, Token: ${tokenInfo.hasToken ? tokenInfo.tokenPreview : 'NONE'}`);
            this.isReady = true;
            this.status = 'ready';
        } else {
            console.warn(`[Session #${this.id}] Login Timed Out. ❌`);

            // Debug: What is on the page?
            try {
                const title = await this.page.title();
                const body = await this.page.evaluate(() => document.body.innerText.substring(0, 200));
                console.log(`[Session #${this.id}] TIMEOUT STATE - Title: "${title}", Content: "${body.replace(/\n/g, ' ')}..."`);
            } catch (e) { }

            throw new Error('Login Timeout');
        }
    }

    async injectHelpers() {
        if (!this.page) return;
        await this.page.evaluate(() => {
            window.puterReady = true;
            window.checkLogin = () => {
                // Strict check for token
                if (typeof puter !== 'undefined' && (puter.authToken || puter.token)) return true;
                if (localStorage.getItem('puter.auth.token') || localStorage.getItem('token')) return true;
                return false;
            };
            window.doChat = async (prompt, model) => {
                if (typeof puter === 'undefined' || !puter.ai) {
                    throw new Error('Puter.ai not available. Token: ' + (localStorage.getItem('puter.auth.token') ? 'exists' : 'missing'));
                }
                try {
                    return await puter.ai.chat(prompt, { model });
                } catch (e) {
                    throw new Error('Chat error: ' + e.message);
                }
            };
            window.doImage = async (prompt, model) => {
                if (typeof puter === 'undefined' || !puter.ai) {
                    throw new Error('Puter.ai not available');
                }
                return await puter.ai.txt2img(prompt, { model });
            };
        });
    }

    async close() {
        this.status = 'dead';
        this.isReady = false;
        if (this.browser) {
            console.log(`[Session #${this.id}] Closing browser...`);
            await this.browser.close().catch(() => { });
        }
    }
}

class SessionPool {
    constructor(size = 1) { // REDUCED: 1 browser for 512MB Render free tier
        this.size = size;
        this.pool = []; // Queue of Session objects
        this.counter = 0;
        this.failedAttempts = 0;
        this.maxFailedAttempts = 10; // Stop trying after 10 consecutive failures
    }

    async init() {
        console.log(`[Pool] Initializing ${this.size} sessions...`);
        const promises = [];
        for (let i = 0; i < this.size; i++) {
            promises.push(this.addSession());
        }
        // Wait for at least one to be ready? No, just start them.
        // But we want to block server start until at least one is ready ideally, 
        // OR we just let requests wait.
    }

    async addSession() {
        if (this.failedAttempts >= this.maxFailedAttempts) {
            console.error('[Pool] Max failed attempts reached. Stopping session creation.');
            return null;
        }

        this.counter++;
        const s = new BrowserSession(this.counter);
        this.pool.push(s);

        // Start init in background, but handle error by removing
        s.init().then(() => {
            this.failedAttempts = 0; // Reset on success
        }).catch(e => {
            console.error(`[Pool] Session #${s.id} failed to init. Removing.`);
            this.removeSession(s);
            this.failedAttempts++;

            // Only retry if under limit
            if (this.failedAttempts < this.maxFailedAttempts) {
                setTimeout(() => this.addSession(), 10000); // 10s delay between retries
            }
        });

        return s;
    }

    removeSession(s) {
        const idx = this.pool.indexOf(s);
        if (idx !== -1) {
            this.pool.splice(idx, 1);
        }
        s.close();
    }

    async getActiveSession() {
        // Find first Ready session
        let s = this.pool.find(s => s.isReady);

        if (!s) {
            // No ready session? Wait a bit
            console.warn('[Pool] No active session ready, waiting...');
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000));
                s = this.pool.find(s => s.isReady);
                if (s) break;
            }
            if (!s) throw new Error('No available sessions ready. Please wait.');
        }
        return s;
    }

    async rotate(failedSession) {
        console.warn(`[Pool] 🔄 ROTATING! Removing #${failedSession.id} and switching to backup...`);

        // Remove the dead one
        this.removeSession(failedSession);

        // Immediately spawn a new backup
        this.addSession();

        // The next request will automatically pick up the next ready session in the pool
        // We assume the backup (#2) is already ready or close to it.
        const next = this.pool.find(s => s.isReady);
        if (next) console.log(`[Pool] Switched to Session #${next.id} ✅`);
        else console.warn(`[Pool] Backup session not ready yet! ⚠️`);
    }
}

// Global Pool - 1 browser for 512MB free tier
const sessionPool = new SessionPool(1);

// =====================
// Endpoints
// =====================

app.get('/api/health', (req, res) => {
    const readyCount = sessionPool.pool.filter(s => s.isReady).length;
    res.json({ status: 'ok', readySessions: readyCount, totalSessions: sessionPool.pool.length });
});

async function executeInSession(actionName, actionFn) {
    // Get Session
    const session = await sessionPool.getActiveSession();

    try {
        // Ensure helpers are injected just in case
        await session.injectHelpers();

        // Run
        return await actionFn(session);
    } catch (e) {
        const errStr = e.toString().toLowerCase();
        if (errStr.includes('limit') || errStr.includes('quota') || errStr.includes('429')) {
            console.warn(`[${actionName}] HIT LIMIT on Session #${session.id}!`);

            // Setup rotation
            sessionPool.rotate(session);

            // Retry immediately? 
            // Yes, get a NEW session (the backup) and retry
            console.log(`[${actionName}] Retrying with backup session...`);
            const newSession = await sessionPool.getActiveSession();
            await newSession.injectHelpers();
            return await actionFn(newSession);
        }
        throw e;
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        let { prompt, model, messages, system } = req.body;

        // Construct messages logic
        if (!messages) {
            messages = [];
            if (system) messages.push({ role: 'system', content: system });
            if (prompt) messages.push({ role: 'user', content: prompt });
        } else {
            if (system && messages.length > 0 && messages[0].role !== 'system') {
                messages.unshift({ role: 'system', content: system });
            }
        }
        const input = messages.length > 0 ? messages : prompt;

        const result = await executeInSession('Chat', async (session) => {
            return await session.page.evaluate(async (i, m) => window.doChat(i, m), input, model || 'gemini-2.0-flash');
        });

        // Process result
        let text = '';
        if (typeof result === 'string') text = result;
        else if (result?.message?.content) text = Array.isArray(result.message.content) ? result.message.content.map(c => c.text).join('') : result.message.content;
        else if (result?.text) text = result.text;
        else text = JSON.stringify(result);

        res.json({ text, full: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/image/generate', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        const result = await executeInSession('Image', async (session) => {
            return await session.page.evaluate(async (p, m) => window.doImage(p, m), prompt, model || 'black-forest-labs/FLUX.1-pro');
        });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bind
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);

    // Start Pool
    sessionPool.init();

    // KeepAlive
    // ...
});
