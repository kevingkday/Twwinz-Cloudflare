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
      companyId: env.GHL_COMPANY_ID || null,
      timestamp: new Date().toISOString()
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
