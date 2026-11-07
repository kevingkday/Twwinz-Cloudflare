import { scrapeWebsiteStyles } from './services/styleScraper.js';
import { GHLService } from './services/ghlService.js';
import { RAGEngine } from './services/ragEngine.js';
import {
  getMediaBucket,
  isDataUriImage,
  uploadImageToR2,
  extractR2Key,
  signMediaUrl,
  verifyMediaSignature,
  signKnowledgeItemsMedia,
  migrateDataUriImages
} from './services/mediaService.js';
import {
  encryptSecret,
  decryptSecret,
  isGhlOAuthConfigured,
  getGhlOAuthRedirectUri,
  createGhlOAuthState,
  consumeGhlOAuthState,
  buildGhlAuthorizationUrl,
  exchangeGhlCodeForTokens,
  saveGhlOAuthConnection,
  saveProvisionedSubAccountUser,
  resolveCreatorGhlCredentials,
  getGhlConnectionStatus,
  disconnectGhlOAuth
} from './services/ghlOAuthService.js';

export { migrateDataUriImages };

const DEMO_CREATOR_ID = 'clb_jaxson_reed';
const DEMO_CREATOR_SLUG = 'jaxson-reed';
const ALLOWED_REDIRECT_PATHS = new Set(['/', '/index.html', '/onboard.html', '/dashboard.html', '/settings.html']);
const PUBLIC_CREATOR_FIELDS = [
  'id', 'name', 'slug', 'headline', 'avatar_url', 'brand_colors', 'brand_fonts',
  'welcome_message', 'website_type', 'is_active'
];
const PUBLIC_STATIC_PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/onboard.html', priority: '0.9' },
  { path: '/dynamic-grounding.html', priority: '0.8' },
  { path: '/shopify-integration.html', priority: '0.8' },
  { path: '/unified-brain.html', priority: '0.8' },
  { path: '/sovereignty.html', priority: '0.8' },
  { path: '/fixed-retainers.html', priority: '0.8' },
  { path: '/usage-fees.html', priority: '0.8' },
  { path: '/performance-share.html', priority: '0.8' },
  { path: '/voice-cloning.html', priority: '0.8' },
  { path: '/investor-relations.html', priority: '0.5' },
  { path: '/privacy-policy.html', priority: '0.5' },
  { path: '/terms-of-service.html', priority: '0.5' }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Enable CORS for API routes
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    // Dynamic XML Sitemap (includes static public pages + active hosted twin pages)
    if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
      return handleSitemap(url, env);
    }

    // Route API requests
    if (url.pathname.startsWith('/api/')) {
      try {
        const response = await handleApiRoute(url, request, env);
        return addCorsHeaders(response);
      } catch (err) {
        console.error('[API Route Error]', err);
        return addCorsHeaders(new Response(JSON.stringify({ 
          error: err.message || 'Internal Server Error' 
        }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        }));
      }
    }

    // Public Hosted Twin Page: GET /<slug> (for creators without their own website)
    if (request.method === 'GET' && isCandidateCreatorSlugPath(url.pathname) && env?.DB) {
      const slug = decodeURIComponent(url.pathname.slice(1));
      const creator = await loadCreator(env.DB, slug);
      if (creator && creator.is_active) {
        return renderHostedTwinPage(toPublicCreator(creator), url);
      }
    }

    // Fallback to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Twwinz Platform Ready', { status: 200 });
  }
};

function isCandidateCreatorSlugPath(pathname) {
  if (!pathname || pathname === '/' || pathname.startsWith('/api/')) return false;
  if (pathname.includes('.')) return false;
  return /^\/[a-z0-9][a-z0-9-_]{1,80}$/i.test(pathname);
}

