import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  encryptSecret,
  decryptSecret,
  saveGhlOAuthConnection,
  resolveCreatorGhlCredentials
} from '../src/services/ghlOAuthService.js';

const FUTURE = '2099-01-01T00:00:00.000Z';

function createDb() {
  const creators = [];
  const knowledge = [];
  const sessions = [];
  const rates = new Map();
  const ghlStates = new Map();
  const ghlConnections = new Map();
  const authUsers = [];

  function execute(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE TABLE')) return {};
    if (text.includes('FROM auth_users WHERE LOWER(email) = LOWER(?)')) {
      const email = String(params[0]).toLowerCase();
      return { first: authUsers.find((u) => String(u.email).toLowerCase() === email) || null };
    }
    if (text.startsWith('INSERT INTO auth_users')) {
      authUsers.push({
        id: params[0],
        email: params[1],
        name: params[2],
        password_hash: params[3],
        password_salt: params[4],
        password_enc: params[5],
        email_verified: 1
      });
      return {};
    }
    if (text.startsWith('INSERT INTO auth_sessions')) {
      sessions.push({
        token: params[0],
        google_id: params[1],
        email: params[2],
        name: params[3],
        picture: params[4],
        creator_id: params[5],
        expires_at: params[6]
      });
      return {};
    }
    if (text.startsWith('INSERT INTO creators')) {
      creators.push({
        id: params[0],
        name: params[1],
        slug: params[2],
        email: params[3],
        headline: params[4],
        bio_summary: params[5],
        website_type: params[6],
        website_url: params[7],
        brand_colors: params[8],
        brand_fonts: params[9],
        avatar_url: params[10],
        ghl_location_id: params[11],
        ghl_widget_id: params[12],
        persona_prompt: params[13],
        is_active: 1
      });
      return {};
    }
    if (text.startsWith('INSERT INTO ghl_oauth_states')) {
      ghlStates.set(params[0], {
        state: params[0],
        creator_id: params[1],
        user_email: params[2],
        redirect_after: params[3],
        expires_at: params[4]
      });
      return {};
    }
    if (text.startsWith('SELECT * FROM ghl_oauth_states WHERE state = ?')) {
      return { first: ghlStates.get(params[0]) || null };
    }
    if (text.startsWith('DELETE FROM ghl_oauth_states WHERE state = ?')) {
      ghlStates.delete(params[0]);
      return {};
    }
    if (text.includes('FROM ghl_oauth_connections WHERE creator_id = ?')) {
      return { first: ghlConnections.get(params[0]) || null };
    }
    if (text.startsWith('INSERT OR REPLACE INTO ghl_oauth_connections')) {
      ghlConnections.set(params[0], {
        creator_id: params[0],
        location_id: params[1],
        company_id: params[2],
        user_type: params[3],
        scope: params[4],
        access_token_enc: params[5],
        refresh_token_enc: params[6],
        expires_at: params[7],
        connected_by_email: params[8],
        subaccount_user_id: params[9],
        subaccount_login_email: params[10],
        subaccount_temp_password_enc: params[11]
      });
      return {};
    }
    if (text.startsWith('INSERT INTO ghl_oauth_connections')) {
      ghlConnections.set(params[0], {
        creator_id: params[0],
        location_id: params[1],
        subaccount_user_id: params[2],
        subaccount_login_email: params[3],
        subaccount_temp_password_enc: params[4]
      });
      return {};
    }
    if (text.startsWith('UPDATE ghl_oauth_connections SET location_id = COALESCE')) {
      const existing = ghlConnections.get(params[4]) || { creator_id: params[4] };
      existing.location_id = params[0] || existing.location_id;
      existing.subaccount_user_id = params[1] || existing.subaccount_user_id;
      existing.subaccount_login_email = params[2] || existing.subaccount_login_email;
      existing.subaccount_temp_password_enc = params[3] || existing.subaccount_temp_password_enc;
      ghlConnections.set(params[4], existing);
      return {};
    }
    if (text.startsWith('UPDATE ghl_oauth_connections SET access_token_enc = NULL')) {
      const existing = ghlConnections.get(params[0]);
      if (existing) {
        existing.access_token_enc = null;
        existing.refresh_token_enc = null;
        existing.expires_at = null;
        existing.scope = null;
      }
      return {};
    }
    if (text.startsWith('UPDATE ghl_oauth_connections SET access_token_enc = ?')) {
      const existing = ghlConnections.get(params[4]);
      if (existing) {
        existing.access_token_enc = params[0];
        existing.refresh_token_enc = params[1];
        existing.expires_at = params[2];
        existing.location_id = params[3];
      }
      return {};
    }
    if (text.includes('SELECT id FROM creators WHERE ghl_location_id = ? AND id != ?')) {
      return { first: creators.find((c) => c.ghl_location_id === params[0] && c.id !== params[1]) || null };
    }
    if (text.startsWith('SELECT * FROM auth_sessions WHERE token = ?')) {
      return { first: sessions.find((s) => s.token === params[0]) || null };
    }
    if (text.startsWith('DELETE FROM auth_sessions WHERE token = ?')) {
      const idx = sessions.findIndex((s) => s.token === params[0]);
      if (idx >= 0) sessions.splice(idx, 1);
      return {};
    }
    if (text.includes('FROM creators WHERE id = ? OR slug = ?')) {
      return { first: creators.find((c) => c.id === params[0] || c.slug === params[1]) || null };
    }
    if (text.includes('FROM creators WHERE ghl_location_id = ?')) {
      return { first: creators.find((c) => c.ghl_location_id === params[0]) || null };
    }
    if (text.includes('FROM creators WHERE LOWER(email) = LOWER(?)')) {
      const email = String(params[0]).toLowerCase();
      return { first: creators.find((c) => String(c.email).toLowerCase() === email) || null };
    }
    if (text.includes('FROM creators WHERE id = ?')) {
      return { first: creators.find((c) => c.id === params[0]) || null };
    }
    if (text.includes('SELECT slug, updated_at FROM creators WHERE is_active = 1') || text.includes('SELECT slug FROM creators WHERE is_active = 1')) {
      return { rows: creators.filter((c) => c.is_active === 1).map((c) => ({ slug: c.slug, updated_at: c.updated_at })) };
    }
    if (text.includes('FROM knowledge_items WHERE id = ?')) {
      return { first: knowledge.find((k) => k.id === params[0]) || null };
    }
    if (text.includes('FROM knowledge_items WHERE creator_id = ?')) {
      let rows = knowledge.filter((k) => k.creator_id === params[0] && k.is_active === 1);
      if (text.includes('AND category = ?')) rows = rows.filter((k) => k.category === params[1]);
      return { rows };
    }
    if (text.includes('FROM knowledge_items WHERE is_active = 1')) {
      return { rows: knowledge.filter((k) => k.is_active === 1) };
    }
    if (text.startsWith('UPDATE knowledge_items SET metadata = ?, content = ? WHERE id = ?')) {
      const row = knowledge.find((k) => k.id === params[2]);
      if (row) {
        row.metadata = params[0];
        row.content = params[1];
      }
      return {};
    }
    if (text.includes('FROM api_rate_limits WHERE bucket = ?')) {
      return { first: rates.get(params[0]) || null };
    }
    if (text.startsWith('INSERT OR REPLACE INTO api_rate_limits')) {
      rates.set(params[0], { bucket: params[0], window_start: params[1], hits: 1 });
      return {};
    }
    if (text.startsWith('UPDATE api_rate_limits SET hits = ?')) {
      const row = rates.get(params[1]);
      if (row) row.hits = params[0];
      return {};
    }
    if (text.startsWith('UPDATE creators SET ghl_location_id')) {
      const row = creators.find((c) => c.id === params[1]);
      if (row) row.ghl_location_id = params[0];
      return {};
    }
    if (text.startsWith('INSERT INTO knowledge_items')) {
      knowledge.push({
        id: params[0],
        creator_id: params[1],
        category: params[2],
        title: params[3],
        content: params[4],
        metadata: params[5],
        embedding: params[6],
        priority: params[7],
        is_active: 1
      });
      return {};
    }
    if (text.startsWith('INSERT INTO knowledge_fts')) return {};
    if (text.startsWith('DELETE FROM knowledge_items')) {
      const idx = knowledge.findIndex((k) => k.id === params[0] && k.creator_id === params[1]);
      if (idx >= 0) knowledge.splice(idx, 1);
      return {};
    }
    if (text.startsWith('DELETE FROM knowledge_fts')) return {};
    if (text.startsWith('SELECT')) return { rows: [], first: null };
    if (text.startsWith('INSERT') || text.startsWith('UPDATE')) return {};
    throw new Error(`Unexpected SQL: ${text}`);
  }

  return {
    creators,
    knowledge,
    sessions,
    ghlStates,
    ghlConnections,
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) {
          params = p;
          return api;
        },
        async first() {
          return execute(sql, params).first ?? null;
        },
        async all() {
          return { results: execute(sql, params).rows ?? [] };
        },
        async run() {
          execute(sql, params);
          return { success: true };
        }
      };
      return api;
    }
  };
}

