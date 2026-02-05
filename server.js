/**
 * Puter AI API Server
 * Client-side authentication with full API endpoints
 * Works on Render and locally
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const chatStore = require('./chat-store');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API Key check (optional)
function checkApiKey(req, res, next) {
    if (!API_KEY) return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
}

// =====================
// Health & Info
// =====================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        models: {
            text: ['claude-opus-4-5', 'gemini-3-pro-preview', 'deepseek-v3.2-speciale'],
            image: ['black-forest-labs/FLUX.1-pro', 'dall-e-3', 'gpt-image-1']
        }
    });
});

app.get('/api/info', (req, res) => {
    res.json({
        name: 'Puter AI API',
        version: '2.0.0',
        description: 'Free AI API powered by Puter.js',
        authMethod: 'Browser-based OAuth via Puter',
        howToUse: 'Open the main page in browser, sign in with Puter, then use the API',
        endpoints: {
            '/': 'Web UI with login and API testing',
            '/api/health': 'Health check',
            '/api/info': 'API information',
            '/api/chats': 'Chat management (CRUD)',
            '/api/chats/:id': 'Get/Delete specific chat',
            '/api/chats/:id/messages': 'Add message to chat'
        }
    });
});

// =====================
// Chat Management (works without Puter auth - stored locally)
// =====================

app.get('/api/chats', checkApiKey, (req, res) => {
    try {
        res.json(chatStore.getAllChats());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chats', checkApiKey, (req, res) => {
    try {
        const { title, model } = req.body;
        const chat = chatStore.createChat(title, model);
        res.status(201).json(chat);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/chats/:id', checkApiKey, (req, res) => {
    try {
        const chat = chatStore.getChat(req.params.id);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        res.json(chat);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/chats/:id', checkApiKey, (req, res) => {
    try {
        const deleted = chatStore.deleteChat(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Chat not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chats/:id/messages', checkApiKey, (req, res) => {
    try {
        const { role, content } = req.body;
        const chat = chatStore.getChat(req.params.id);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const message = chatStore.addMessage(req.params.id, role || 'user', content);
        res.status(201).json(message);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🚀 Puter AI API Server v2.0');
    console.log('='.repeat(50));
    console.log(`Server: http://localhost:${PORT}`);
    console.log('');
    console.log('Features:');
    console.log('  ✅ Browser-based Puter authentication');
    console.log('  ✅ Session persistence (localStorage)');
    console.log('  ✅ Text chat (Gemini, Claude, DeepSeek)');
    console.log('  ✅ Image generation (FLUX, DALL-E)');
    console.log('  ✅ Image understanding (Vision)');
    console.log('  ✅ Chat history management');
    console.log('');
    console.log('Open the URL in your browser to get started!');
    console.log('='.repeat(50));
});
