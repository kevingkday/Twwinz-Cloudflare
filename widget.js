/**
 * Twwinz Branded AI Twin Chat Widget
 * Embeddable script for creator websites.
 * Dynamically adopts extracted brand colors and typography.
 */

(function () {
  'use strict';

  // Read configuration from the current script tag
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  const creatorSlug = currentScript.getAttribute('data-creator') || 'jaxson-reed';
  const ghlLocationId = currentScript.getAttribute('data-ghl-location') || '';
  const initialPrimary = currentScript.getAttribute('data-primary-color') || '#3b82f6';
  const initialAccent = currentScript.getAttribute('data-accent-color') || '#f59e0b';
  const initialHeadingFont = currentScript.getAttribute('data-heading-font') || 'Space Grotesk';
  const initialBodyFont = currentScript.getAttribute('data-body-font') || 'Inter';
  
  // API Host defaults to script origin or current host
  let apiHost = '';
  try {
    const scriptSrc = new URL(currentScript.src);
    apiHost = scriptSrc.origin;
  } catch (e) {
    apiHost = window.location.origin;
  }

  // Inject Stylesheet with CSS Variables
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .twwinz-widget-bubble {
      --twwinz-primary: ${initialPrimary};
      --twwinz-accent: ${initialAccent};
      --twwinz-bg: #0f172a;
      --twwinz-surface: #111827;
      --twwinz-text: #ffffff;
      --twwinz-heading-font: '${initialHeadingFont}', system-ui, -apple-system, sans-serif;
      --twwinz-body-font: '${initialBodyFont}', system-ui, -apple-system, sans-serif;
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      font-family: var(--twwinz-body-font);
    }
    .twwinz-widget-button {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: var(--twwinz-primary);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 20px var(--twwinz-primary);
      border: 2px solid rgba(255, 255, 255, 0.25);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      outline: none;
    }
    .twwinz-widget-button:hover {
      transform: scale(1.08);
      box-shadow: 0 15px 30px -5px rgba(0, 0, 0, 0.5), 0 0 25px var(--twwinz-primary);
    }
    .twwinz-widget-button svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
      transition: transform 0.2s ease;
    }
    .twwinz-widget-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 380px;
      height: 560px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px);
      background: var(--twwinz-surface);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
      opacity: 0;
      transform: translateY(20px) scale(0.95);
      pointer-events: none;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .twwinz-widget-window.twwinz-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .twwinz-widget-header {
      background: linear-gradient(135deg, var(--twwinz-primary) 0%, #111827 100%);
      padding: 18px 20px;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      font-family: var(--twwinz-heading-font);
    }
    .twwinz-widget-profile {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .twwinz-widget-avatar {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid #ffffff;
    }
    .twwinz-widget-title {
      font-weight: 700;
      font-size: 15px;
      line-height: 1.2;
      font-family: var(--twwinz-heading-font);
    }
    .twwinz-widget-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.85);
      margin-top: 2px;
      font-family: var(--twwinz-body-font);
    }
    .twwinz-widget-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      background: #22c55e;
      border-radius: 50%;
    }
    .twwinz-widget-close {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      font-size: 20px;
      padding: 4px;
      display: flex;
      line-height: 1;
    }
    .twwinz-widget-close:hover {
      color: #ffffff;
    }
    .twwinz-widget-messages {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--twwinz-bg);
      font-family: var(--twwinz-body-font);
    }
    .twwinz-msg {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13.5px;
      line-height: 1.45;
      word-break: break-word;
    }
    .twwinz-msg-twin {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.06);
      color: #f1f5f9;
      border-bottom-left-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .twwinz-msg-fan {
      align-self: flex-end;
      background: var(--twwinz-primary);
      color: #ffffff;
      border-bottom-right-radius: 4px;
    }
    .twwinz-msg-meta {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 4px;
      text-align: right;
    }
    .twwinz-sources-badge {
      font-size: 11px;
      color: var(--twwinz-accent);
      margin-top: 6px;
      display: block;
      font-weight: 600;
    }
    .twwinz-widget-input-box {
      padding: 14px 16px;
      background: var(--twwinz-surface);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .twwinz-widget-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #ffffff;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13.5px;
      outline: none;
      font-family: var(--twwinz-body-font);
      transition: border-color 0.2s;
    }
    .twwinz-widget-input:focus {
      border-color: var(--twwinz-primary);
    }
    .twwinz-widget-send {
      background: var(--twwinz-primary);
      border: none;
      color: #ffffff;
      padding: 10px 16px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.2s;
      font-family: var(--twwinz-body-font);
    }
    .twwinz-widget-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .twwinz-branding-footer {
      text-align: center;
      font-size: 10px;
      color: #64748b;
      padding: 4px 0 8px;
      background: var(--twwinz-surface);
      font-family: var(--twwinz-body-font);
    }
    .twwinz-branding-footer a {
      color: #94a3b8;
      text-decoration: none;
    }
  `;
  document.head.appendChild(styleEl);

  // Helper to dynamically load Google Font
  function loadGoogleFont(fontName) {
    if (!fontName || ['system-ui', 'sans-serif', 'serif', 'inter'].includes(fontName.toLowerCase())) return;
    const fontId = `twwinz-gfont-${fontName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    if (document.getElementById(fontId)) return;
    const link = document.createElement('link');
    link.id = fontId;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName).replace(/%20/g, '+')}:wght@400;600;700&display=swap`;
    document.head.appendChild(link);
  }

  // Pre-load initial fonts if specified
  loadGoogleFont(initialHeadingFont);
  loadGoogleFont(initialBodyFont);

  // Build DOM
  const container = document.createElement('div');
  container.className = 'twwinz-widget-bubble';
  container.innerHTML = `
    <button class="twwinz-widget-button" id="twwinz-toggle-btn" aria-label="Chat with AI Twin">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
    </button>
    <div class="twwinz-widget-window" id="twwinz-chat-window">
      <div class="twwinz-widget-header">
        <div class="twwinz-widget-profile">
          <img class="twwinz-widget-avatar" id="twwinz-avatar" src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80" alt="Avatar" />
          <div>
            <div class="twwinz-widget-title" id="twwinz-name">Official AI Twin</div>
            <div class="twwinz-widget-badge">Direct Fan Line • Powered by RAG</div>
          </div>
        </div>
        <button class="twwinz-widget-close" id="twwinz-close-btn">&times;</button>
      </div>
      <div class="twwinz-widget-messages" id="twwinz-messages"></div>
      <div class="twwinz-widget-input-box">
        <input type="text" class="twwinz-widget-input" id="twwinz-input" placeholder="Ask about tour dates, VIP perks, or gear..." />
        <button class="twwinz-widget-send" id="twwinz-send-btn">Send</button>
      </div>
      <div class="twwinz-branding-footer">
        Verified Digital Twin via <a href="${apiHost}" target="_blank">Twwinz</a>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  // Widget State
  const toggleBtn = document.getElementById('twwinz-toggle-btn');
  const chatWindow = document.getElementById('twwinz-chat-window');
  const closeBtn = document.getElementById('twwinz-close-btn');
  const messagesBox = document.getElementById('twwinz-messages');
  const inputEl = document.getElementById('twwinz-input');
  const sendBtn = document.getElementById('twwinz-send-btn');
  const avatarEl = document.getElementById('twwinz-avatar');
  const nameEl = document.getElementById('twwinz-name');

  let creatorData = null;
  let chatHistory = [];
  let isOpen = false;

  // Dynamically apply theme to the widget container
  function applyTheme(colors, fonts) {
    if (colors) {
      if (colors.primary) container.style.setProperty('--twwinz-primary', colors.primary);
      if (colors.accent) container.style.setProperty('--twwinz-accent', colors.accent);
      if (colors.background) container.style.setProperty('--twwinz-bg', colors.background);
      if (colors.surface) container.style.setProperty('--twwinz-surface', colors.surface);
    }
    if (fonts) {
      if (fonts.heading) {
        container.style.setProperty('--twwinz-heading-font', `'${fonts.heading}', system-ui, sans-serif`);
        loadGoogleFont(fonts.heading);
      }
      if (fonts.body) {
        container.style.setProperty('--twwinz-body-font', `'${fonts.body}', system-ui, sans-serif`);
        loadGoogleFont(fonts.body);
      }
    }
  }

  // Toggle Chat
  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen) {
      chatWindow.classList.add('twwinz-open');
      inputEl.focus();
    } else {
      chatWindow.classList.remove('twwinz-open');
    }
  }

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);

  // Load Creator Details & Synced Brand Aesthetic
  async function initCreator() {
    try {
      const res = await fetch(`${apiHost}/api/creators?slug=${creatorSlug}`);
      if (res.ok) {
        creatorData = await res.json();
        nameEl.textContent = `${creatorData.name}'s AI Twin`;
        if (creatorData.avatar_url) avatarEl.src = creatorData.avatar_url;

        // Apply dynamically synced brand colors & fonts from DB
        const brandColors = typeof creatorData.brand_colors === 'string' 
          ? JSON.parse(creatorData.brand_colors || '{}') 
          : (creatorData.brand_colors || {});
        const brandFonts = typeof creatorData.brand_fonts === 'string'
          ? JSON.parse(creatorData.brand_fonts || '{}')
          : (creatorData.brand_fonts || {});

        applyTheme(brandColors, brandFonts);
        
        // Welcome message
        addMessage('twin', creatorData.welcome_message || `Hey there! I am ${creatorData.name}'s official representative. Ask me anything!`);
      }
    } catch (err) {
      console.warn('[Twwinz] Failed to load creator data:', err);
      addMessage('twin', "Hey! I am the official digital representative. Ask me anything about upcoming tour dates, VIP perks, or behind-the-scenes projects!");
    }
  }

  function addMessage(sender, text, sources = null) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `twwinz-msg twwinz-msg-${sender}`;
    msgDiv.innerHTML = `<div>${escapeHtml(text)}</div>`;
    
    if (sources && sources.length > 0) {
      const sourceTitles = sources.map(s => s.title).join(', ');
      msgDiv.innerHTML += `<span class="twwinz-sources-badge">⚡ Grounded via: ${escapeHtml(sourceTitles)}</span>`;
    }

    messagesBox.appendChild(msgDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;
    chatHistory.push({ sender, message: text });
  }

  async function handleSend() {
    const query = inputEl.value.trim();
    if (!query) return;

    inputEl.value = '';
    sendBtn.disabled = true;
    addMessage('fan', query);

    // Typing indicator
    const typingDiv = document.createElement('div');
    typingDiv.className = 'twwinz-msg twwinz-msg-twin';
    typingDiv.id = 'twwinz-typing';
    typingDiv.textContent = 'Consulting verified memory...';
    messagesBox.appendChild(typingDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    try {
      const res = await fetch(`${apiHost}/api/chat/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorId: creatorData ? creatorData.id : 'clb_jaxson_reed',
          query: query,
          chatHistory: chatHistory
        })
      });

      const data = await res.json();
      const typingEl = document.getElementById('twwinz-typing');
      if (typingEl) typingEl.remove();

      if (data && data.reply) {
        addMessage('twin', data.reply, data.ragSources);
      } else {
        addMessage('twin', "Sorry, I ran into an issue connecting to memory. Please try again in a moment!");
      }
    } catch (e) {
      const typingEl = document.getElementById('twwinz-typing');
      if (typingEl) typingEl.remove();
      addMessage('twin', "Network connection error. Please try again!");
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleSend();
  });

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  initCreator();
})();
