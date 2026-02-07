// Features:
// - Memory-Efficient Single-Browser System (Optimized for 512MB RAM)
// - Strict Memory Management (Kill & Replace strategy)
// - Cloudflare Bypass (puppeteer-real-browser)
// - Full AI Suite: Chat, Search, Image (Txt2Img/Img2Img), TTS, STT
// - Session Locking & Reference Counting to prevent protocol errors

const express = require('express');
const cors = require('cors');
const puppeteerCore = require('puppeteer');
const path = require('path');
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');

// Simple In-Memory Chat Store (Inlined)
const chatStore = {
    chats: [],
    getAllChats: function () { return this.chats; },
    createChat: function (title, model) {
        const chat = {
            id: Date.now().toString(),
            title: title || 'New Chat',
            model: model || 'gemini-2.0-flash',
            createdAt: new Date().toISOString()
        };
        this.chats.push(chat);
        return chat;
    }
};

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased for image/audio uploads
app.use(express.static(path.join(__dirname, 'public')));

// PREVENT CRASHES: Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    // Keep running
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection:', reason);
    // Keep running
});

// Keep-alive ping
const PING_INTERVAL = 90 * 1000;
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
// Browser Session Class
// =====================

class BrowserSession {
    constructor(id, type = 'standby') {
        this.id = id;
        this.type = type; // 'primary' or 'standby'
        this.browser = null;
        this.page = null;
        this.isReady = false;
        this.status = 'initializing';
        this.createdAt = Date.now();
        this.token = null;
        this.activeRequests = 0; // Reference counting
    }

    async init(existingToken = null) {
        console.log(`[Session #${this.id}] Launching (${this.type})...`);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

                if (!executablePath) {
                    try {
                        executablePath = puppeteerCore.executablePath();
                        if (executablePath && !path.isAbsolute(executablePath)) {
                            executablePath = path.resolve(process.cwd(), executablePath);
                        }
                    } catch (e) { }
                }


                const launchArgs = [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-position=-10000,-10000'
                ];

                const response = await connect({
                    headless: 'auto',
                    turnstile: true,
                    customConfig: { chromePath: executablePath },
                    connectOption: {
                        defaultViewport: null,
                        timeout: 60000
                    },
                    args: launchArgs,
                    fingerprint: true,
                    turnstileOptimization: true
                });

                this.browser = response.browser;
                this.page = response.page;

                console.log(`[Session #${this.id}] Browser launched!`);

                await this.page.goto('https://puter.com', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });

                // If we have a token from the other browser, inject it immediately!
                if (existingToken) {
                    console.log(`[Session #${this.id}] Injecting inherited token...`);
                    await this.injectToken(existingToken);
                }

                await this.waitForLogin();

                // OPTIMIZATION: Block heavy resources AFTER login to save RAM
                await this.optimizePage();