function seed(db) {
  db.creators.push(
    {
      id: 'clb_jaxson_reed',
      slug: 'jaxson-reed',
      name: 'Jaxson Reed',
      headline: 'Sci-Fi Actor & GalaxyCon Guest',
      email: 'jaxson@example.com',
      ghl_api_key: 'demo-key',
      persona_prompt: 'demo persona',
      welcome_message: 'Hey from Jaxson',
      is_active: 1,
      ghl_location_id: 'loc_ghl_demo'
    },
    {
      id: 'clb_owner',
      slug: 'owner',
      name: 'Owner',
      headline: 'Local Radio Host',
      email: 'owner@example.com',
      ghl_api_key: 'owner-secret',
      persona_prompt: 'owner persona',
      welcome_message: 'Hello owner',
      is_active: 1,
      ghl_location_id: 'loc_ghl_owner'
    },
    {
      id: 'clb_other',
      slug: 'other',
      name: 'Other',
      headline: 'Regional Athlete',
      email: 'other@example.com',
      ghl_api_key: 'other-secret',
      persona_prompt: 'secret persona',
      welcome_message: 'Hello other',
      is_active: 1,
      ghl_location_id: 'loc_real_other'
    }
  );
  db.knowledge.push(
    { id: 'k_demo', creator_id: 'clb_jaxson_reed', category: 'faq', title: 'Demo fact', content: 'demo memory', is_active: 1, priority: 1 },
    { id: 'k_owner', creator_id: 'clb_owner', category: 'faq', title: 'Mine', content: 'owner memory', is_active: 1, priority: 1 },
    { id: 'k_other', creator_id: 'clb_other', category: 'photo', title: 'Private photo', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', is_active: 1, priority: 1 }
  );
  db.sessions.push(
    { token: 'sess_owner', email: 'owner@example.com', name: 'Owner', creator_id: 'clb_owner', expires_at: FUTURE },
    { token: 'sess_demo', email: 'jaxson@example.com', name: 'Jaxson', creator_id: 'clb_jaxson_reed', expires_at: FUTURE },
    { token: 'sess_expired', email: 'owner@example.com', name: 'Owner', creator_id: 'clb_owner', expires_at: '2020-01-01T00:00:00.000Z' }
  );
}

function envFor(db, extra = {}) {
  return { DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ...extra };
}

async function call(db, path, { method = 'GET', cookie, bearer, body, ip, extraEnv } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`https://www.twwinz.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  }), envFor(db, extraEnv));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  return { status: res.status, json, headers: res.headers, text };
}

function fresh() {
  const db = createDb();
  seed(db);
  return db;
}

test('anonymous creator directory is rejected', async () => {
  const { status, json } = await call(fresh(), '/api/creators');
  assert.equal(status, 401);
  assert.equal(json.error, 'Authentication required');
});

test('signed-in user only receives their own creator', async () => {
  const { status, json } = await call(fresh(), '/api/creators', { cookie: 'twwinz_session=sess_owner' });
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].id, 'clb_owner');
  assert.equal(json[0].email, 'owner@example.com');
});

test('public profile lookup hides secrets from other creators', async () => {
  const { status, json } = await call(fresh(), '/api/creators?id=clb_other');
  assert.equal(status, 200);
  assert.equal(json.name, 'Other');
  assert.equal(json.welcome_message, 'Hello other');
  assert.equal(json.email, undefined);
  assert.equal(json.ghl_api_key, undefined);
  assert.equal(json.persona_prompt, undefined);
  assert.equal(json.ghl_location_id, undefined);
});

test('owner profile lookup includes their own secrets', async () => {
  const { status, json } = await call(fresh(), '/api/creators?slug=owner', { cookie: 'twwinz_session=sess_owner' });
  assert.equal(status, 200);
  assert.equal(json.email, 'owner@example.com');
  assert.equal(json.ghl_api_key, 'owner-secret');
});

test('anonymous knowledge read is rejected for a private creator and allowed for the demo', async () => {
  const db = fresh();
  const denied = await call(db, '/api/creators/clb_other/knowledge');
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.json).includes('SECRET'), false);

  const demo = await call(db, '/api/creators/clb_jaxson_reed/knowledge');
  assert.equal(demo.status, 200);
  assert.equal(demo.json.some((item) => item.title === 'Demo fact'), true);

  const demoBySlug = await call(db, '/api/creators/jaxson-reed/knowledge');
  assert.equal(demoBySlug.status, 200);
});

test('a signed-in user cannot read, write, or delete another creator', async () => {
  const db = fresh();
  const cookie = 'twwinz_session=sess_owner';
  const read = await call(db, '/api/creators/clb_other/knowledge', { cookie });
  assert.equal(read.status, 403);
  assert.equal(JSON.stringify(read.json).includes('SECRET'), false);

  const write = await call(db, '/api/creators/clb_other/knowledge', {
    method: 'POST',
    cookie,
    body: { category: 'faq', title: 'Stolen', content: 'nope' }
  });
  assert.equal(write.status, 403);
  assert.equal(db.knowledge.some((item) => item.title === 'Stolen'), false);

  const remove = await call(db, '/api/creators/clb_other/knowledge/k_other', { method: 'DELETE', cookie });
  assert.equal(remove.status, 403);
  assert.equal(db.knowledge.some((item) => item.id === 'k_other'), true);

  const update = await call(db, '/api/creators/clb_other', {
    method: 'PUT',
    cookie,
    body: { name: 'Hijacked' }
  });
  assert.equal(update.status, 403);
  assert.equal(db.creators.find((c) => c.id === 'clb_other').name, 'Other');
});

test('owner can read and add their own knowledge', async () => {
  const db = fresh();
  const cookie = 'twwinz_session=sess_owner';
  const read = await call(db, '/api/creators/clb_owner/knowledge', { cookie });
  assert.equal(read.status, 200);
  assert.equal(read.json[0].content, 'owner memory');

  const write = await call(db, '/api/creators/clb_owner/knowledge', {
    method: 'POST',
    cookie,
    bearer: undefined,
    body: { category: 'faq', title: 'New fact', content: 'saved' }
  });
  assert.equal(write.status, 201);
  assert.equal(write.json.creator_id, 'clb_owner');
});

test('bearer session works and an expired session does not', async () => {
  const db = fresh();
  const ok = await call(db, '/api/creators/clb_owner/knowledge', { bearer: 'sess_owner' });
  assert.equal(ok.status, 200);
  const expired = await call(db, '/api/creators/clb_owner/knowledge', { bearer: 'sess_expired' });
  assert.equal(expired.status, 401);
  assert.equal(db.sessions.some((s) => s.token === 'sess_expired'), false);
});

test('demo creator stays read-only, including for its owner session', async () => {
  const db = fresh();
  const anon = await call(db, '/api/creators/clb_jaxson_reed/knowledge', {
    method: 'POST',
    body: { category: 'faq', title: 'x', content: 'y' }
  });
  assert.equal(anon.status, 401);

  const owner = await call(db, '/api/creators/clb_jaxson_reed/knowledge', {
    method: 'POST',
    cookie: 'twwinz_session=sess_demo',
    body: { category: 'faq', title: 'x', content: 'y' }
  });
  assert.equal(owner.status, 403);
  assert.match(owner.json.error, /read-only/);
  assert.equal(db.knowledge.some((item) => item.title === 'x'), false);
});

test('signup, image analysis, and style scrape require a session', async () => {
  const db = fresh();
  const signup = await call(db, '/api/creators/signup', { method: 'POST', body: { name: 'A', email: 'a@a.com' } });
  assert.equal(signup.status, 401);
  const vision = await call(db, '/api/utils/analyze-image', { method: 'POST', body: { imageDataUrl: 'data:image/png,xx' } });
  assert.equal(vision.status, 401);
  const scrape = await call(db, '/api/utils/scrape-styles', { method: 'POST', body: { url: 'https://example.com' } });
  assert.equal(scrape.status, 401);
});

test('signup cannot target another creator email', async () => {
  const db = fresh();
  const res = await call(db, '/api/creators/signup', {
    method: 'POST',
    cookie: 'twwinz_session=sess_owner',
    body: { name: 'Owner', email: 'other@example.com' }
  });
  assert.equal(res.status, 403);
  assert.equal(db.creators.find((c) => c.id === 'clb_other').name, 'Other');
});

test('style scrape blocks local and metadata addresses', async () => {
  const db = fresh();
  const res = await call(db, '/api/utils/scrape-styles', {
    method: 'POST',
    cookie: 'twwinz_session=sess_owner',
    body: { url: 'http://169.254.169.254/latest/meta-data' }
  });
  assert.equal(res.status, 400);
});

test('oauth state cookie is HttpOnly, Secure on https, and SameSite=Lax', async () => {
  const db = fresh();
  const res = await worker.fetch(new Request('https://www.twwinz.com/api/auth/google?redirect=/dashboard.html'), envFor(db));
  const cookie = res.headers.get('set-cookie');
  assert.equal(res.status, 302);
  assert.match(cookie, /twwinz_oauth_state=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /SameSite=None/);

  const local = await worker.fetch(new Request('http://127.0.0.1:8787/api/auth/google?redirect=/onboard.html'), envFor(db));
  const localCookie = local.headers.get('set-cookie');
  assert.match(localCookie, /HttpOnly/);
  assert.match(localCookie, /SameSite=Lax/);
  assert.doesNotMatch(localCookie, /Secure/);
});

test('oauth callback rejects a missing, forged, or mismatched state', async () => {
  const db = fresh();
  const missing = await worker.fetch(new Request('https://www.twwinz.com/api/auth/google/callback?code=abc'), envFor(db));
  assert.match(missing.headers.get('location'), /auth_error=invalid_state/);

  const forgedState = btoa(JSON.stringify({ nonce: 'forged', redirect: '/dashboard.html' }));
  const forged = await worker.fetch(new Request(`https://www.twwinz.com/api/auth/google/callback?code=abc&state=${encodeURIComponent(forgedState)}`), envFor(db));
  assert.match(forged.headers.get('location'), /auth_error=invalid_state/);

  const mismatched = await worker.fetch(new Request(`https://www.twwinz.com/api/auth/google/callback?code=abc&state=${encodeURIComponent(forgedState)}`, {
    headers: { Cookie: 'twwinz_oauth_state=different-nonce' }
  }), envFor(db));
  assert.match(mismatched.headers.get('location'), /auth_error=invalid_state/);
});

