import { scrapeWebsiteStyles } from './services/styleScraper.js';
import { GHLService } from './services/ghlService.js';
import { RAGEngine } from './services/ragEngine.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Enable CORS for API routes
    if (request.method === 'OPTIONS') {
      return handleCors();
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

    // Fallback to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Twwinz Platform Ready', { status: 200 });
  }
};

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
      companyId: env.GHL_COMPANY_ID || null,
      timestamp: new Date().toISOString()
    });
  }

  // 0. Google OAuth 2.0 Authentication Routes
  if (path === '/api/auth/google' && method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: 'GOOGLE_CLIENT_ID is not configured on this Worker' }, 500);
    }

    const redirectAfter = url.searchParams.get('redirect') || '';
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

    const isSecure = url.protocol === 'https:';
    const cookieFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isSecure ? '; Secure' : ''}`;

    return new Response(null, {
      status: 302,
      headers: {
        'Location': googleAuthUrl.toString(),
        'Set-Cookie': `twwinz_oauth_state=${ nonce }; ${ cookieFlags }`
      }
    });
  }

  if (path === '/api/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError || !code) {
      return Response.redirect(`${url.origin}/onboard.html?auth_error=${encodeURIComponent(oauthError || 'missing_code')}`, 302);
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: 'Google OAuth credentials are not configured on this Worker' }, 500);
    }

    let requestedRedirect = '';
    if (stateParam) {
      try {
        const parsedState = JSON.parse(atob(stateParam));
        const cookies = parseCookies(request.headers.get('Cookie') || '');
        if (cookies.twwinz_oauth_state && parsedState.nonce !== cookies.twwinz_oauth_state) {
          return Response.redirect(`${url.origin}/onboard.html?auth_error=invalid_state`, 302);
        }
        requestedRedirect = parsedState.redirect || '';
      } catch (_) {}
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

    const isSecure = url.protocol === 'https:';
    const sessionCookie = `twwinz_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isSecure ? '; Secure' : ''}`;
    const clearStateCookie = `twwinz_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`;

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
      creator: creator || null
    });
  }

  if (path === '/api/auth/logout' && (method === 'POST' || method === 'GET')) {
    await ensureAuthTables(db);
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    if (cookies.twwinz_session) {
      await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(cookies.twwinz_session).run();
    }

    const isSecure = url.protocol === 'https:';
    const clearCookie = `twwinz_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`;

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

  // 1. Scrape Website Styles (Colors, Fonts, Meta)
  if (path === '/api/utils/scrape-styles' && method === 'POST') {
    const body = await request.json();
    if (!body.url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    const styles = await scrapeWebsiteStyles(body.url);
    return jsonResponse(styles);
  }

  // 1b. Analyze Uploaded Image for RAG Indexing via Cloudflare Workers AI Vision
  if (path === '/api/utils/analyze-image' && method === 'POST') {
    const body = await request.json();
    const { imageDataUrl, title } = body;
    if (!imageDataUrl) {
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

  // 2. Creator Signup & Automated GHL Provisioning
  if (path === '/api/creators/signup' && method === 'POST') {
    const body = await request.json();
    const { name, email, websiteType, websiteUrl, personaPrompt, avatarUrl, headline } = body;

    if (!name || !email) {
      return jsonResponse({ error: 'Name and email are required' }, 400);
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

    // Provision GHL Sub-Account (with snapshot template if creating site on GHL)
    const ghlProvision = await ghlService.provisionSubAccount({
      name,
      email,
      websiteType,
      snapshotId: body.snapshotId
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
        persona_prompt, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
      personaPrompt || `You are the official verified AI Twin for ${name}. Speak warmly, concisely, and accurately based on verified schedule and offers.`
    ).run();

    // Seed default knowledge item
    const initialKnowledgeId = `k_init_${Date.now()}`;
    await db.prepare(`
      INSERT INTO knowledge_items (id, creator_id, category, title, content, priority, is_active)
      VALUES (?, ?, 'bio', 'Official Welcome & Overview', ?, 10, 1)
    `).bind(
      initialKnowledgeId,
      creatorId,
      `Welcome to ${name}'s official AI Twin. Here fans can discover upcoming tour dates, unreleased project announcements, VIP passes, and direct merchandise discounts.`
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
  if (path === '/api/creators' && method === 'GET') {
    const slug = url.searchParams.get('slug');
    const id = url.searchParams.get('id');

    if (slug) {
      const creator = await db.prepare('SELECT * FROM creators WHERE slug = ?').bind(slug).first();
      if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);
      return jsonResponse(creator);
    }

    if (id) {
      const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(id).first();
      if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);
      return jsonResponse(creator);
    }

    const { results } = await db.prepare('SELECT id, name, slug, headline, avatar_url, website_type, website_url, created_at FROM creators WHERE is_active = 1 ORDER BY created_at DESC').all();
    return jsonResponse(results);
  }

  // 4. Update Creator Profile / Persona
  const creatorMatch = path.match(/^\/api\/creators\/([^/]+)$/);
  if (creatorMatch && method === 'PUT') {
    const creatorId = creatorMatch[1];
    const body = await request.json();

    const updates = [];
    const values = [];

    if (body.name) { updates.push('name = ?'); values.push(body.name); }
    if (body.headline) { updates.push('headline = ?'); values.push(body.headline); }
    if (body.persona_prompt) { updates.push('persona_prompt = ?'); values.push(body.persona_prompt); }
    if (body.welcome_message) { updates.push('welcome_message = ?'); values.push(body.welcome_message); }
    if (body.avatar_url) { updates.push('avatar_url = ?'); values.push(body.avatar_url); }
    if (body.brand_colors) { updates.push('brand_colors = ?'); values.push(JSON.stringify(body.brand_colors)); }
    if (body.brand_fonts) { updates.push('brand_fonts = ?'); values.push(JSON.stringify(body.brand_fonts)); }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(creatorId);
      await db.prepare(`UPDATE creators SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }

    const updated = await db.prepare('SELECT * FROM creators WHERE id = ?').bind(creatorId).first();
    return jsonResponse(updated);
  }

  // 5. Get Knowledge Items (RAG Data)
  const knowledgeListMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge$/);
  if (knowledgeListMatch && method === 'GET') {
    const creatorId = knowledgeListMatch[1];
    const category = url.searchParams.get('category');

    let sql = 'SELECT * FROM knowledge_items WHERE creator_id = ? AND is_active = 1';
    const params = [creatorId];
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY priority DESC, created_at DESC';

    const { results } = await db.prepare(sql).bind(...params).all();
    return jsonResponse(results);
  }

  // 6. Add Knowledge Item (with automatic Vector Embedding & Vectorize storage)
  if (knowledgeListMatch && method === 'POST') {
    const creatorId = knowledgeListMatch[1];
    const body = await request.json();
    const { category, title, content, metadata, priority } = body;

    if (!title || !content || !category) {
      return jsonResponse({ error: 'Title, category, and content are required' }, 400);
    }

    const itemId = `k_${category.substring(0, 3)}_${Date.now()}`;
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    // Generate 768-dimensional vector embedding
    const textToEmbed = `${title}: ${content}`;
    const vector = await ragEngine.generateEmbedding(textToEmbed);
    const embeddingStr = vector ? JSON.stringify(vector) : null;

    // 1. Insert into D1 relational database with vector
    await db.prepare(`
      INSERT INTO knowledge_items (id, creator_id, category, title, content, metadata, embedding, priority, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(itemId, creatorId, category, title, content, metaStr, embeddingStr, priority || 0).run();

    // 2. Sync to D1 FTS5 full-text search table
    await db.prepare(`
      INSERT INTO knowledge_fts (id, creator_id, title, content)
      VALUES (?, ?, ?, ?)
    `).bind(itemId, creatorId, title, content).run();

    // 3. Sync to Cloudflare Vectorize index
    if (env.VECTORIZE && vector) {
      try {
        await env.VECTORIZE.insert([{
          id: itemId,
          values: vector,
          metadata: { creatorId, category, title }
        }]);
      } catch (vecErr) {
        console.warn('[Vectorize Insert Warning]', vecErr.message);
      }
    }

    const createdItem = await db.prepare('SELECT * FROM knowledge_items WHERE id = ?').bind(itemId).first();
    return jsonResponse(createdItem, 201);
  }

  // 7. Delete Knowledge Item (removes from D1, FTS5, and Vectorize)
  const knowledgeDeleteMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge\/([^/]+)$/);
  if (knowledgeDeleteMatch && method === 'DELETE') {
    const creatorId = knowledgeDeleteMatch[1];
    const itemId = knowledgeDeleteMatch[2];

    await db.prepare('DELETE FROM knowledge_items WHERE id = ? AND creator_id = ?').bind(itemId, creatorId).run();
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
    const creator = await db.prepare('SELECT * FROM creators WHERE id = ? OR slug = ?').bind(creatorId, creatorId).first();
    if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);

    const embedCode = ghlService.generateEmbedSnippet(creator, url.origin);
    const ghlWidgetId = creator.ghl_widget_id || `wgt_${creator.ghl_location_id}`;
    const ghlNativeEmbed = ghlService.generateGhlNativeSnippet(ghlWidgetId);

    return jsonResponse({
      creatorId: creator.id,
      slug: creator.slug,
      ghlLocationId: creator.ghl_location_id,
      ghlWidgetId: ghlWidgetId,
      embedCode,
      ghlNativeEmbed
    });
  }

  // 9. Interactive Chat Preview (Test Grounded RAG in Sandbox)
  if (path === '/api/chat/preview' && method === 'POST') {
    const body = await request.json();
    const { creatorId, query, chatHistory } = body;

    if (!creatorId || !query) {
      return jsonResponse({ error: 'creatorId and query are required' }, 400);
    }

    const creator = await db.prepare('SELECT * FROM creators WHERE id = ? OR slug = ?').bind(creatorId, creatorId).first();
    if (!creator) return jsonResponse({ error: 'Creator not found' }, 404);

    const result = await ragEngine.generateResponse({
      creator,
      query,
      chatHistory: chatHistory || []
    });

    return jsonResponse(result);
  }

  // 10. GoHighLevel Inbound Message Webhook
  if (path === '/api/chat/ghl-webhook' && method === 'POST') {
    const body = await request.json();
    
    // GHL inbound webhook fields: locationId, conversationId, contactId, body (message)
    const locationId = body.locationId || body.location_id;
    const conversationId = body.conversationId || body.conversation_id;
    const contactId = body.contactId || body.contact_id;
    const fanMessage = body.body || body.message || body.text;

    if (!locationId || !fanMessage) {
      return jsonResponse({ error: 'Missing locationId or message' }, 400);
    }

    // Locate the creator linked to this GHL Sub-Account
    const creator = await db.prepare('SELECT * FROM creators WHERE ghl_location_id = ?').bind(locationId).first();
    if (!creator) {
      return jsonResponse({ error: `No creator matched to GHL location ${locationId}` }, 404);
    }

    // Execute RAG & Persona Generation
    const ragResult = await ragEngine.generateResponse({
      creator,
      query: fanMessage
    });

    // Send response back to the fan via GHL Conversations API
    const ghlReplyResult = await ghlService.sendReplyToConversation({
      locationApiKey: creator.ghl_api_key,
      locationId: locationId,
      conversationId: conversationId,
      contactId: contactId,
      replyText: ragResult.reply
    });

    // Record interaction in D1 for telemetry
    try {
      const sessionId = `ses_${conversationId || Date.now()}`;
      await db.prepare(`
        INSERT OR REPLACE INTO chat_sessions (id, creator_id, ghl_contact_id, ghl_conversation_id, last_message_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(sessionId, creator.id, contactId, conversationId).run();

      const msgId = `msg_${Date.now()}`;
      await db.prepare(`
        INSERT INTO chat_messages (id, session_id, creator_id, sender, message, rag_sources)
        VALUES (?, ?, ?, 'twin', ?, ?)
      `).bind(msgId, sessionId, creator.id, ragResult.reply, JSON.stringify(ragResult.ragSources)).run();
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
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