                // If successful, break retry loop
                return;

            } catch (e) {
                console.error(`[Session #${this.id}] Init Attempt ${attempt}/${maxRetries} Failed: ${e.message}`);

                // Cleanup partial
                if (this.browser) await this.browser.close().catch(() => { });
                this.browser = null;
                this.page = null;

                if (attempt === maxRetries) {
                    this.status = 'dead';
                    throw e; // Give up
                }

                // Wait before retry (exponential backoff)
                await new Promise(r => setTimeout(r, attempt * 5000));
            }
        }
    }


    async optimizePage() {
        if (!this.page) return;
        try {
            console.log(`[Session #${this.id}] Enabling resource blocker (Save RAM Mode)...`);
            // NOTE: setRequestInterception can conflict with some puppeteer-real-browser patches or cloudflare
            // We will rely on launch args for now to be safe.
            /*
            await this.page.setRequestInterception(true);
            this.page.on('request', (req) => {
                const type = req.resourceType();
                if (['image', 'media', 'font', 'stylesheet', 'other'].includes(type)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
            */
            // Alternative: Use CDP to block URLs safely
            const client = await this.page.target().createCDPSession();
            await client.send('Network.setBlockedURLs', {
                urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.woff', '*.woff2', '*.ttf']
            });
        } catch (e) {
            console.warn(`[Session #${this.id}] Optimization warning: ${e.message}`);
        }
    }

    async waitForLogin() {
        console.log(`[Session #${this.id}] Waiting for Login...`);
        let loggedIn = false;

        for (let i = 0; i < 60; i++) { // 120 seconds max
            await new Promise(r => setTimeout(r, 2000));

            // Auto-click "Get Started"
            try {
                await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const startBtn = buttons.find(b => b.innerText.match(/Get Started|Start|Guest|Try/i));
                    if (startBtn) startBtn.click();
                });
            } catch (e) { }

            await this.injectHelpers();

            // Check Status
            const state = await this.getPageStatus();
            if (state.api && state.token) {
                this.token = state.token;
                loggedIn = true;
                break;
            }
        }

        if (loggedIn) {
            console.log(`[Session #${this.id}] READY! ✅ Token captured: ${this.token}`);
            this.isReady = true;
            this.status = 'ready';
        } else {
            console.warn(`[Session #${this.id}] Login Timeout.`);
            throw new Error('Login Timeout');
        }
    }

    async getPageStatus() {
        if (!this.page) return { api: false, token: null };
        try {
            return await this.page.evaluate(() => {
                let token = null;
                if (typeof puter !== 'undefined' && puter.authToken) token = puter.authToken;
                if (!token) token = localStorage.getItem('puter.auth.token');

                return {
                    api: typeof puter !== 'undefined' && !!puter.ai,
                    token: token
                };
            });
        } catch (e) { return { api: false, token: null }; }
    }

    async injectHelpers() {
        if (!this.page) return;
        await this.page.evaluate(() => {
            window.puterReady = true;

            // Chat Wrapper
            window.doChat = async (prompt, model) => {
                try {
                    if (!puter?.ai) return { error: 'Puter AI not ready' };
                    return await puter.ai.chat(prompt, { model });
                } catch (e) {
                    // Create a serializable error report
                    const report = {
                        message: e.message || String(e),
                        name: e.name,
                        stack: e.stack,
                        string: e.toString()
                    };
                    // Collect all other properties
                    try {
                        Object.getOwnPropertyNames(e).forEach(key => {
                            if (!report[key]) report[key] = e[key];
                        });
                    } catch (e2) { }
                    return { error: report };
                }
            };

            // Image Wrapper (Txt2Img & Img2Img)
            window.doImage = async (prompt, model, inputImage) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');
                    const options = { model, prompt }; // Add prompt to options for redundancy

                    if (inputImage) {
                        options.input_image = inputImage;
                    }

                    const result = await puter.ai.txt2img(prompt, options);

                    // Robust extraction for various result formats (DOM, Blob, String, JSON)
                    if (result && (result instanceof HTMLImageElement || result.tagName === 'IMG')) {
                        return result.src;
                    }
                    if (typeof result === 'string') return result; // URL or Base64
                    if (result instanceof Blob) {
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }
                    // Handle Gemini/GPT JSON responses
                    if (result && typeof result === 'object') {
                        // Priority order for extraction
                        const possibleValues = [
                            result.url,
                            result.src,
                            result.data,
                            result.result,
                            result.image_url,
                            result.image,
                            (result.choices && result.choices[0] && result.choices[0].image_url),
                            (result.choices && result.choices[0] && result.choices[0].url),
                            result.message,
                            (result.message && result.message.content)
                        ];
                        const found = possibleValues.find(v => typeof v === 'string' && v.startsWith('http'));
                        if (found) return found;

                        // Deep search for anything that looks like a URL
                        const findUrl = (obj) => {
                            for (const k in obj) {
                                if (typeof obj[k] === 'string' && obj[k].startsWith('http')) return obj[k];
                                if (typeof obj[k] === 'object' && obj[k] !== null) {
                                    const res = findUrl(obj[k]);
                                    if (res) return res;
                                }
                            }
                            return null;
                        };
                        const deepFound = findUrl(result);
                        if (deepFound) return deepFound;

                        console.error('[Puter] Image Extraction Failed. Raw Response:', JSON.stringify(result));
                        throw new Error(`Failed to extract image URL from object. Response: ${JSON.stringify(result).substring(0, 500)}`);
                    }
                    return result;
                } catch (e) {
                    console.error('[Puter] doImage Error:', e);
                    throw new Error(e.message || String(e));
                }
            };

            // Search Wrapper (Perplexity)
            window.doSearch = async (prompt) => {
                if (!puter?.ai) throw new Error('Puter AI not ready');
                // Using Sonar Reasoning Pro for advanced search
                return await puter.ai.chat(prompt, { model: 'sonar-reasoning-pro' });
            };

            // Text-to-Speech Wrapper with Fallbacks
            window.doTTS = async (text, voice, model) => {
                const tryTTS = async (v, m, p) => {
                    console.log(`[Puter] TTS Attempt: Voice=${v || 'default'}, Model=${m || 'default'}, Provider=${p || 'default'}`);
                    const options = {};
                    if (p) options.provider = p;
                    if (v) options.voice = v;
                    if (m) options.model = m;

                    const result = await puter.ai.txt2speech(text, options);

                    if (result && (result instanceof HTMLAudioElement || result.tagName === 'AUDIO')) return result.src;
                    if (result instanceof Blob) {
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }
                    return result;
                };

                try {
                    // 1. Try ElevenLabs with requested params
                    return await tryTTS(voice, model || 'eleven_multilingual_v2', 'elevenlabs');
                } catch (e1) {
                    console.warn(`[Puter] TTS Attempt 1 Failed: ${e1.message}`);
                    try {
                        // 2. Try ElevenLabs Flash (More stable sometimes)
                        return await tryTTS(voice, 'eleven_flash_v2_5', 'elevenlabs');
                    } catch (e2) {
                        console.warn(`[Puter] TTS Attempt 2 Failed: ${e2.message}`);
                        try {
                            // 3. Try ElevenLabs Default Rachel
                            return await tryTTS('21m00Tcm4TlvDq8ikWAM', 'eleven_multilingual_v2', 'elevenlabs');
                        } catch (e3) {
                            console.error(`[Puter] All ElevenLabs attempts failed. Final fallback to Puter default...`);
                            // 4. Final Fallback to Puter Default
                            return await tryTTS(null, null, null);
                        }
                    }
                }
            };

            // Speech-to-Text Wrapper (Filesystem Approach)
            window.doSTT = async (audioDataVal) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');

                    // Convert Data URI to Blob
                    const response = await fetch(audioDataVal);
                    const originalBlob = await response.blob();

                    // Reconstruct blob with MP3 mime type (spoofing for the backend)
                    const blob = new Blob([originalBlob], { type: 'audio/mpeg' });

                    // Generate temp filename with .mp3 extension
                    const filename = `~/temp_voice_${Date.now()}.mp3`;

                    // Write to Puter FS
                    await puter.fs.write(filename, blob);

                    try {
                        // Transcribe using whisper-1 (best for varied audio formats)
                        const transcription = await puter.ai.speech2txt(filename, { model: 'whisper-1' });

                        // Delete temp file
                        await puter.fs.delete(filename).catch(() => { });

                        return transcription;
                    } catch (transE) {
                        // Cleanup on error
                        await puter.fs.delete(filename).catch(() => { });
                        throw transE;
                    }
                } catch (e) {
                    throw new Error(e.message || JSON.stringify(e));
                }
            };

            // Voice Conversion Wrapper (Speech-to-Speech)
            window.doS2S = async (audioDataVal, voice) => {
                const tryS2S = async (v, m) => {
                    console.log(`[Puter] S2S Attempt: Voice=${v}, Model=${m}`);
                    const result = await puter.ai.speech2speech(audioDataVal, {
                        provider: 'elevenlabs',
                        voice: v || '21m00Tcm4TlvDq8ikWAM',
                        model: m || 'eleven_multilingual_sts_v2'
                    });
                    if (result instanceof Blob) {
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }
                    return result;
                };

                try {
                    return await tryS2S(voice, 'eleven_multilingual_sts_v2');
                } catch (e) {
                    console.warn(`[Puter] S2S Failed, trying Rachel fallback...`);
                    return await tryS2S('21m00Tcm4TlvDq8ikWAM', 'eleven_multilingual_sts_v2');
                }
            };
            // Video Wrapper (Txt2Vid)
            window.doVideo = async (prompt, model) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');
                    const options = {
                        model: model || 'sora-2', // Reverted to Sora-2 per user request
                        prompt
                    };
                    const result = await puter.ai.txt2vid(prompt, options);

                    if (result && (result instanceof HTMLVideoElement || result.tagName === 'VIDEO')) {
                        return result.src;
                    }
                    if (typeof result === 'string') return result;
                    return result;
                } catch (e) {
                    throw new Error(e.message || JSON.stringify(e));
                }
            };
        });
    }

    async close() {
        this.status = 'dead';
        this.isReady = false;
        if (this.browser) {
            console.log(`[Session #${this.id}] Killing browser...`);
            await this.browser.close().catch(() => { });
        }
    }

    async injectToken(token) {
        if (!this.page || !token) return;
        try {
            this.token = token; // Synchronize local state
            await this.page.evaluate((t) => {
                localStorage.setItem('puter.auth.token', t);
                localStorage.setItem('token', t);
            }, token);
            await this.page.reload({ waitUntil: 'domcontentloaded' });
        } catch (e) { }
    }
}

