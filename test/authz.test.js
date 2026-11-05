import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const FUTURE = '2099-01-01T00:00:00.000Z';

function createDb() {
  const creators = [];
  const knowledge = [];
  const sessions = [];
  const rates = new Map();

  function execute(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE TABLE')) return {};
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
    if (text.includes('FROM knowledge_items WHERE id = ?')) {
      return { first: knowledge.find((k) => k.id === params[0]) || null };
    }
    if (text.includes('FROM knowledge_items WHERE creator_id = ?')) {
      let rows = knowledge.filter((k) => k.creator_id === params[0] && k.is_active === 1);
      if (text.includes('AND category = ?')) rows = rows.filter((k) => k.category === params[1]);
      return { rows };
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
    { id: 'k_other', creator_id: 'clb_other', category: 'photo', title: 'Private photo', content: 'data:image/png;base64,SECRET', is_active: 1, priority: 1 }
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
