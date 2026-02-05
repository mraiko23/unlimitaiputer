/**
 * Chat Store - Simple JSON file-based chat storage
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CHATS_FILE = path.join(__dirname, 'data', 'chats.json');

// Ensure data directory exists
function ensureDataDir() {
    const dataDir = path.dirname(CHATS_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

// Load chats from file
function loadChats() {
    ensureDataDir();
    if (!fs.existsSync(CHATS_FILE)) {
        return {};
    }
    try {
        const data = fs.readFileSync(CHATS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        console.error('[ChatStore] Error loading chats:', e.message);
        return {};
    }
}

// Save chats to file
function saveChats(chats) {
    ensureDataDir();
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

// Get all chats
function getAllChats() {
    const chats = loadChats();
    return Object.values(chats).map(chat => ({
        id: chat.id,
        title: chat.title,
        model: chat.model,
        createdAt: chat.createdAt,
        messageCount: chat.messages.length
    }));
}

// Get chat by ID
function getChat(id) {
    const chats = loadChats();
    return chats[id] || null;
}

// Create new chat
function createChat(title, model = 'gemini-3-pro-preview') {
    const chats = loadChats();
    const id = uuidv4();
    const chat = {
        id,
        title: title || `Chat ${id.substring(0, 8)}`,
        model,
        createdAt: new Date().toISOString(),
        messages: []
    };
    chats[id] = chat;
    saveChats(chats);
    return chat;
}

// Delete chat
function deleteChat(id) {
    const chats = loadChats();
    if (chats[id]) {
        delete chats[id];
        saveChats(chats);
        return true;
    }
    return false;
}

// Add message to chat
function addMessage(chatId, role, content, imageUrl = null) {
    const chats = loadChats();
    const chat = chats[chatId];
    if (!chat) return null;

    const message = {
        id: uuidv4(),
        role, // 'user' or 'assistant'
        content,
        imageUrl,
        createdAt: new Date().toISOString()
    };

    chat.messages.push(message);
    saveChats(chats);
    return message;
}

// Update chat model
function updateChatModel(chatId, model) {
    const chats = loadChats();
    const chat = chats[chatId];
    if (!chat) return null;
    chat.model = model;
    saveChats(chats);
    return chat;
}

// Format chat messages for AI context
function formatMessagesForAI(chatId) {
    const chat = getChat(chatId);
    if (!chat) return [];

    return chat.messages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));
}

module.exports = {
    getAllChats,
    getChat,
    createChat,
    deleteChat,
    addMessage,
    updateChatModel,
    formatMessagesForAI
};