test('oauth redirect target cannot leave the site', async () => {
  const db = fresh();
  const res = await worker.fetch(new Request('https://www.twwinz.com/api/auth/google?redirect=//evil.example/phish'), envFor(db));
  const state = new URL(res.headers.get('location')).searchParams.get('state');
  const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  assert.equal(parsed.redirect, '');

  const ok = await worker.fetch(new Request('https://www.twwinz.com/api/auth/google?redirect=/settings.html'), envFor(db));
  const okState = new URL(ok.headers.get('location')).searchParams.get('state');
  const okParsed = JSON.parse(Buffer.from(okState, 'base64').toString('utf8'));
  assert.equal(okParsed.redirect, '/settings.html');
});

test('public chat preview is rate limited per creator and does not require a session', async () => {
  const db = fresh();
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await call(db, '/api/chat/preview', {
      method: 'POST',
      ip: '203.0.113.10',
      body: { creatorId: 'clb_other', query: 'hello' }
    });
    assert.equal(last.status, 200, last.text);
    assert.equal(JSON.stringify(last.json).includes('other-secret'), false);
  }
  const blocked = await call(db, '/api/chat/preview', {
    method: 'POST',
    ip: '203.0.113.10',
    body: { creatorId: 'clb_other', query: 'hello again' }
  });
  assert.equal(blocked.status, 429);
});