async function handleSitemap(url, env) {
  const baseOrigin = 'https://twwinz.com';
  const slugs = new Set([DEMO_CREATOR_SLUG]);

  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT slug FROM creators WHERE is_active = 1'
      ).all();
      for (const row of results || []) {
        if (row && row.slug) slugs.add(String(row.slug));
      }
    } catch (_) {}
  }

  const urlsXml = [
    ...PUBLIC_STATIC_PAGES.map(
      (p) => `   <url>\n      <loc>${baseOrigin}${p.path}</loc>\n      <priority>${p.priority}</priority>\n   </url>`
    ),
    ...Array.from(slugs).map(
      (slug) => `   <url>\n      <loc>${baseOrigin}/${escapeXml(slug)}</loc>\n      <priority>0.9</priority>\n   </url>`
    )
  ].join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlsXml}\n</urlset>`;
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600'
    }
  });
}

function renderHostedTwinPage(publicCreator, url) {
  const colors = parseJsonObject(publicCreator.brand_colors, {
    primary: '#3b82f6',
    accent: '#f59e0b',
    background: '#0f172a',
    surface: '#1e293b'
  });
  const fonts = parseJsonObject(publicCreator.brand_fonts, {
    heading: 'Space Grotesk',
    body: 'Inter'
  });

  const primaryColor = sanitizeColor(colors.primary, '#3b82f6');
  const accentColor = sanitizeColor(colors.accent, '#f59e0b');
  const headingFont = escapeHtml(fonts.heading || 'Space Grotesk');
  const bodyFont = escapeHtml(fonts.body || 'Inter');

  const safeName = escapeHtml(publicCreator.name || 'Creator');
  const safeSlug = escapeHtml(publicCreator.slug || '');
  const safeHeadline = escapeHtml(publicCreator.headline || `Official AI Twin for ${publicCreator.name || 'Creator'}`);
  const safeWelcome = escapeHtml(
    publicCreator.welcome_message ||
    `Hey! I'm ${publicCreator.name}'s official AI Twin. Ask me about upcoming appearances, signed merch, booking inquiries, or FAQs!`
  );
  const safeAvatar = escapeHtml(
    publicCreator.avatar_url ||
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80'
  );
  const canonicalUrl = `${url.origin}/${encodeURIComponent(publicCreator.slug)}`;

  const html = `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName} — Official AI Twin | Twwinz</title>
  <meta name="description" content="${safeHeadline}. Chat directly with ${safeName}'s consent-approved AI Twin for appearances, signed merch, booking requests, and fan FAQs." />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <!-- Open Graph / Twitter -->
  <meta property="og:type" content="profile" />
  <meta property="og:title" content="${safeName} — Official AI Twin | Twwinz" />
  <meta property="og:description" content="${safeHeadline}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="${safeAvatar}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeName} — Official AI Twin | Twwinz" />
  <meta name="twitter:description" content="${safeHeadline}" />
  <meta name="twitter:image" content="${safeAvatar}" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --twin-primary: ${primaryColor};
      --twin-accent: ${accentColor};
    }
    body {
      background-color: #0e0e11;
      color: #f1f5f9;
      font-family: '${bodyFont}', 'Inter', system-ui, sans-serif;
    }
    .font-headline {
      font-family: '${headingFont}', 'Space Grotesk', system-ui, sans-serif;
    }
    .glass-card {
      background: rgba(24, 24, 29, 0.82);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between relative overflow-x-hidden">
  <div class="fixed inset-0 pointer-events-none opacity-25 z-0">
    <div class="absolute -top-24 left-1/4 w-96 h-96 rounded-full blur-[130px]" style="background:${primaryColor}"></div>
    <div class="absolute bottom-0 right-1/4 w-80 h-80 rounded-full blur-[130px]" style="background:${accentColor}"></div>
  </div>

  <header class="relative z-10 border-b border-white/10 bg-black/40 backdrop-blur-md">
    <div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
      <a href="/" class="text-lg font-bold tracking-tight text-blue-400 font-headline">Twwinz.com</a>
      <span class="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        Consent-Verified Twin Page
      </span>
    </div>
  </header>

  <main class="relative z-10 flex-1 max-w-5xl w-full mx-auto px-6 py-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
    <!-- Left Public Creator Card -->
    <section class="lg:col-span-5 glass-card rounded-3xl p-7 shadow-2xl space-y-6">
      <div class="flex items-center gap-4">
        <img src="${safeAvatar}" alt="${safeName}" class="w-20 h-20 rounded-2xl object-cover border-2 shadow-lg" style="border-color:${primaryColor}" />
        <div>
          <span class="text-[11px] uppercase tracking-widest font-semibold px-2.5 py-0.5 rounded-full bg-white/10 text-slate-200">Official Digital Twin</span>
          <h1 class="text-2xl sm:text-3xl font-bold text-white font-headline mt-1">${safeName}</h1>
          <p class="text-xs sm:text-sm text-slate-300 mt-0.5">${safeHeadline}</p>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white/5 border border-white/10 text-xs sm:text-sm text-slate-200 leading-relaxed">
        "${safeWelcome}"
      </div>

      <div class="space-y-2">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Try asking ${safeName}'s Twin:</div>
        <div class="flex flex-wrap gap-2">
          <button type="button" onclick="askHostedQuestion('Where are your next convention appearances or local events?')" class="text-left text-xs px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 transition">
            📍 Upcoming appearances &amp; booths
          </button>
          <button type="button" onclick="askHostedQuestion('Do you have any signed merch or discount codes right now?')" class="text-left text-xs px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 transition">
            🎟️ Signed merch &amp; promo codes
          </button>
          <button type="button" onclick="askHostedQuestion('How can I book you for a podcast, event, or shoutout?')" class="text-left text-xs px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 transition">
            🎙️ Booking &amp; podcast requests
          </button>
        </div>
      </div>

      <div class="pt-3 border-t border-white/10 text-[11px] text-slate-400 leading-relaxed">
        Built on consent: ${safeName} approves the voice, likeness, and every piece of content this twin uses, and can pause or delete it anytime.
      </div>
    </section>

    <!-- Right Embedded Live Chat Panel -->
    <section class="lg:col-span-7 glass-card rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col h-[540px]">
      <div class="px-5 py-4 border-b border-white/10 flex items-center justify-between" style="background: linear-gradient(135deg, ${primaryColor}33 0%, #111827 100%);">
        <div class="flex items-center gap-3">
          <img src="${safeAvatar}" alt="${safeName}" class="w-10 h-10 rounded-full object-cover border border-white/40" />
          <div>
            <div class="text-sm font-bold text-white font-headline">Chat with ${safeName}</div>
            <div class="text-[11px] text-emerald-300">Replies from ${safeName}'s verified info</div>
          </div>
        </div>
        <button type="button" id="hosted-voice-toggle" onclick="toggleHostedVoice()" class="text-xs px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-slate-200 font-medium transition">
          🔊 Voice: Off
        </button>
      </div>

      <div id="hosted-chat-messages" class="flex-1 p-5 overflow-y-auto space-y-3 bg-[#0b0d13] text-sm">
        <div class="bg-white/5 border border-white/10 text-slate-100 px-4 py-3 rounded-2xl rounded-bl-sm max-w-[85%] leading-relaxed">
          ${safeWelcome}
        </div>
      </div>

      <form onsubmit="event.preventDefault(); sendHostedMessage();" class="p-4 bg-[#12151e] border-t border-white/10 flex gap-2.5">
        <input id="hosted-chat-input" type="text" placeholder="Ask ${safeName} about appearances, signed merch, bookings, or FAQs..." class="flex-1 bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-400" />
        <button type="submit" id="hosted-chat-send" class="px-5 py-3 rounded-xl font-bold text-sm text-white transition hover:opacity-90" style="background:${primaryColor}">
          Send
        </button>
      </form>
    </section>
  </main>

  <footer class="relative z-10 border-t border-white/5 py-6 text-center text-xs text-slate-500">
    Hosted on <a href="/" class="text-slate-300 hover:text-white underline">Twwinz.com</a> • Want your own twin page? <a href="/onboard.html" class="text-blue-400 hover:underline">Get started in 2 minutes</a>
  </footer>

  <!-- Floating Chat Widget -->
  <script src="/widget.js" data-creator="${safeSlug}" data-primary-color="${primaryColor}" data-accent-color="${accentColor}" data-heading-font="${headingFont}" data-body-font="${bodyFont}" defer></script>

  <script>
    const HOSTED_CREATOR_SLUG = ${JSON.stringify(publicCreator.slug)};
    const HOSTED_CREATOR_ID = ${JSON.stringify(publicCreator.id)};
    let hostedHistory = [];
    let hostedVoiceEnabled = false;

    function toggleHostedVoice() {
      hostedVoiceEnabled = !hostedVoiceEnabled;
      const btn = document.getElementById('hosted-voice-toggle');
      btn.textContent = hostedVoiceEnabled ? '🔊 Voice: On' : '🔊 Voice: Off';
      if (!hostedVoiceEnabled && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }

    function speakHostedReply(text) {
      if (!hostedVoiceEnabled || !('speechSynthesis' in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.02;
        window.speechSynthesis.speak(utter);
      } catch (_) {}
    }

    function askHostedQuestion(q) {
      const input = document.getElementById('hosted-chat-input');
      input.value = q;
      sendHostedMessage();
    }

    function escapeClientHtml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function sendHostedMessage() {
      const input = document.getElementById('hosted-chat-input');
      const box = document.getElementById('hosted-chat-messages');
      const query = input.value.trim();
      if (!query) return;
      input.value = '';

      box.innerHTML += '<div class="flex justify-end"><div class="px-4 py-2.5 rounded-2xl rounded-br-sm text-white max-w-[82%]" style="background:${primaryColor}">' + escapeClientHtml(query) + '</div></div>';
      box.scrollTop = box.scrollHeight;
      hostedHistory.push({ sender: 'fan', message: query });

      const typingId = 'typing-' + Date.now();
      box.innerHTML += '<div id="' + typingId + '" class="text-xs text-slate-400 italic px-2">Thinking...</div>';
      box.scrollTop = box.scrollHeight;

      try {
        const res = await fetch('/api/chat/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorId: HOSTED_CREATOR_ID || HOSTED_CREATOR_SLUG,
            query,
            chatHistory: hostedHistory.slice(-6)
          })
        });
        const data = await res.json();
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        const reply = data.reply || 'Thanks for reaching out!';
        let photoHtml = '';
        if (Array.isArray(data.ragSources)) {
          const withImg = data.ragSources.find(s => s && s.imageUrl);
          if (withImg) {
            photoHtml = '<div class="mt-2"><img src="' + escapeClientHtml(withImg.imageUrl) + '" alt="' + escapeClientHtml(withImg.title || 'Photo') + '" class="rounded-xl max-h-52 border border-white/10 object-cover" /></div>';
          }
        }
        box.innerHTML += '<div class="bg-white/5 border border-white/10 text-slate-100 px-4 py-3 rounded-2xl rounded-bl-sm max-w-[85%] leading-relaxed">' + escapeClientHtml(reply) + photoHtml + '</div>';
        box.scrollTop = box.scrollHeight;
        hostedHistory.push({ sender: 'twin', message: reply });
        speakHostedReply(reply);
      } catch (err) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function addCorsHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleApiRoute(url, request, env) {
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;
  const ghlService = new GHLService(env);
  const ragEngine = new RAGEngine(db, env);

  // Healthcheck & System Info
  if (path === '/api/health' && method === 'GET') {
    const dbCheck = await db.prepare('SELECT 1 as alive').first();
    return jsonResponse({
      status: 'healthy',
      database: dbCheck?.alive === 1 ? 'connected' : 'unavailable',
      hasAgencyKey: !!env.GHL_AGENCY_API_KEY,
      hasGoogleOAuth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      hasR2Bucket: !!env.MEDIA_BUCKET,
      companyId: env.GHL_COMPANY_ID || null,
      timestamp: new Date().toISOString()
    });
  }

  // 0. Google OAuth 2.0 Authentication Routes
  if (path === '/api/auth/google' && method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: 'GOOGLE_CLIENT_ID is not configured on this Worker' }, 500);
    }

    const redirectAfter = sanitizeInternalPath(url.searchParams.get('redirect') || '');
    const nonce = crypto.randomUUID();
    const statePayload = btoa(JSON.stringify({ nonce, redirect: redirectAfter }));
    const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;

    const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    googleAuthUrl.searchParams.set('redirect_uri', redirectUri);
    googleAuthUrl.searchParams.set('response_type', 'code');
    googleAuthUrl.searchParams.set('scope', 'openid email profile');
    googleAuthUrl.searchParams.set('access_type', 'online');
    googleAuthUrl.searchParams.set('prompt', 'select_account');
    googleAuthUrl.searchParams.set('state', statePayload);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': googleAuthUrl.toString(),
        'Set-Cookie': serializeCookie('twwinz_oauth_state', nonce, { maxAge: 600, secure: requestIsSecure(url) })
      }
    });
  }

  if (path === '/api/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
      return Response.redirect(`${url.origin}/onboard.html?auth_error=${encodeURIComponent(oauthError)}`, 302);
    }

    const stateCheck = verifyOAuthState(request, stateParam);
    if (!stateCheck.ok) {
      return Response.redirect(`${url.origin}/onboard.html?auth_error=invalid_state`, 302);
    }
    const requestedRedirect = stateCheck.redirect;

    if (!code) {
      return Response.redirect(`${url.origin}/onboard.html?auth_error=missing_code`, 302);
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: 'Google OAuth credentials are not configured on this Worker' }, 500);
    }

    const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Google OAuth Token Error]', tokenData);
      return Response.redirect(`${url.origin}/onboard.html?auth_error=token_exchange_failed`, 302);
    }

    // Fetch Google user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const userInfo = await userRes.json();
    if (!userRes.ok || !userInfo.email) {
      return Response.redirect(`${url.origin}/onboard.html?auth_error=userinfo_failed`, 302);
    }

    await ensureAuthTables(db);

    // Check if creator already exists for this Google email
    const existingCreator = await db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
      .bind(userInfo.email)
      .first();

    const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare(`
      INSERT INTO auth_sessions (token, google_id, email, name, picture, creator_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionToken,
      userInfo.sub || '',
      userInfo.email,
      userInfo.name || userInfo.email.split('@')[0],
      userInfo.picture || null,
      existingCreator ? existingCreator.id : null,
      expiresAt
    ).run();

    // Determine destination URL
    let targetPath = '/onboard.html?auth=google';
    if (requestedRedirect && requestedRedirect.startsWith('/')) {
      targetPath = requestedRedirect;
      if (existingCreator && (targetPath.startsWith('/dashboard.html') || targetPath.startsWith('/settings.html')) && !targetPath.includes('id=')) {
        targetPath += (targetPath.includes('?') ? '&' : '?') + `id=${encodeURIComponent(existingCreator.id)}`;
      }
    } else if (existingCreator) {
      targetPath = `/dashboard.html?id=${encodeURIComponent(existingCreator.id)}`;
    }

    const secure = requestIsSecure(url);
    const sessionCookie = serializeCookie('twwinz_session', sessionToken, { maxAge: 30 * 24 * 60 * 60, secure });
    const clearStateCookie = serializeCookie('twwinz_oauth_state', '', { maxAge: 0, secure });

    const headers = new Headers();
    headers.set('Location', `${url.origin}${targetPath}`);
    headers.append('Set-Cookie', sessionCookie);
    headers.append('Set-Cookie', clearStateCookie);

    return new Response(null, { status: 302, headers });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    await ensureAuthTables(db);
    const session = await getAuthenticatedSession(request, db);
    if (!session) {
      return jsonResponse({ authenticated: false, user: null, creator: null });
    }

    let creator = null;
    if (session.creator_id) {
      creator = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(session.creator_id).first();
    }
    if (!creator && session.email) {
      creator = await db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
        .bind(session.email)
        .first();
    }

    return jsonResponse({
      authenticated: true,
      user: {
        googleId: session.google_id,
        email: session.email,
        name: session.name,
        picture: session.picture
      },
      creator: creator ? toOwnerCreator(creator, { includeApiKey: false }) : null
    });
  }

  if (path === '/api/auth/logout' && (method === 'POST' || method === 'GET')) {
    await ensureAuthTables(db);
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    if (cookies.twwinz_session) {
      await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(cookies.twwinz_session).run();
    }

    const clearCookie = serializeCookie('twwinz_session', '', { maxAge: 0, secure: requestIsSecure(url) });

    if (method === 'GET') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `${url.origin}/index.html`,
          'Set-Cookie': clearCookie
        }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie
      }
    });
  }

  // 0a-2. Email + Password Registration & Login (for non-Google / alias emails)
  if (path === '/api/auth/register' && method === 'POST') {
    await ensureAuthTables(db);
    const ip = clientIp(request);
    const regLimit = await hitRateLimit(db, `auth-reg:${ip}`, 10, 600);
    if (!regLimit.allowed) return tooMany(regLimit.retryAfter);

    const body = await request.json().catch(() => ({}));
    const rawEmail = String(body.email || '').trim().toLowerCase();
    const rawName = String(body.name || '').trim();
    const rawPassword = String(body.password || '');

    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return jsonResponse({ error: 'A valid email address is required' }, 400);
    }
    if (rawPassword.length < 8) {
      return jsonResponse({ error: 'Password must be at least 8 characters long' }, 400);
    }

    const existingUser = await db.prepare('SELECT * FROM auth_users WHERE LOWER(email) = LOWER(?)').bind(rawEmail).first();
    if (existingUser) {
      return jsonResponse({ error: 'An account with this email already exists. Please sign in instead.' }, 409);
    }

    const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    const displayName = rawName || rawEmail.split('@')[0];
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(saltBytes, b => b.toString(16).padStart(2, '0')).join('');
    const passwordHash = await hashPasswordPbkdf2(rawPassword, saltHex);
    const passwordEnc = await encryptSecret(rawPassword, env);

    await db.prepare(`
      INSERT INTO auth_users (id, email, name, password_hash, password_salt, password_enc, email_verified)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(userId, rawEmail, displayName, passwordHash, saltHex, passwordEnc).run();

    const existingCreator = await db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
      .bind(rawEmail)
      .first();

    const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare(`
      INSERT INTO auth_sessions (token, google_id, email, name, picture, creator_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionToken,
      `email:${userId}`,
      rawEmail,
      displayName,
      null,
      existingCreator ? existingCreator.id : null,
      expiresAt
    ).run();

    const secure = requestIsSecure(url);
    const sessionCookie = serializeCookie('twwinz_session', sessionToken, { maxAge: 30 * 24 * 60 * 60, secure });

    return jsonResponse({
      success: true,
      authenticated: true,
      user: {
        id: userId,
        email: rawEmail,
        name: displayName
      },
      creator: existingCreator ? toOwnerCreator(existingCreator, { includeApiKey: false }) : null
    }, 201, { 'Set-Cookie': sessionCookie });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    await ensureAuthTables(db);
    const ip = clientIp(request);
    const loginLimit = await hitRateLimit(db, `auth-login:${ip}`, 15, 600);
    if (!loginLimit.allowed) return tooMany(loginLimit.retryAfter);

    const body = await request.json().catch(() => ({}));
    const rawEmail = String(body.email || '').trim().toLowerCase();
    const rawPassword = String(body.password || '');

    if (!rawEmail || !rawPassword) {
      return jsonResponse({ error: 'Email and password are required' }, 400);
    }

    const userRow = await db.prepare('SELECT * FROM auth_users WHERE LOWER(email) = LOWER(?)').bind(rawEmail).first();
    if (!userRow) {
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    const valid = await verifyPasswordPbkdf2(rawPassword, userRow.password_salt, userRow.password_hash);
    if (!valid) {
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    const existingCreator = await db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
      .bind(rawEmail)
      .first();

    const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare(`
      INSERT INTO auth_sessions (token, google_id, email, name, picture, creator_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionToken,
      `email:${userRow.id}`,
      userRow.email,
      userRow.name || rawEmail.split('@')[0],
      null,
      existingCreator ? existingCreator.id : null,
      expiresAt
    ).run();

    const secure = requestIsSecure(url);
    const sessionCookie = serializeCookie('twwinz_session', sessionToken, { maxAge: 30 * 24 * 60 * 60, secure });

    return jsonResponse({
      success: true,
      authenticated: true,
      user: {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name
      },
      creator: existingCreator ? toOwnerCreator(existingCreator, { includeApiKey: false }) : null,
      redirectUrl: existingCreator
        ? `/dashboard.html?id=${encodeURIComponent(existingCreator.id)}`
        : '/onboard.html'
    }, 200, { 'Set-Cookie': sessionCookie });
  }

  // 0b. HighLevel (GoHighLevel) OAuth 2.0 Authorization Flow — Start & Callback
  if (path === '/api/oauth/ghl/start' && method === 'GET') {
    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const session = sessionGate.session;

    let creator = null;
    const requestedCreatorId = url.searchParams.get('creatorId');
    if (requestedCreatorId) {
      const owned = await requireOwnedCreator(request, db, requestedCreatorId);
      if (owned.response) return owned.response;
      creator = owned.creator;
    } else {
      creator = await findCreatorForSession(db, session);
    }

    if (!creator) {
      return jsonResponse({ error: 'Creator profile not found' }, 404);
    }
    if (isDemoCreator(creator.id) || isDemoCreator(creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }

    if (!isGhlOAuthConfigured(env)) {
      return jsonResponse({
        error: 'HighLevel OAuth is not configured on this server yet. Please set GHL_CLIENT_ID and GHL_CLIENT_SECRET.'
      }, 503);
    }

    const redirectUri = getGhlOAuthRedirectUri(request.url, env);
    const state = await createGhlOAuthState(db, {
      creatorId: creator.id,
      userEmail: session.email,
      redirectAfter: `${url.origin}/settings.html?id=${encodeURIComponent(creator.id)}`
    });

    const authUrl = buildGhlAuthorizationUrl({
      clientId: env.GHL_CLIENT_ID,
      redirectUri,
      state
    });

    return Response.redirect(authUrl, 302);
  }

  if (path === '/api/oauth/ghl/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
      return Response.redirect(`${url.origin}/settings.html?ghl_oauth_error=${encodeURIComponent(errorParam)}`, 302);
    }
    if (!code || !stateParam) {
      return jsonResponse({ error: 'Missing code or state parameter' }, 400);
    }

    const stateRow = await consumeGhlOAuthState(db, stateParam);
    if (!stateRow) {
      return jsonResponse({ error: 'Invalid or expired HighLevel OAuth state' }, 400);
    }

    const creator = await loadCreator(db, stateRow.creator_id);
    if (!creator) {
      return jsonResponse({ error: 'Creator not found' }, 404);
    }

    const activeSession = await readSession(request, db);
    if (activeSession && !sessionOwnsCreator(activeSession, creator)) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    const connectedByEmail = activeSession?.email || stateRow.user_email || creator.email;

    const rawRedirectAfter = stateRow.redirect_after || `/settings.html?id=${encodeURIComponent(creator.id)}`;
    const baseRedirectUrl = /^https?:\/\//i.test(rawRedirectAfter)
      ? rawRedirectAfter
      : `${url.origin}${rawRedirectAfter}`;

    try {
      const redirectUri = getGhlOAuthRedirectUri(request.url, env);
      const tokenData = await exchangeGhlCodeForTokens({
        code,
        redirectUri,
        env
      });

      await saveGhlOAuthConnection(db, env, {
        creatorId: creator.id,
        locationId: tokenData.locationId,
        companyId: tokenData.companyId,
        userType: tokenData.userType,
        scope: tokenData.scope,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresIn: tokenData.expiresIn,
        connectedByEmail
      });

      // Attempt to auto-discover the sub-account's native Live Chat widget ID
      try {
        const widgetsRes = await ghlService.getChatWidgets(tokenData.locationId, tokenData.accessToken);
        if (widgetsRes.success && Array.isArray(widgetsRes.widgets) && widgetsRes.widgets.length > 0) {
          const firstWidgetId = widgetsRes.widgets[0]?.id || widgetsRes.widgets[0]?._id;
          if (firstWidgetId && !String(firstWidgetId).startsWith('wgt_')) {
            await db.prepare('UPDATE creators SET ghl_widget_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .bind(firstWidgetId, creator.id)
              .run();
          }
        }
      } catch (_) {}

      const sep = baseRedirectUrl.includes('?') ? '&' : '?';
      return Response.redirect(`${baseRedirectUrl}${sep}ghl_oauth=connected`, 302);
    } catch (oauthErr) {
      console.error('[GHL OAuth Callback Error]', oauthErr.message);
      const sep = baseRedirectUrl.includes('?') ? '&' : '?';
      return Response.redirect(
        `${baseRedirectUrl}${sep}ghl_oauth_error=${encodeURIComponent(oauthErr.message)}`,
        302
      );
    }
  }

  // 1. Scrape Website Styles (Colors, Fonts, Meta) — signed-in creators only
  if (path === '/api/utils/scrape-styles' && method === 'POST') {
    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const scrapeLimit = await hitRateLimit(db, `scrape:${sessionGate.session.email.toLowerCase()}`, 8, 600);
    if (!scrapeLimit.allowed) return tooMany(scrapeLimit.retryAfter);

    const body = await request.json();
    const safeUrl = assertPublicHttpUrl(body.url);
    if (!safeUrl) {
      return jsonResponse({ error: 'A public http(s) URL is required' }, 400);
    }
    const styles = await scrapeWebsiteStyles(safeUrl);
    return jsonResponse(styles);
  }

  // 1b. Analyze Uploaded Image for RAG Indexing via Cloudflare Workers AI Vision
  if (path === '/api/utils/analyze-image' && method === 'POST') {
    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const visionLimit = await hitRateLimit(db, `vision:${sessionGate.session.email.toLowerCase()}`, 20, 600);
    if (!visionLimit.allowed) return tooMany(visionLimit.retryAfter);

    const body = await request.json();
    const { imageDataUrl, title } = body;
    if (!imageDataUrl || String(imageDataUrl).length > 2_000_000) {
      return jsonResponse({ error: 'imageDataUrl is required' }, 400);
    }

    if (env.AI) {
      try {
        const base64Data = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        const aiVision = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
          image: Array.from(bytes),
          prompt: `Describe what is in this photo${title ? ` titled "${title}"` : ''} in 2 concise, factual sentences so fans asking about it in chat can get an accurate description and see the photo.`,
          max_tokens: 120
        });

        if (aiVision && aiVision.description) {
          return jsonResponse({ description: aiVision.description.trim() });
        }
      } catch (visionErr) {
        console.warn('[Workers AI Vision Warning]', visionErr.message);
      }
    }

    return jsonResponse({
      description: title
        ? `Official photo: ${title}. Ask to see this picture in chat!`
        : 'Official uploaded photo. Add a short caption describing what is in this picture so your AI Twin knows when to share it with fans.'
    });
  }

  // 1c. Serve R2 Media Objects via Signed or Authenticated URL
  if (path.startsWith('/api/media/') && method === 'GET') {
    const r2Key = decodeURIComponent(path.slice('/api/media/'.length));
    if (!r2Key || !r2Key.startsWith('creators/') || r2Key.includes('..')) {
      return jsonResponse({ error: 'Invalid media key' }, 400);
    }

    const parts = r2Key.split('/');
    const keyCreatorId = parts[1] || '';

    const expParam = url.searchParams.get('exp');
    const sigParam = url.searchParams.get('sig');
    const hasValidSignature = await verifyMediaSignature(r2Key, expParam, sigParam, env);

    if (!hasValidSignature && !isDemoCreator(keyCreatorId)) {
      const session = await readSession(request, db);
      if (!session) {
        return jsonResponse({ error: 'Authentication or valid signed URL required' }, 401);
      }
      const creator = await loadCreator(db, keyCreatorId);
      if (!creator || !sessionOwnsCreator(session, creator)) {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }
    }

    const bucket = getMediaBucket(env);
    const obj = await bucket.get(r2Key);
    if (!obj) {
      return jsonResponse({ error: 'Media not found' }, 404);
    }

    const contentType = obj.httpMetadata?.contentType || 'image/jpeg';
    const bodyBuffer = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : obj.body;

    return new Response(bodyBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  // 1d. Direct R2 Photo Upload Endpoint for Authenticated Creator
  const mediaUploadMatch = path.match(/^\/api\/creators\/([^/]+)\/media$/);
  if (mediaUploadMatch && method === 'POST') {
    const creatorId = mediaUploadMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }

    const body = await request.json();
    const { imageDataUrl, fileName, itemId } = body;
    if (!imageDataUrl || !isDataUriImage(imageDataUrl)) {
      return jsonResponse({ error: 'Valid imageDataUrl is required' }, 400);
    }

    const uploadMeta = await uploadImageToR2(env, {
      creatorId: owned.creator.id,
      itemId: itemId || `img_${Date.now()}`,
      dataUri: imageDataUrl,
      fileName: fileName || 'photo.jpg'
    });
    const signedUrl = await signMediaUrl(uploadMeta.r2_key, env);

    return jsonResponse({
      ...uploadMeta,
      signed_url: signedUrl
    }, 201);
  }

  // 1e. One-Time Data-URI to R2 Migration Endpoint
  if (path === '/api/admin/migrate-images' && method === 'POST') {
    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const result = await migrateDataUriImages(db, env);
    return jsonResponse({
      success: true,
      ...result
    });
  }

  // 2. Creator Signup & Automated GHL Provisioning (Enforces 1 Digital Twin per signed-in account)
  if (path === '/api/creators/signup' && method === 'POST') {
    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const session = sessionGate.session;
    const signupLimit = await hitRateLimit(db, `signup:${session.email.toLowerCase()}`, 5, 3600);
    if (!signupLimit.allowed) return tooMany(signupLimit.retryAfter);

    const body = await request.json();
    const { name, websiteType, websiteUrl, personaPrompt, avatarUrl, headline } = body;
    if (body.email && String(body.email).toLowerCase() !== String(session.email).toLowerCase()) {
      return jsonResponse({ error: 'Email must match the signed-in Google account' }, 403);
    }
    const email = session.email;

    if (!name || !email) {
      return jsonResponse({ error: 'Name and email are required' }, 400);
    }

    // Check if this user/email already has a Digital Twin
    const existingCreator = await db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
      .bind(email)
      .first();

    if (existingCreator) {
      if (isDemoCreator(existingCreator.id) || isDemoCreator(existingCreator.slug)) {
        return jsonResponse({ error: 'Demo creator is read-only' }, 403);
      }
      await db.prepare(`
        UPDATE creators
        SET name = ?, headline = COALESCE(?, headline), avatar_url = COALESCE(?, avatar_url),
            persona_prompt = COALESCE(?, persona_prompt), welcome_message = COALESCE(?, welcome_message),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        name,
        headline || null,
        avatarUrl || null,
        personaPrompt || null,
        body.welcomeMessage || null,
        existingCreator.id
      ).run();

      try {
        await ensureAuthTables(db);
        const cookies = parseCookies(request.headers.get('Cookie') || '');
        if (cookies.twwinz_session) {
          await db.prepare('UPDATE auth_sessions SET creator_id = ? WHERE token = ?')
            .bind(existingCreator.id, cookies.twwinz_session)
            .run();
        }
      } catch (_) {}

      const updatedExisting = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(existingCreator.id).first();
      const embedSnippet = ghlService.generateEmbedSnippet(updatedExisting, url.origin);
      return jsonResponse({
        success: true,
        existing: true,
        creator: updatedExisting,
        embedSnippet
      }, 200);
    }

    // Slug generation
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const uniqueSuffix = Math.floor(1000 + Math.random() * 9000);
    const slug = `${baseSlug}-${uniqueSuffix}`;
    const creatorId = `clb_${Date.now()}`;

    // Extract or default brand styles
    let brandColors = { primary: '#3b82f6', accent: '#f59e0b', background: '#0f172a', surface: '#1e293b' };
    let brandFonts = { heading: 'Space Grotesk', body: 'Inter' };

    if (body.brandColors) {
      brandColors = { ...brandColors, ...body.brandColors };
    }
    if (body.brandFonts) {
      brandFonts = { ...brandFonts, ...body.brandFonts };
    }

    if (!body.brandColors && websiteType === 'existing' && websiteUrl) {
      const scraped = await scrapeWebsiteStyles(websiteUrl);
      if (scraped.success) {
        brandColors = scraped.colors;
        brandFonts = scraped.fonts;
      }
    }

    // If user registered via Email + Password, pass their password to GHL user provisioning
    let userChosenPassword = body.password || null;
    if (!userChosenPassword) {
      try {
        await ensureAuthTables(db);
        const authUser = await db.prepare('SELECT password_enc FROM auth_users WHERE LOWER(email) = LOWER(?)').bind(email).first();
        if (authUser && authUser.password_enc) {
          userChosenPassword = await decryptSecret(authUser.password_enc, env);
        }
      } catch (_) {}
    }

    // Provision GHL Sub-Account (with snapshot template if creating site on GHL)
    const ghlProvision = await ghlService.provisionSubAccount({
      name,
      email,
      websiteType,
      snapshotId: body.snapshotId,
      password: userChosenPassword
    });

    // Configure GHL Chat Widget styling
    await ghlService.configureChatWidget({
      locationId: ghlProvision.locationId,
      colors: brandColors,
      fonts: brandFonts,
      avatarUrl: avatarUrl,
      headline: headline || `${name}'s Official Twin`,
      welcomeMessage: body.welcomeMessage
    });

    // Insert Creator into D1
    const insertSql = `
      INSERT INTO creators (
        id, name, slug, email, headline, bio_summary, website_type, website_url,
        brand_colors, brand_fonts, avatar_url, ghl_location_id, ghl_widget_id,
        persona_prompt, welcome_message, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `;

    await db.prepare(insertSql).bind(
      creatorId,
      name,
      slug,
      email,
      headline || `Official AI Twin for ${name}`,
      body.bioSummary || `Digital representative for ${name}`,
      websiteType || 'existing',
      websiteUrl || null,
      JSON.stringify(brandColors),
      JSON.stringify(brandFonts),
      avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
      ghlProvision.locationId,
      ghlProvision.widgetId,
      personaPrompt || `You are the official verified AI Twin for ${name}. Speak warmly, concisely, and accurately based on verified schedule and offers.`,
      body.welcomeMessage || `Hey! Welcome to ${name}'s official AI Twin. Ask me about upcoming appearances, signed merch, booking inquiries, or FAQs!`
    ).run();

    // Persist provisioned Sub-Account Admin login credentials (encrypted) so the creator can authorize OAuth in 1 click
    try {
      await saveProvisionedSubAccountUser(db, env, {
        creatorId,
        locationId: ghlProvision.locationId,
        userId: ghlProvision.userId,
        loginEmail: ghlProvision.loginEmail || email,
        tempPassword: ghlProvision.tempPassword
      });
    } catch (subErr) {
      console.warn('[Save Provisioned GHL User Warning]', subErr.message);
    }

    // Seed default knowledge item
    const initialKnowledgeId = `k_init_${Date.now()}`;
    await db.prepare(`
      INSERT INTO knowledge_items (id, creator_id, category, title, content, priority, is_active)
      VALUES (?, ?, 'bio', 'Official Welcome & Overview', ?, 10, 1)
    `).bind(
      initialKnowledgeId,
      creatorId,
      `Welcome to ${name}'s official AI Twin. Here fans can ask about upcoming convention appearances, local events, signed merch, booking inquiries, and FAQs.`
    ).run();

    // Populate FTS
    await db.prepare(`
      INSERT INTO knowledge_fts (id, creator_id, title, content)
      VALUES (?, ?, 'Official Welcome & Overview', ?)
    `).bind(initialKnowledgeId, creatorId, `Welcome to ${name}'s official AI Twin.`).run();

    // Link current Google OAuth session to the newly created creator if logged in
    try {
      await ensureAuthTables(db);
      const cookies = parseCookies(request.headers.get('Cookie') || '');
      if (cookies.twwinz_session) {
        await db.prepare('UPDATE auth_sessions SET creator_id = ? WHERE token = ?')
          .bind(creatorId, cookies.twwinz_session)
          .run();
      }
    } catch (_) {}

    const createdCreator = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(creatorId).first();
    const embedSnippet = ghlService.generateEmbedSnippet(createdCreator, url.origin);

    return jsonResponse({
      success: true,
      creator: createdCreator,
      ghl: ghlProvision,
      embedSnippet
    }, 201);
  }

  // 3. List or Get Creators
  // The directory is private. Slug/id lookups return a public widget profile unless the caller owns the creator.
  if (path === '/api/creators' && method === 'GET') {
    const slug = url.searchParams.get('slug');
    const id = url.searchParams.get('id');

    if (slug || id) {
      const creator = await loadCreator(db, slug || id);
      if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);
      const session = await readSession(request, db);
      if (sessionOwnsCreator(session, creator)) return jsonResponse(toOwnerCreator(creator));
      if (!creator.is_active) return jsonResponse({ error: 'Creator not found' }, 404);
      return jsonResponse(toPublicCreator(creator));
    }

    const sessionGate = await requireSession(request, db);
    if (sessionGate.response) return sessionGate.response;
    const own = await findCreatorForSession(db, sessionGate.session);
    return jsonResponse(own ? [toOwnerCreator(own)] : []);
  }

  // 4. Update Creator Profile / Persona
  const creatorMatch = path.match(/^\/api\/creators\/([^/]+)$/);
  if (creatorMatch && method === 'PUT') {
    const creatorId = creatorMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }
    const body = await request.json();

    const updates = [];
    const values = [];

    if (body.name) { updates.push('name = ?'); values.push(body.name); }
    if (body.headline) { updates.push('headline = ?'); values.push(body.headline); }
    if (body.persona_prompt) { updates.push('persona_prompt = ?'); values.push(body.persona_prompt); }
    if (body.welcome_message) { updates.push('welcome_message = ?'); values.push(body.welcome_message); }
    if (body.avatar_url) { updates.push('avatar_url = ?'); values.push(body.avatar_url); }
    if (body.ghl_location_id !== undefined) { updates.push('ghl_location_id = ?'); values.push(body.ghl_location_id); }
    if (body.ghl_widget_id !== undefined) { updates.push('ghl_widget_id = ?'); values.push(body.ghl_widget_id); }
    if (body.ghl_api_key !== undefined) { updates.push('ghl_api_key = ?'); values.push(body.ghl_api_key); }
    if (body.brand_colors) { updates.push('brand_colors = ?'); values.push(JSON.stringify(body.brand_colors)); }
    if (body.brand_fonts) { updates.push('brand_fonts = ?'); values.push(JSON.stringify(body.brand_fonts)); }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(owned.creator.id);
      await db.prepare(`UPDATE creators SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }

    const updated = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(owned.creator.id).first();
    return jsonResponse(toOwnerCreator(updated));
  }

  // 4b. HighLevel Connection Status (OAuth 2.0 + Provisioned Sub-Account Credentials + Fallback Status)
  const ghlConnMatch = path.match(/^\/api\/creators\/([^/]+)\/ghl-connection$/);
  if (ghlConnMatch && method === 'GET') {
    const creatorId = ghlConnMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    const status = await getGhlConnectionStatus(db, env, owned.creator);
    return jsonResponse(status);
  }

  // 4c. Disconnect HighLevel OAuth Connection
  const ghlDisconnectMatch = path.match(/^\/api\/creators\/([^/]+)\/ghl-disconnect$/);
  if (ghlDisconnectMatch && method === 'POST') {
    const creatorId = ghlDisconnectMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }
    const body = await request.json().catch(() => ({}));
    await disconnectGhlOAuth(db, owned.creator.id, {
      clearPrivateToken: Boolean(body?.clearPrivateToken)
    });
    const updatedCreator = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(owned.creator.id).first();
    const status = await getGhlConnectionStatus(db, env, updatedCreator);
    return jsonResponse({ success: true, ...status });
  }

  // 4d. Provision (or Re-Provision) GHL Sub-Account & Sub-Account Admin User
  const ghlProvisionMatch = path.match(/^\/api\/creators\/([^/]+)\/ghl-provision$/);
  if (ghlProvisionMatch && method === 'POST') {
    const creatorId = ghlProvisionMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }

    const creator = owned.creator;
    const hasRealLocation = creator.ghl_location_id && !String(creator.ghl_location_id).startsWith('loc_');

    let locationId = creator.ghl_location_id;
    let userId = null;
    let loginEmail = creator.email;
    let tempPassword = null;

    if (!hasRealLocation) {
      const prov = await ghlService.provisionSubAccount({
        name: creator.name,
        email: creator.email,
        websiteType: creator.website_type || 'ghl_hosted'
      });
      locationId = prov.locationId;
      userId = prov.userId;
      loginEmail = prov.loginEmail || creator.email;
      tempPassword = prov.tempPassword;

      await db.prepare('UPDATE creators SET ghl_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(locationId, creator.id)
        .run();
    } else {
      const subUser = await ghlService.provisionSubAccountUser({
        name: creator.name,
        email: creator.email,
        locationId
      });
      userId = subUser.userId;
      loginEmail = subUser.loginEmail || creator.email;
      tempPassword = subUser.tempPassword;
    }

    await saveProvisionedSubAccountUser(db, env, {
      creatorId: creator.id,
      locationId,
      userId,
      loginEmail,
      tempPassword
    });

    const refreshedCreator = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(creator.id).first();
    const status = await getGhlConnectionStatus(db, env, refreshedCreator);
    return jsonResponse({
      success: true,
      ...status
    });
  }

  // 4e. Upsert Fan Contact Strictly Inside Creator's Authorized GHL Sub-Account (locationId)
  const ghlContactsMatch = path.match(/^\/api\/creators\/([^/]+)\/contacts$/);
  if (ghlContactsMatch && method === 'POST') {
    const creatorId = ghlContactsMatch[1];
    const creator = await loadCreator(db, creatorId);
    if (!creator || !creator.is_active) {
      return jsonResponse({ error: 'Creator not found' }, 404);
    }
    if (isDemoCreator(creator.id) || isDemoCreator(creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }

    const ip = clientIp(request);
    const contactLimit = await hitRateLimit(db, `contact:${ip}:${creator.id}`, 15, 600);
    if (!contactLimit.allowed) return tooMany(contactLimit.retryAfter);

    const body = await request.json().catch(() => ({}));
    const { name, email, phone, tags, source } = body;
    if (!email && !phone) {
      return jsonResponse({ error: 'Either email or phone is required' }, 400);
    }

    const creds = await resolveCreatorGhlCredentials(db, env, creator);
    if (!creds.locationId || String(creds.locationId).startsWith('loc_')) {
      return jsonResponse({ error: 'Creator has not connected a valid HighLevel Sub-Account yet' }, 400);
    }

    const result = await ghlService.upsertContact({
      token: creds.token,
      locationId: creds.locationId,
      name,
      email,
      phone,
      tags: Array.isArray(tags) ? tags : ['twwinz-fan'],
      source: source || 'Twwinz AI Twin Chat'
    });

    if (!result.success) {
      return jsonResponse({ error: result.error || 'Failed to sync contact to HighLevel' }, 502);
    }

    return jsonResponse({
      success: true,
      locationId: result.locationId,
      contactId: result.contactId,
      authMethod: creds.authMethod
    }, 201);
  }

  // 5. Get Knowledge Items (RAG Data)
  const knowledgeListMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge$/);
  if (knowledgeListMatch && method === 'GET') {
    const creatorId = knowledgeListMatch[1];
    const category = url.searchParams.get('category');
    if (isDemoCreator(creatorId)) {
      const results = await queryKnowledge(db, DEMO_CREATOR_ID, category);
      return jsonResponse(await signKnowledgeItemsMedia(results, env));
    }
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    const results = await queryKnowledge(db, owned.creator.id, category);
    return jsonResponse(await signKnowledgeItemsMedia(results, env));
  }

  // 6. Add Knowledge Item (with R2 photo storage, automatic Vector Embedding & Vectorize storage)
  if (knowledgeListMatch && method === 'POST') {
    const creatorId = knowledgeListMatch[1];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }
    const body = await request.json();
    const { category, title, content, metadata, priority } = body;

    if (!title || !content || !category) {
      return jsonResponse({ error: 'Title, category, and content are required' }, 400);
    }

    const itemId = `k_${category.substring(0, 3)}_${Date.now()}`;
    const storedCreatorId = owned.creator.id;

    // Never store raw data:image URIs in D1; upload them to Cloudflare R2 and store only the R2 key/URL and metadata
    let parsedMeta = metadata
      ? (typeof metadata === 'string' ? parseJsonObject(metadata, {}) : { ...metadata })
      : null;
    let cleanContent = content;

    const rawDataUri = (parsedMeta && isDataUriImage(parsedMeta.image_url))
      ? parsedMeta.image_url
      : (isDataUriImage(content) ? content : null);

    if (rawDataUri) {
      const uploaded = await uploadImageToR2(env, {
        creatorId: storedCreatorId,
        itemId,
        dataUri: rawDataUri,
        fileName: (parsedMeta && parsedMeta.file_name) || `${itemId}.jpg`
      });
      parsedMeta = {
        ...(parsedMeta || {}),
        r2_key: uploaded.r2_key,
        image_url: uploaded.image_url,
        content_type: uploaded.content_type,
        size_bytes: uploaded.size_bytes,
        file_name: uploaded.file_name
      };
      if (isDataUriImage(cleanContent)) {
        cleanContent = title;
      }
    }

    const metaStr = parsedMeta ? JSON.stringify(parsedMeta) : null;

    // Generate 768-dimensional vector embedding
    const textToEmbed = `${title}: ${cleanContent}`;
    const vector = await ragEngine.generateEmbedding(textToEmbed);
    const embeddingStr = vector ? JSON.stringify(vector) : null;

    // 1. Insert into D1 relational database with vector
    await db.prepare(`
      INSERT INTO knowledge_items (id, creator_id, category, title, content, metadata, embedding, priority, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(itemId, storedCreatorId, category, title, cleanContent, metaStr, embeddingStr, priority || 0).run();

    // 2. Sync to D1 FTS5 full-text search table
    await db.prepare(`
      INSERT INTO knowledge_fts (id, creator_id, title, content)
      VALUES (?, ?, ?, ?)
    `).bind(itemId, storedCreatorId, title, cleanContent).run();

    // 3. Sync to Cloudflare Vectorize index
    if (env.VECTORIZE && vector) {
      try {
        await env.VECTORIZE.insert([{
          id: itemId,
          values: vector,
          metadata: { creatorId: storedCreatorId, category, title }
        }]);
      } catch (vecErr) {
        console.warn('[Vectorize Insert Warning]', vecErr.message);
      }
    }

    const createdItem = await db.prepare('SELECT * FROM knowledge_items WHERE id = ?').bind(itemId).first();
    const [signedItem] = await signKnowledgeItemsMedia([createdItem], env);
    return jsonResponse(signedItem, 201);
  }

  // 7. Delete Knowledge Item (removes from R2, D1, FTS5, and Vectorize)
  const knowledgeDeleteMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge\/([^/]+)$/);
  if (knowledgeDeleteMatch && method === 'DELETE') {
    const creatorId = knowledgeDeleteMatch[1];
    const itemId = knowledgeDeleteMatch[2];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
    }

    const existingItem = await db.prepare('SELECT * FROM knowledge_items WHERE id = ? AND creator_id = ?')
      .bind(itemId, owned.creator.id)
      .first();
    if (existingItem && existingItem.metadata) {
      try {
        const meta = typeof existingItem.metadata === 'string' ? JSON.parse(existingItem.metadata) : existingItem.metadata;
        const r2Key = extractR2Key(meta?.r2_key || meta?.image_url);
        if (r2Key) {
          await getMediaBucket(env).delete(r2Key);
        }
      } catch (_) {}
    }

    await db.prepare('DELETE FROM knowledge_items WHERE id = ? AND creator_id = ?').bind(itemId, owned.creator.id).run();
    await db.prepare('DELETE FROM knowledge_fts WHERE id = ?').bind(itemId).run();

    if (env.VECTORIZE) {
      try {
        await env.VECTORIZE.deleteByIds([itemId]);
      } catch (_) {}
    }

    return jsonResponse({ success: true, deletedId: itemId });
  }

  // 8. Generate Embed Code
  const embedMatch = path.match(/^\/api\/creators\/([^/]+)\/embed$/);
  if (embedMatch && method === 'GET') {
    const creatorId = embedMatch[1];
    const creator = await loadCreator(db, creatorId);
    if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);
    const demoRead = isDemoCreator(creator.id) || isDemoCreator(creator.slug);
    if (!demoRead) {
      const owned = await requireOwnedCreator(request, db, creator.id);
      if (owned.response) return owned.response;
    }

    const embedCode = ghlService.generateEmbedSnippet(creator, url.origin);
    const ghlWidgetId = creator.ghl_widget_id || `wgt_${creator.ghl_location_id}`;
    const ghlNativeEmbed = ghlService.generateGhlNativeSnippet(ghlWidgetId);

    return jsonResponse({
      creatorId: creator.id,
      slug: creator.slug,
      hostedUrl: `${url.origin}/${creator.slug}`,
      ghlLocationId: creator.ghl_location_id,
      ghlWidgetId: ghlWidgetId,
      embedCode,
      ghlNativeEmbed
    });
  }

  // 9. Interactive Chat Preview (Test Grounded RAG in Sandbox)
  if (path === '/api/chat/preview' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const creatorId = body?.creatorId;
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const chatHistory = clampChatHistory(body?.chatHistory);

    if (!creatorId || !query) {
      return jsonResponse({ error: 'creatorId and query are required' }, 400);
    }
    if (query.length > 500) {
      return jsonResponse({ error: 'Query is too long' }, 400);
    }

    const creator = await loadCreator(db, creatorId);
    if (!creator || !creator.is_active) return jsonResponse({ error: 'Creator not found' }, 404);

    const session = await readSession(request, db);
    const owns = sessionOwnsCreator(session, creator);
    const ip = clientIp(request);
    const windowSec = 600;
    const limits = owns
      ? [
          [`chat-owner:${session.email.toLowerCase()}:${creator.id}`, 60]
        ]
      : [
          [`chat:${ip}:${creator.id}`, 20],
          [`chat-ip:${ip}`, 40],
          [`chat-creator:${creator.id}`, 200]
        ];
    for (const [bucket, limit] of limits) {
      const result = await hitRateLimit(db, bucket, limit, windowSec);
      if (!result.allowed) return tooMany(result.retryAfter);
    }

    const result = await ragEngine.generateResponse({
      creator,
      query,
      chatHistory
    });

    // Automatically extract fan email / phone from current query or chatHistory, upsert Contact in GHL, and log Conversation
    try {
      const allFanText = [
        ...chatHistory.filter(m => m.sender === 'fan').map(m => m.message),
        query
      ].join('\n');

      const emailMatch = allFanText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const phoneMatch = allFanText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      const nameMatch = allFanText.match(/(?:my\s+name\s+is|i\s*am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);

      const detectedEmail = body?.fanEmail || (emailMatch ? emailMatch[0].toLowerCase() : null);
      const detectedPhone = body?.fanPhone || (phoneMatch ? phoneMatch[0] : null);
      const detectedName = body?.fanName || (nameMatch ? nameMatch[1].trim() : null);

      let ghlContactId = null;
      let ghlConversationId = null;

      if ((detectedEmail || detectedPhone) && !isDemoCreator(creator.id) && !isDemoCreator(creator.slug)) {
        const creds = await resolveCreatorGhlCredentials(db, env, creator);
        if (creds.token && creds.locationId && !String(creds.locationId).startsWith('loc_')) {
          const contactRes = await ghlService.upsertContact({
            token: creds.token,
            locationId: creds.locationId,
            name: detectedName || (detectedEmail ? detectedEmail.split('@')[0] : 'Fan Lead'),
            email: detectedEmail,
            phone: detectedPhone,
            tags: ['twwinz-fan', 'chat-lead'],
            source: 'Twwinz AI Twin Chat'
          });

          if (contactRes.success && contactRes.contactId) {
            ghlContactId = contactRes.contactId;
            result.ghlContactSynced = true;
            result.ghlContactId = ghlContactId;

            const convRes = await ghlService.logChatExchangeToGhl({
              token: creds.token,
              locationId: creds.locationId,
              contactId: ghlContactId,
              fanMessage: query,
              twinReply: result.reply
            });

            if (convRes.conversationId) {
              ghlConversationId = convRes.conversationId;
              result.ghlConversationId = ghlConversationId;
            }
            result.ghlConversationLogged = Boolean(convRes.success);
          }
        }
      }

      // Log chat session & messages in D1 for creator analytics & history
      const sessionKey = detectedEmail || detectedPhone || ip || 'anon';
      const d1SessionId = `web_${creator.id}_${sessionKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
      await db.prepare(`
        INSERT OR REPLACE INTO chat_sessions (id, creator_id, ghl_contact_id, ghl_conversation_id, fan_name, fan_email, fan_phone, channel, last_message_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'twwinz_widget', CURRENT_TIMESTAMP)
      `).bind(
        d1SessionId,
        creator.id,
        ghlContactId,
        ghlConversationId,
        detectedName || 'Website Visitor',
        detectedEmail,
        detectedPhone
      ).run();

      await db.prepare(`
        INSERT INTO chat_messages (id, session_id, creator_id, sender, message, rag_sources)
        VALUES (?, ?, ?, 'fan', ?, NULL), (?, ?, ?, 'twin', ?, ?)
      `).bind(
        `msg_f_${Date.now()}`,
        d1SessionId,
        creator.id,
        query,
        `msg_t_${Date.now() + 1}`,
        d1SessionId,
        creator.id,
        result.reply || '',
        JSON.stringify((result.ragSources || []).map(s => s.id))
      ).run();
    } catch (syncErr) {
      console.warn('[Auto GHL Contact & Conversation Sync Warning]', syncErr.message);
    }

    return jsonResponse(result);
  }

  // 10. GoHighLevel Inbound Message Webhook (Choice A: Cloudflare RAG Brain -> GHL Chat Widget)
  if (path === '/api/chat/ghl-webhook' && method === 'POST') {
    const webhookAuth = webhookSecretOk(request, url, env);
    if (webhookAuth.configured && !webhookAuth.ok) {
      return jsonResponse({ error: 'Unauthorized webhook' }, 401);
    }
    const ip = clientIp(request);
    const webhookLimit = webhookAuth.ok ? 400 : 40;
    const ipLimit = await hitRateLimit(db, `ghl:${ip}`, webhookLimit, 600);
    if (!ipLimit.allowed) return tooMany(ipLimit.retryAfter);

    const body = await request.json();

    // Support both GHL Workflow Webhook payloads (nested location.id & message.body) and flat payloads
    const creatorIdParam = url.searchParams.get('creatorId') || body.creatorId || body.customData?.creatorId || null;
    const locationId = body.locationId || body.location_id || body.location?.id || body.customData?.locationId || null;
    const conversationId = body.conversationId || body.conversation_id || body.message?.conversationId || body.customData?.conversationId || null;
    const contactId = body.contactId || body.contact_id || body.contact?.id || body.id || null;
    const fanMessage = typeof body.message === 'object' && body.message !== null
      ? (body.message.body || body.message.text)
      : (body.body || body.message || body.text || body.customData?.message);

    if (!fanMessage || (!locationId && !creatorIdParam)) {
      return jsonResponse({ error: 'Missing fan message or creatorId/locationId' }, 400);
    }

    // Locate the creator by explicit creatorId (from webhook URL) or by ghl_location_id
    let creator = null;
    if (creatorIdParam) {
      creator = await db.prepare('SELECT * FROM creators WHERE id = ? OR slug = ?').bind(creatorIdParam, creatorIdParam).first();
      // Auto-link the real GHL location ID on first webhook if creator still has a placeholder loc_ghl_ ID
      const placeholderLocation = !creator?.ghl_location_id || String(creator.ghl_location_id).startsWith('loc_ghl_');
      if (creator && locationId && creator.ghl_location_id !== locationId && placeholderLocation && webhookAuth.ok) {
        await db.prepare('UPDATE creators SET ghl_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(locationId, creator.id)
          .run();
        creator.ghl_location_id = locationId;
      }
    }
    if (!creator && locationId) {
      creator = await db.prepare('SELECT * FROM creators WHERE ghl_location_id = ?').bind(locationId).first();
    }

    if (!creator) {
      return jsonResponse({ error: `No creator matched to GHL location ${locationId || creatorIdParam}` }, 404);
    }

    const sessionId = `ses_${conversationId || contactId || Date.now()}`;

    // Retrieve recent chat history for this fan session so multi-turn context matches the website widget
    let chatHistory = [];
    try {
      const historyRes = await db.prepare(
        'SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 6'
      ).bind(sessionId).all();
      if (historyRes.results) {
        chatHistory = historyRes.results.reverse();
      }
    } catch (_) {}

    // Execute RAG & Persona Generation (Exact same engine as dashboard & website widget)
    const ragResult = await ragEngine.generateResponse({
      creator,
      query: fanMessage,
      chatHistory
    });

    // Resolve HighLevel credentials (prefers OAuth 2.0 Location Token with auto-refresh, falls back to existing Private Integration Token)
    const ghlCreds = await resolveCreatorGhlCredentials(db, env, creator);
    const resolvedLocationId = locationId || ghlCreds.locationId || creator.ghl_location_id;

    // Send response back to the fan via GHL Conversations API
    const ghlReplyResult = await ghlService.sendReplyToConversation({
      locationApiKey: ghlCreds.token,
      locationId: resolvedLocationId,
      conversationId: conversationId,
      contactId: contactId,
      replyText: ragResult.reply
    });

    // Record fan message and AI twin response in D1 for conversation continuity & telemetry
    try {
      await db.prepare(`
        INSERT OR REPLACE INTO chat_sessions (id, creator_id, ghl_contact_id, ghl_conversation_id, fan_name, fan_email, last_message_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        sessionId,
        creator.id,
        contactId,
        conversationId,
        body.full_name || body.first_name || null,
        body.email || null
      ).run();

      const fanMsgId = `msg_fan_${Date.now()}`;
      await db.prepare(`
        INSERT INTO chat_messages (id, session_id, creator_id, sender, message)
        VALUES (?, ?, ?, 'fan', ?)
      `).bind(fanMsgId, sessionId, creator.id, fanMessage).run();

      const twinMsgId = `msg_twin_${Date.now() + 1}`;
      await db.prepare(`
        INSERT INTO chat_messages (id, session_id, creator_id, sender, message, rag_sources)
        VALUES (?, ?, ?, 'twin', ?, ?)
      `).bind(twinMsgId, sessionId, creator.id, ragResult.reply, JSON.stringify(ragResult.ragSources)).run();
    } catch (logErr) {
      console.warn('[Telemetry Log Warning]', logErr.message);
    }

    return jsonResponse({
      success: true,
      creatorId: creator.id,
      reply: ragResult.reply,
      ragSources: ragResult.ragSources,
      ghl: ghlReplyResult
    });
  }

  return jsonResponse({ error: `Not Found: ${method} ${path}` }, 404);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

function tooMany(retryAfter) {
  return jsonResponse({ error: 'Too many requests' }, 429, {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfter || 60)))
  });
}