// =====================
// Session Pool (Manager)
// ... (rest of SessionPool)

// 6. Video (New)
app.post('/api/video/generate', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        console.log(`[Video] Generating: "${prompt}"`);

        // Timeout is tricky here as video takes long. 
        // We might need to rely on the client setting a long timeout.
        const result = await safeExecute('Video', async (session) => {
            return await session.page.evaluate(async (p, m) => window.doVideo(p, m),
                prompt,
                model || 'sora-2' // Reverted to Sora-2
            );
        });

        res.json({ url: result });

    } catch (e) {
        console.error('[Video] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================
// Session Pool (Manager)
// =====================

class SessionPool {
    constructor() {
        this.primary = null;
        this.sessionCounter = 0;
        this.tokenCache = null;
        // init() is called explicitly during app.listen
    }

    async init() {
        console.log('[Pool] Initializing Single-Browser System...');
        this.primary = await this.createSession('primary');
    }

    async createSession(type) {
        this.sessionCounter++;
        const s = new BrowserSession(this.sessionCounter, type);

        // Init with cached token if available
        s.init(this.tokenCache).then(() => {
            if (s.token) {
                console.log(`[Pool] Captured token from Session #${s.id}`);
                this.updateToken(s.token);
            }
        }).catch(() => {
            console.error(`[Pool] Session #${s.id} failed to launch. Retrying...`);
            // Simple retry logic could be added here
        });

        return s;
    }

    updateToken(token) {
        if (!token || token === this.tokenCache) return;
        this.tokenCache = token;

        // Sync to primary if alive
        if (this.primary && this.primary.isReady && this.primary.token !== token) {
            this.primary.injectToken(token);
        }
    }

    async getSession() {
        if (this.primary && this.primary.isReady) return this.primary;
        throw new Error('Active session unavailable. System is initializing.');
    }

    async forceRotate() {
        console.warn('[Pool] ⚠️ FORCE ROTATION TRIGGERED (Limit/Error) ⚠️');
        console.error('[Pool] Restarting Primary Browser...');
        if (this.primary) await this.primary.close();
        this.primary = await this.createSession('primary');

        // Wait for it to be ready or timeout
        let count = 0;
        while (!this.primary.isReady && count < 30) {
            await new Promise(r => setTimeout(r, 2000));
            count++;
        }

        return this.primary;
    }
}

const pool = new SessionPool();

// =====================
// Helper: Execute with Failover
// =====================

async function safeExecute(actionName, fn) {
    let session = null;
    try {
        session = await pool.getSession();

        // LOCK SESSION
        session.activeRequests++;

        // Ensure injection before run
        await session.injectHelpers();
        const result = await fn(session);

        // UNLOCK SESSION
        session.activeRequests--;
        if (session.status === 'retiring' && session.activeRequests <= 0) {
            session.close();
        }

        // AGGRESSIVE GC: Clear Node RAM
        if (global.gc) {
            global.gc();
        }

        return result;

    } catch (e) {
        // UNLOCK ON ERROR
        if (session) {
            session.activeRequests--;
            if (session.status === 'retiring' && session.activeRequests <= 0) {
                session.close();
            }
        }

        const errStr = e.toString().toLowerCase();
        // If limit reached or generic browser error
        if (errStr.includes('limit') || errStr.includes('quota') || errStr.includes('429') || errStr.includes('navigat') || errStr.includes('protocol')) {
            console.warn(`[${actionName}] Failure in Session #${session?.id}: ${e.message}`);

            // Rotate
            const newSession = await pool.forceRotate();
            console.log(`[${actionName}] Retrying with Session #${newSession.id}...`);

            // EXECUTE ON NEW SESSION (Be careful not to infinitely recurse without limits, but safeExecute calls normally bubble up)
            // Manual retry logic here to properly lock the NEW session
            newSession.activeRequests++;
            try {
                await newSession.injectHelpers();
                const res = await fn(newSession);
                newSession.activeRequests--;
                return res;
            } catch (retryE) {
                newSession.activeRequests--;
                throw retryE;
            }
        }
        throw e;
    }
}

// =====================
// API Endpoints
// =====================

// 1. Chat
app.post('/api/chat', async (req, res) => {
    try {
        const { prompt, model, messages, system } = req.body;
        let input = messages || prompt;
        if (!input && !messages) return res.status(400).json({ error: 'No input provided' });

        // Logging for debug
        if (Array.isArray(input)) {
            console.log(`[Chat] Payload: Array (${input.length} messages) Model: ${model || 'default'}`);
        } else {
            console.log(`[Chat] Payload: String (${input.length} chars) Model: ${model || 'default'}`);
        }

        const result = await safeExecute('Chat', async (session) => {
            return await session.page.evaluate(async (p, m) => window.doChat(p, m), input, model || 'gemini-2.0-flash');
        });

        if (result && result.error) {
            const errDetails = typeof result.error === 'object' ? JSON.stringify(result.error, null, 2) : String(result.error);
            throw new Error(errDetails);
        }

        // Normalize output (Robust Parsing)
        let text = '';
        // Normalize output (Robust Parsing)
        const normalizeResponse = (res) => {
            if (!res) return '';
            if (typeof res === 'string') return res;

            // Helper to extract text from content (string or array)
            const extractContent = (content) => {
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    // Try to finding 'text' in any item, or join everything
                    return content.map(c => {
                        if (typeof c === 'string') return c;
                        return c.text || c.content || JSON.stringify(c);
                    }).join('');
                }
                return JSON.stringify(content);
            };

            // Standard message structures
            if (res.message) {
                if (res.message.content) return extractContent(res.message.content);
                if (res.message.text) return res.message.text;
                if (typeof res.message === 'string') return res.message;
            }

            // OpenAI / Choices structure
            if (res.choices && res.choices[0]) {
                const choice = res.choices[0];
                if (choice.message) return extractContent(choice.message.content);
                if (choice.text) return choice.text;
            }

            // Anthropic direct / Claude specific
            if (res.content) return extractContent(res.content);
            if (res.text) return res.text;

            // Final fallback
            return typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res);
        };

        text = normalizeResponse(result);
        res.json({ text, full: result });

    } catch (e) {
        console.error(`[Chat] Critical Error:`, e);
        let errMsg = e.message || String(e);
        if (errMsg === '[object Object]') {
            try { errMsg = JSON.stringify(e, null, 2); } catch (e3) { errMsg = e.toString(); }
        }
        res.status(500).json({ error: errMsg });
    }
});