test('webhook rejects a bad secret and does not rebind a location without one', async () => {
  const db = fresh();
  const owner = db.creators.find((c) => c.id === 'clb_owner');
  const denied = await call(db, '/api/chat/ghl-webhook?creatorId=clb_owner', {
    method: 'POST',
    ip: '203.0.113.20',
    extraEnv: { GHL_WEBHOOK_SECRET: 'whsec' },
    body: { message: 'hi', locationId: 'loc_attacker' }
  });
  assert.equal(denied.status, 401);
  assert.equal(owner.ghl_location_id, 'loc_ghl_owner');

  const unsigned = await call(db, '/api/chat/ghl-webhook?creatorId=clb_owner', {
    method: 'POST',
    ip: '203.0.113.21',
    body: { message: 'hi', locationId: 'loc_attacker' }
  });
  assert.equal(unsigned.status, 200);
  assert.equal(owner.ghl_location_id, 'loc_ghl_owner');

  const signed = await call(db, '/api/chat/ghl-webhook?creatorId=clb_owner&token=whsec', {
    method: 'POST',
    ip: '203.0.113.22',
    extraEnv: { GHL_WEBHOOK_SECRET: 'whsec' },
    body: { message: 'hi', locationId: 'loc_real' }
  });
  assert.equal(signed.status, 200, signed.text);
  assert.equal(owner.ghl_location_id, 'loc_real');
});

