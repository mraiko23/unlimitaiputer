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

function findExecutable(dir) {
    if (!fs.existsSync(dir)) return null;
    try {
        const stats = fs.statSync(dir);
        if (!stats.isDirectory()) {
            // Check if this file is the binary
            if (dir.endsWith('chrome') || dir.endsWith('google-chrome') || dir.endsWith('chrome.exe')) return dir;
            return null;
        }

        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            // Skip suspicious folders to avoid infinite loops or permission issues
            if (file === '.' || file === '..') continue;

            const itemStats = fs.statSync(fullPath);
            if (itemStats.isDirectory()) {
                const found = findExecutable(fullPath);
                if (found) return found;
            } else if (file === 'chrome' || file === 'google-chrome' || file === 'chrome.exe') {
                return fullPath;
            }
        }
    } catch (e) { }
    return null;
}

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
                const searchDirs = [
                    'C:\\Program Files\\Google\\Chrome\\Application',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
                    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application',
                    '/usr/bin',
                    path.join(process.cwd(), '.cache', 'puppeteer')
                ];

                for (const dir of searchDirs) {
                    const found = findExecutable(dir);
                    if (found) { executablePath = found; break; }
                }
            }

            if (!executablePath) {
                console.error(`[Session #${this.id}] ❌ CRITICAL: Chrome executable not found!`);
                throw new Error('Chrome executable not found');
            }

            console.log(`[Session #${this.id}] Path: ${executablePath}`);

            // Fix permissions (important for Render/Linux)
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(executablePath, 0o755);
                    console.log(`[Session #${this.id}] Permissions set to 755`);
                } catch (e) { console.warn(`[Session #${this.id}] Failed to set permissions:`, e.message); }
            }

            this.browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                executablePath,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--start-maximized',
                    '--incognito',
                    '--disable-blink-features=AutomationControlled'
                ]
            });

            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

            console.log(`[Session #${this.id}] Navigating to puter.com...`);
            await this.page.goto('https://puter.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(`[Session #${this.id}] Nav warning:`, e.message));

            await this.waitForLogin();

        } catch (e) {
            console.error(`[Session #${this.id}] 🛑 FATAL INIT ERROR:`, e.message);
            await this.close();
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

            // Check Visual & API
            const status = await this.page.evaluate(() => {
                const visual = window.checkLogin(); // Visual check
                const api = (typeof puter !== 'undefined' && !!puter.ai);
                return { visual, api };
            });

            if (status.visual) {
                if (status.api) {
                    loggedIn = true;
                    break;
                }
            }

            // Reload if stuck
            if (i === 15 && !status.visual) {
                console.log(`[Session #${this.id}] Stuck? Reloading...`);
                await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
            }
        }

        if (loggedIn) {
            console.log(`[Session #${this.id}] READY! ✅`);
            this.isReady = true;
            this.status = 'ready';
        } else {
            console.warn(`[Session #${this.id}] Login Timed Out. ❌`);
            throw new Error('Login Timeout');
        }
    }

    async injectHelpers() {
        if (!this.page) return;
        await this.page.evaluate(() => {
            window.puterReady = true;
            window.checkLogin = () => {
                if (typeof puter !== 'undefined' && puter.ai) return true;
                if (localStorage.getItem('token') || localStorage.getItem('puter_token')) return true;
                if (document.querySelector('.taskbar') || document.querySelector('#desktop')) return true;
                return false;
            };
            window.doChat = async (prompt, model) => {
                if (typeof puter !== 'undefined' && puter.ai) return await puter.ai.chat(prompt, { model });
                throw new Error('Puter.js not ready');
            };
            window.doImage = async (prompt, model) => {
                if (typeof puter !== 'undefined' && puter.ai) return await puter.ai.txt2img(prompt, { model });
                throw new Error('Puter.js not ready');
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
    constructor(size = 2) {
        this.size = size;
        this.pool = []; // Queue of Session objects
        this.counter = 0;
        this.consecutiveFailures = 0;
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
        if (this.consecutiveFailures > 5) {
            console.error('[Pool] 🚨 CIRCUIT BREAKER TRIGGERED: Too many init failures. Stopping retries.');
            return null;
        }

        this.counter++;
        const s = new BrowserSession(this.counter);
        this.pool.push(s);

        s.init()
            .then(() => {
                this.consecutiveFailures = 0; // Reset on success
            })
            .catch(e => {
                this.consecutiveFailures++;
                console.error(`[Pool] Session #${s.id} failed to init. Fail count: ${this.consecutiveFailures}`);
                this.removeSession(s);

                if (this.consecutiveFailures <= 5) {
                    console.log('[Pool] Retrying in 10s...');
                    setTimeout(() => this.addSession(), 10000);
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

// Global Pool
const sessionPool = new SessionPool(2);

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
