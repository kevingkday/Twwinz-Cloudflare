-- Twwinz D1 Database Schema
-- Provides relational storage for Creator Profiles, GoHighLevel linkages,
-- Dynamic RAG Knowledge Base items, and Chat Session History.

CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    headline TEXT,
    bio_summary TEXT,
    website_type TEXT NOT NULL DEFAULT 'existing', -- 'existing' or 'ghl_hosted'
    website_url TEXT,
    brand_colors TEXT, -- JSON: { "primary": "#...", "accent": "#...", "background": "#...", "surface": "#..." }
    brand_fonts TEXT,  -- JSON: { "heading": "Space Grotesk", "body": "Inter" }
    avatar_url TEXT,
    ghl_location_id TEXT,
    ghl_api_key TEXT,
    ghl_widget_id TEXT,
    persona_prompt TEXT,
    welcome_message TEXT DEFAULT 'Hey there! I am the official digital representative. Ask me anything about upcoming tour dates, exclusive merch, or behind-the-scenes projects!',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    category TEXT NOT NULL, -- 'schedule', 'offer', 'faq', 'bio', 'guideline'
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT, -- JSON: { "date": "...", "location": "...", "link": "...", "promo_code": "...", "price": "..." }
    embedding TEXT, -- JSON array of floats for cosine similarity calculation
    priority INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_creator_cat ON knowledge_items(creator_id, category);
CREATE INDEX IF NOT EXISTS idx_knowledge_active ON knowledge_items(is_active);

-- Full-Text Search (FTS5) for Instant Keyword & Hybrid Grounding in D1
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    id UNINDEXED,
    creator_id UNINDEXED,
    title,
    content,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    ghl_contact_id TEXT,
    ghl_conversation_id TEXT,
    fan_name TEXT,
    fan_email TEXT,
    fan_phone TEXT,
    channel TEXT DEFAULT 'ghl_chat_widget',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_creator ON chat_sessions(creator_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_ghl ON chat_sessions(ghl_conversation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    sender TEXT NOT NULL, -- 'fan' or 'twin'
    message TEXT NOT NULL,
    rag_sources TEXT, -- JSON array of knowledge_item IDs used in grounding
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