test('hosted twin page at /<slug> renders public card and chat widget without exposing private fields', async () => {
  const db = fresh();
  const page = await call(db, '/other');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /Other/);
  assert.match(page.text, /Regional Athlete/);
  assert.match(page.text, /Hello other/);
  assert.match(page.text, /widget\.js/);
  assert.match(page.text, /property="og:title"/);
  assert.match(page.text, /favicon\.svg/);
  // Must never leak private fields or raw knowledge items on the public page
  assert.equal(page.text.includes('other@example.com'), false);
  assert.equal(page.text.includes('other-secret'), false);
  assert.equal(page.text.includes('secret persona'), false);
  assert.equal(page.text.includes('loc_real_other'), false);
  assert.equal(page.text.includes('Private photo'), false);
});

test('uploaded photos are stored in R2 instead of D1 data URIs and served via signed URLs', async () => {
  const db = fresh();
  const cookie = 'twwinz_session=sess_owner';
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const created = await call(db, '/api/creators/clb_owner/knowledge', {
    method: 'POST',
    cookie,
    body: {
      category: 'photo',
      title: 'GalaxyCon Booth Photo',
      content: 'Photo of my booth #412 signed poster table.',
      metadata: { image_url: tinyPng, file_name: 'booth.png' }
    }
  });
  assert.equal(created.status, 201);

  // Verify D1 row does NOT contain data:image/ URI
  const storedRow = db.knowledge.find((k) => k.id === created.json.id);
  assert.ok(storedRow);
  assert.equal(String(storedRow.metadata).includes('data:image/'), false);
  const storedMeta = JSON.parse(storedRow.metadata);
  assert.ok(storedMeta.r2_key.startsWith('creators/clb_owner/'));
  assert.ok(storedMeta.image_url.startsWith('/api/media/creators/clb_owner/'));

  // Anonymous request to raw /api/media/<key> without signature is rejected
  const unsigned = await call(db, `/api/media/${storedMeta.r2_key}`);
  assert.equal(unsigned.status, 401);

  // Signed URL returned in knowledge read works for anonymous fan chat rendering
  const list = await call(db, '/api/creators/clb_owner/knowledge', { cookie });
  assert.equal(list.status, 200);
  const item = list.json.find((k) => k.id === created.json.id);
  const signedMeta = JSON.parse(item.metadata);
  assert.match(signedMeta.image_url, /exp=\d+&sig=[a-f0-9]+/);

  const signedFetch = await call(db, signedMeta.image_url);
  assert.equal(signedFetch.status, 200);
  assert.equal(signedFetch.headers.get('content-type'), 'image/png');
});