async function ensureAuthTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      google_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      creator_id TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_enc TEXT,
      email_verified INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function hashPasswordPbkdf2(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(String(saltHex)),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPasswordPbkdf2(password, saltHex, expectedHashHex) {
  if (!password || !saltHex || !expectedHashHex) return false;
  const computed = await hashPasswordPbkdf2(password, saltHex);
  return safeEqual(computed, String(expectedHashHex));
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const key = part.substring(0, idx).trim();
      const val = part.substring(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  });
  return cookies;
}

async function getAuthenticatedSession(request, db) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  let token = cookies.twwinz_session;
  if (!token) {
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }
  if (!token) return null;

  const session = await db.prepare('SELECT * FROM auth_sessions WHERE token = ?').bind(token).first();
  if (!session) return null;

  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return session;
}

export function sanitizeInternalPath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\') || trimmed.includes('://')) {
    return '';
  }
  let parsed;
  try {
    parsed = new URL(trimmed, 'https://www.twwinz.com');
  } catch (_) {
    return '';
  }
  if (parsed.origin !== 'https://www.twwinz.com') return '';
  if (!ALLOWED_REDIRECT_PATHS.has(parsed.pathname)) return '';
  return parsed.pathname + parsed.search;
}

export function requestIsSecure(url) {
  return url.protocol === 'https:';
}