// 2. Image (Enhanced)
app.post('/api/image/generate', async (req, res) => {
    try {
        const { prompt, model, input_image } = req.body;
        // model default: 'gemini-2.5-flash-image-preview' (Nano Banana) or 'black-forest-labs/FLUX.1.1-pro'

        console.log(`[Image] Generating: "${prompt}" (Img2Img: ${!!input_image})`);

        const result = await safeExecute('Image', async (session) => {
            return await session.page.evaluate(async (p, m, i) => window.doImage(p, m, i),
                prompt,
                model || 'gemini-2.5-flash-image-preview',
                input_image // Optional Base64
            );
        });

        res.json(result);

    } catch (e) {
        console.error('[Image] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// 3. Search (Perplexity)
app.post('/api/tool/search', async (req, res) => {
    try {
        const { prompt } = req.body;
        const result = await safeExecute('Search', async (session) => {
            return await session.page.evaluate(async (p) => window.doSearch(p), prompt);
        });
        res.json({ result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Text-to-Speech (TTS)
app.post('/api/tool/tts', async (req, res) => {
    try {
        const { text, voice } = req.body;
        console.log(`[TTS] Generating voice for: "${text?.substring(0, 30)}..." (Voice: ${voice || 'default'})`);
        const audioData = await safeExecute('TTS', async (session) => {
            return await session.page.evaluate(async (t, v) => window.doTTS(t, v), text, voice);
        });
        res.json({ audio: audioData });
    } catch (e) {
        console.error('[TTS] Error:', e);
        res.status(500).json({ error: e.message || 'Unknown TTS error' });
    }
});

// 5. Speech-to-Text (STT)
app.post('/api/tool/stt', async (req, res) => {
    try {
        const { audio } = req.body; // Expecting Base64 string or URL
        if (!audio) return res.status(400).json({ error: 'Audio data/url required' });

        const result = await safeExecute('STT', async (session) => {
            return await session.page.evaluate(async (a) => window.doSTT(a), audio);
        });
        res.json({ text: result.text || result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Speech-to-Speech (S2S)
app.post('/api/tool/s2s', async (req, res) => {
    try {
        const { audio, voice } = req.body;
        console.log(`[S2S] Converting voice (Voice: ${voice || 'default'})`);
        const result = await safeExecute('S2S', async (session) => {
            return await session.page.evaluate(async (a, v) => window.doS2S(a, v), audio, voice);
        });
        res.json({ audio: result });
    } catch (e) {
        console.error('[S2S] Error:', e);
        res.status(500).json({ error: e.message || 'Unknown S2S error' });
    }
});

// Health & Debug
app.get('/api/health', (req, res) => {
    res.json({
        primary: pool.primary?.isReady,
        id: pool.primary?.id,
        active: pool.primary?.activeRequests
    });
});

app.get('/debug', async (req, res) => {
    let html = '<html><body style="background:#222;color:#0f0;font-family:monospace;"><h1>Browser Status</h1>';

    const getSessInfo = async (s, name) => {
        if (!s) return `<h2>${name}: NULL</h2>`;
        let shot = '';
        try {
            if (s.page) shot = await s.page.screenshot({ encoding: 'base64', type: 'webp', quality: 20 });
        } catch (e) { }

        return `
            <div style="border:1px solid #555; padding:10px; margin:10px;">
                <h2>${name} (ID: ${s.id})</h2>
                <p>Status: ${s.status} | Ready: ${s.isReady} | Active Req: ${s.activeRequests}</p>
                <p>Created: ${new Date(s.createdAt).toISOString()}</p>
                ${shot ? `<img src="data:image/webp;base64,${shot}" style="max-width:400px;border:1px solid #fff;">` : '<p>No Screenshot</p>'}
            </div>
        `;
    };

    html += await getSessInfo(pool.primary, 'PRIMARY');
    html += '</body></html>';
    res.send(html);
});

// =====================
// Missing Endpoints & Listen Logic
// =====================

app.post('/api/auth/token', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    try {
        // Update pool cache which syncs to all sessions
        pool.updateToken(token);
        res.json({ success: true });
    } catch (e) {
        console.error('[Auth] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/chats', (req, res) => res.json(chatStore.getAllChats()));
app.post('/api/chats', (req, res) => {
    res.status(201).json(chatStore.createChat(req.body.title, req.body.model));
});


// Start (Only if running directly)
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server v2 running on ${PORT}`);
        pool.init();
        startKeepAlive();
    });
}

// Exports for server.js compatibility
module.exports = {
    // If server.js wants to mount us:
    app,
    start: () => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server v2 running on ${PORT}`);
            pool.init();
            startKeepAlive();
        });
    },
    // Keep old controller interface just in case
    init: () => { pool.init(); },
    getStatus: () => ({ isReady: pool.primary?.isReady, isLoggedIn: !!pool.primary?.token }),
    injectToken: async (t) => pool.updateToken(t),
    chat: async (input, model) => { /* routed via app */ }
};