test('one-time migration moves legacy data-URI images in D1 to R2', async () => {
  const db = fresh();
  // Before migration, k_other has a data:image/png;base64 URI in content
  const before = db.knowledge.find((k) => k.id === 'k_other');
  assert.equal(before.content.startsWith('data:image/png;base64,'), true);

  const res = await call(db, '/api/admin/migrate-images', {
    method: 'POST',
    cookie: 'twwinz_session=sess_owner'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.migratedCount, 1);

  const after = db.knowledge.find((k) => k.id === 'k_other');
  assert.equal(after.content.includes('data:image/'), false);
  const meta = JSON.parse(after.metadata);
  assert.ok(meta.r2_key.startsWith('creators/clb_other/'));
  assert.equal(String(after.metadata).includes('data:image/'), false);
});

test('dynamic sitemap includes public pages and hosted twin pages', async () => {
  const db = fresh();
  const res = await call(db, '/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  assert.match(res.text, /https:\/\/twwinz\.com\/jaxson-reed/);
  assert.match(res.text, /https:\/\/twwinz\.com\/owner/);
  assert.match(res.text, /https:\/\/twwinz\.com\/terms-of-service\.html/);
});

test('HighLevel OAuth start requires owned session, stores state, and redirects to marketplace chooselocation', async () => {
  const db = fresh();
  const anon = await call(db, '/api/oauth/ghl/start?creatorId=clb_owner');
  assert.equal(anon.status, 401);

  const wrongOwner = await call(db, '/api/oauth/ghl/start?creatorId=clb_other', {
    cookie: 'twwinz_session=sess_owner'
  });
  assert.equal(wrongOwner.status, 403);

  const started = await call(db, '/api/oauth/ghl/start?creatorId=clb_owner', {
    cookie: 'twwinz_session=sess_owner',
    extraEnv: { GHL_CLIENT_ID: 'ghl_cid_123', GHL_CLIENT_SECRET: 'ghl_csec_456' }
  });
  assert.equal(started.status, 302);
  const loc = new URL(started.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://marketplace.gohighlevel.com/oauth/chooselocation');
  assert.equal(loc.searchParams.get('client_id'), 'ghl_cid_123');
  assert.match(loc.searchParams.get('scope'), /contacts\.write/);
  const state = loc.searchParams.get('state');
  assert.ok(state && db.ghlStates.has(state));

  // Forged state is rejected on callback
  const forged = await call(db, '/api/oauth/ghl/callback?code=authcode&state=forged_state', {
    cookie: 'twwinz_session=sess_owner',
    extraEnv: { GHL_CLIENT_ID: 'ghl_cid_123', GHL_CLIENT_SECRET: 'ghl_csec_456' }
  });
  assert.equal(forged.status, 400);
});

test('HighLevel OAuth tokens are encrypted at rest, auto-refresh when expiring, and never leak via status API', async () => {
  const db = fresh();
  const env = envFor(db, {
    GHL_CLIENT_ID: 'ghl_cid_123',
    GHL_CLIENT_SECRET: 'ghl_csec_456',
    GHL_TOKEN_ENCRYPTION_KEY: 'super-secret-master-key'
  });

  // Save an OAuth connection that is already within the 5-minute refresh window
  await saveGhlOAuthConnection(db, env, {
    creatorId: 'clb_owner',
    locationId: 'u9mGpfcXyODjTryMJfIW',
    companyId: 'ycxGZPk2GALkmii5NPkO',
    userType: 'Location',
    scope: 'contacts.write conversations.write',
    accessToken: 'raw_access_token_initial',
    refreshToken: 'raw_refresh_token_initial',
    expiresIn: 60, // 60s (< 5 min buffer, triggers auto-refresh)
    connectedByEmail: 'owner@example.com'
  });

  // Verify encrypted storage in D1 (never plaintext)
  const stored = db.ghlConnections.get('clb_owner');
  assert.ok(stored);
  assert.equal(stored.access_token_enc.startsWith('v1:'), true);
  assert.equal(stored.access_token_enc.includes('raw_access_token_initial'), false);
  assert.equal(stored.refresh_token_enc.includes('raw_refresh_token_initial'), false);
  assert.equal(await decryptSecret(stored.access_token_enc, env), 'raw_access_token_initial');

  // Verify status endpoint never exposes access_token or refresh_token
  const statusRes = await call(db, '/api/creators/clb_owner/ghl-connection', {
    cookie: 'twwinz_session=sess_owner',
    extraEnv: env
  });
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.oauthConnected, true);
  assert.equal(statusRes.json.locationId, 'u9mGpfcXyODjTryMJfIW');
  assert.equal(JSON.stringify(statusRes.json).includes('raw_access_token'), false);
  assert.equal(JSON.stringify(statusRes.json).includes('raw_refresh_token'), false);

  // Verify automatic token refresh when resolving credentials
  let refreshCalled = false;
  const fakeFetch = async (url, init) => {
    refreshCalled = true;
    assert.equal(url, 'https://services.leadconnectorhq.com/oauth/token');
    assert.match(init.body, /grant_type=refresh_token/);
    assert.match(init.body, /refresh_token=raw_refresh_token_initial/);
    return new Response(JSON.stringify({
      access_token: 'rotated_access_token_new',
      refresh_token: 'rotated_refresh_token_new',
      expires_in: 86400,
      locationId: 'u9mGpfcXyODjTryMJfIW'
    }), { status: 200 });
  };

  const owner = db.creators.find((c) => c.id === 'clb_owner');
  const creds = await resolveCreatorGhlCredentials(db, env, owner, fakeFetch);
  assert.equal(refreshCalled, true);
  assert.equal(creds.authMethod, 'oauth');
  assert.equal(creds.token, 'rotated_access_token_new');
  assert.equal(creds.locationId, 'u9mGpfcXyODjTryMJfIW');

  // Disconnect OAuth and verify fallback to existing Private Integration token (owner-secret)
  const disc = await call(db, '/api/creators/clb_owner/ghl-disconnect', {
    method: 'POST',
    cookie: 'twwinz_session=sess_owner',
    extraEnv: env,
    body: {}
  });
  assert.equal(disc.status, 200);
  assert.equal(disc.json.oauthConnected, false);
  assert.equal(disc.json.privateTokenConfigured, true);

  const fallbackCreds = await resolveCreatorGhlCredentials(db, env, owner);
  assert.equal(fallbackCreds.authMethod, 'private_token');
  assert.equal(fallbackCreds.token, 'owner-secret');
});

test('contact creation is strictly scoped to the creator sub-account locationId and prevents cross-location writes', async () => {
  const db = fresh();
  // clb_owner currently has placeholder loc_ghl_owner -> contact creation is rejected until a real locationId is bound
  const unlinked = await call(db, '/api/creators/clb_owner/contacts', {
    method: 'POST',
    body: { name: 'Fan One', email: 'fan1@example.com' }
  });
  assert.equal(unlinked.status, 400);

  // Bind clb_owner to real location u9mGpfcXyODjTryMJfIW (and no agency key in env so upsert runs in safe simulation mode)
  const owner = db.creators.find((c) => c.id === 'clb_owner');
  owner.ghl_location_id = 'u9mGpfcXyODjTryMJfIW';
  owner.ghl_api_key = '';

  const linked = await call(db, '/api/creators/clb_owner/contacts', {
    method: 'POST',
    body: { name: 'Fan One', email: 'fan1@example.com' }
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.json.locationId, 'u9mGpfcXyODjTryMJfIW');

  // Prevent another creator from binding the same HighLevel locationId
  await assert.rejects(
    () => saveGhlOAuthConnection(db, envFor(db), {
      creatorId: 'clb_other',
      locationId: 'u9mGpfcXyODjTryMJfIW',
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600
    }),
    /already linked to another Twwinz creator/
  );
});

test('email + password registration and login work for alias emails and provision creator sub-account login', async () => {
  const db = fresh();
  const reg = await call(db, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Kevin Mobilized',
      email: 'kevin@mobilizedentertainment.com',
      password: 'MyStrongPassword#2026'
    }
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.authenticated, true);
  const setCookie = reg.headers.get('set-cookie');
  assert.match(setCookie, /twwinz_session=sess_/);
  const sessionCookie = setCookie.split(';')[0];

  // Duplicate registration returns 409
  const dup = await call(db, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Kevin Mobilized',
      email: 'kevin@mobilizedentertainment.com',
      password: 'MyStrongPassword#2026'
    }
  });
  assert.equal(dup.status, 409);

  // Wrong password login returns 401
  const badLogin = await call(db, '/api/auth/login', {
    method: 'POST',
    body: {
      email: 'kevin@mobilizedentertainment.com',
      password: 'WrongPassword123!'
    }
  });
  assert.equal(badLogin.status, 401);

  // Valid login returns 200 and session cookie
  const goodLogin = await call(db, '/api/auth/login', {
    method: 'POST',
    body: {
      email: 'kevin@mobilizedentertainment.com',
      password: 'MyStrongPassword#2026'
    }
  });
  assert.equal(goodLogin.status, 200);
  assert.equal(goodLogin.json.authenticated, true);

  // Complete creator signup using the email+password session
  const signup = await call(db, '/api/creators/signup', {
    method: 'POST',
    cookie: sessionCookie,
    body: {
      name: 'Kevin Mobilized',
      email: 'kevin@mobilizedentertainment.com',
      websiteType: 'ghl_hosted'
    }
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.json.creator.email, 'kevin@mobilizedentertainment.com');

  // Verify the GHL sub-account user was provisioned with the same password
  const ghlConn = await call(db, `/api/creators/${signup.json.creator.id}/ghl-connection`, {
    cookie: sessionCookie
  });
  assert.equal(ghlConn.status, 200);
  assert.equal(ghlConn.json.subaccountLogin.email, 'kevin@mobilizedentertainment.com');
  assert.equal(ghlConn.json.subaccountLogin.initialPassword, 'MyStrongPassword#2026');
});