export function serializeCookie(name, value, { maxAge, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function verifyOAuthState(request, stateParam) {
  if (!stateParam || stateParam.length > 2000) return { ok: false };
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  if (!cookies.twwinz_oauth_state) return { ok: false };
  try {
    const parsed = JSON.parse(atob(stateParam));
    if (!parsed || typeof parsed.nonce !== 'string' || !safeEqual(parsed.nonce, cookies.twwinz_oauth_state)) {
      return { ok: false };
    }
    return { ok: true, redirect: sanitizeInternalPath(parsed.redirect || '') };
  } catch (_) {
    return { ok: false };
  }
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const left = enc.encode(String(a ?? ''));
  const right = enc.encode(String(b ?? ''));
  const len = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

function isDemoCreator(idOrSlug) {
  if (!idOrSlug) return false;
  const value = String(idOrSlug);
  return value === DEMO_CREATOR_ID || value === DEMO_CREATOR_SLUG;
}

function sessionOwnsCreator(session, creator) {
  if (!session || !creator) return false;
  if (session.creator_id && session.creator_id === creator.id) return true;
  if (session.email && creator.email && String(session.email).toLowerCase() === String(creator.email).toLowerCase()) {
    return true;
  }
  return false;
}

async function loadCreator(db, idOrSlug) {
  return db.prepare('SELECT * FROM creators WHERE id = ? OR slug = ?').bind(idOrSlug, idOrSlug).first();
}

async function findCreatorForSession(db, session) {
  if (!session) return null;
  if (session.creator_id) {
    const byId = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(session.creator_id).first();
    if (byId) return byId;
  }
  if (session.email) {
    return db.prepare('SELECT * FROM creators WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1')
      .bind(session.email)
      .first();
  }
  return null;
}

async function readSession(request, db) {
  await ensureAuthTables(db);
  return getAuthenticatedSession(request, db);
}

async function requireSession(request, db) {
  const session = await readSession(request, db);
  if (!session) return { response: jsonResponse({ error: 'Authentication required' }, 401) };
  return { session };
}

async function requireOwnedCreator(request, db, idOrSlug) {
  const creator = await loadCreator(db, idOrSlug);
  if (!creator) return { response: jsonResponse({ error: 'Creator not found' }, 404) };
  const sessionGate = await requireSession(request, db);
  if (sessionGate.response) return sessionGate;
  if (!sessionOwnsCreator(sessionGate.session, creator)) {
    return { response: jsonResponse({ error: 'Forbidden' }, 403) };
  }
  return { session: sessionGate.session, creator };
}

function toPublicCreator(creator) {
  const pub = {};
  for (const field of PUBLIC_CREATOR_FIELDS) pub[field] = creator[field];
  return pub;
}

function toOwnerCreator(creator, { includeApiKey = true } = {}) {
  const copy = { ...creator };
  if (!includeApiKey) delete copy.ghl_api_key;
  return copy;
}

async function queryKnowledge(db, creatorId, category) {
  let sql = 'SELECT * FROM knowledge_items WHERE creator_id = ? AND is_active = 1';
  const params = [creatorId];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY priority DESC, created_at DESC';
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function ensureRateTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS api_rate_limits (
      bucket TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      hits INTEGER NOT NULL
    )
  `).run();
}

async function hitRateLimit(db, bucket, limit, windowSec) {
  await ensureRateTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT window_start, hits FROM api_rate_limits WHERE bucket = ?').bind(bucket).first();
  if (!row || (now - Number(row.window_start)) >= windowSec) {
    await db.prepare('INSERT OR REPLACE INTO api_rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)')
      .bind(bucket, now)
      .run();
    return { allowed: true };
  }
  if (Number(row.hits) >= limit) {
    return { allowed: false, retryAfter: windowSec - (now - Number(row.window_start)) };
  }
  await db.prepare('UPDATE api_rate_limits SET hits = ? WHERE bucket = ?')
    .bind(Number(row.hits) + 1, bucket)
    .run();
  return { allowed: true };
}

function clampChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-6).map((msg) => ({
    sender: msg?.sender === 'twin' ? 'twin' : 'fan',
    message: String(msg?.message || '').slice(0, 1000)
  }));
}

function assertPublicHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let target = raw.trim();
  if (!target) return null;
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  let parsed;
  try {
    parsed = new URL(target);
  } catch (_) {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isBlockedHost(host)
  ) {
    return null;
  }
  return parsed.href;
}

function isBlockedHost(host) {
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function webhookSecretOk(request, url, env) {
  const expected = env.GHL_WEBHOOK_SECRET;
  if (!expected) return { configured: false, ok: false };
  const header = request.headers.get('X-Twwinz-Webhook-Token') || '';
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = url.searchParams.get('token') || header || bearer;
  return { configured: true, ok: !!token && safeEqual(token, expected) };
}

function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function sanitizeColor(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(str) {
  return escapeHtml(str);
}
