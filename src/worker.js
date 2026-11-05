import { scrapeWebsiteStyles } from './services/styleScraper.js';
import { GHLService } from './services/ghlService.js';
import { RAGEngine } from './services/ragEngine.js';

const DEMO_CREATOR_ID = 'clb_jaxson_reed';
const DEMO_CREATOR_SLUG = 'jaxson-reed';
const ALLOWED_REDIRECT_PATHS = new Set(['/', '/index.html', '/onboard.html', '/dashboard.html', '/settings.html']);
const PUBLIC_CREATOR_FIELDS = [
  'id', 'name', 'slug', 'headline', 'avatar_url', 'brand_colors', 'brand_fonts',
  'welcome_message', 'website_type', 'is_active'
];

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
        SET name = ?, headline = COALESCE(?, headline), avatar_url = COALESCE(?, avatar_url), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(name, headline || null, avatarUrl || null, existingCreator.id).run();

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

  // 5. Get Knowledge Items (RAG Data)
  const knowledgeListMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge$/);
  if (knowledgeListMatch && method === 'GET') {
    const creatorId = knowledgeListMatch[1];
    const category = url.searchParams.get('category');
    if (isDemoCreator(creatorId)) {
      const results = await queryKnowledge(db, DEMO_CREATOR_ID, category);
      return jsonResponse(results);
    }
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    const results = await queryKnowledge(db, owned.creator.id, category);
    return jsonResponse(results);
  }

  // 6. Add Knowledge Item (with automatic Vector Embedding & Vectorize storage)
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
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    // Generate 768-dimensional vector embedding
    const textToEmbed = `${title}: ${content}`;
    const vector = await ragEngine.generateEmbedding(textToEmbed);
    const embeddingStr = vector ? JSON.stringify(vector) : null;

    // 1. Insert into D1 relational database with vector
    await db.prepare(`
      INSERT INTO knowledge_items (id, creator_id, category, title, content, metadata, embedding, priority, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(itemId, storedCreatorId, category, title, content, metaStr, embeddingStr, priority || 0).run();

    // 2. Sync to D1 FTS5 full-text search table
    await db.prepare(`
      INSERT INTO knowledge_fts (id, creator_id, title, content)
      VALUES (?, ?, ?, ?)
    `).bind(itemId, storedCreatorId, title, content).run();

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
    return jsonResponse(createdItem, 201);
  }

  // 7. Delete Knowledge Item (removes from D1, FTS5, and Vectorize)
  const knowledgeDeleteMatch = path.match(/^\/api\/creators\/([^/]+)\/knowledge\/([^/]+)$/);
  if (knowledgeDeleteMatch && method === 'DELETE') {
    const creatorId = knowledgeDeleteMatch[1];
    const itemId = knowledgeDeleteMatch[2];
    const owned = await requireOwnedCreator(request, db, creatorId);
    if (owned.response) return owned.response;
    if (isDemoCreator(owned.creator.id) || isDemoCreator(owned.creator.slug)) {
      return jsonResponse({ error: 'Demo creator is read-only' }, 403);
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

    // Send response back to the fan via GHL Conversations API
    const ghlReplyResult = await ghlService.sendReplyToConversation({
      locationApiKey: creator.ghl_api_key,
      locationId: locationId || creator.ghl_location_id,
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
