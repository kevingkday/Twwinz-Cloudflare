/**
 * HighLevel (LeadConnector) OAuth 2.0 & Encrypted Token Management Service
 *
 * Implements:
 * - Authorization Code flow with CSRF state validation
 * - AES-GCM 256-bit encryption at rest for access_token, refresh_token, and initial sub-account password
 * - Automatic token refresh when access_token is expired or within 5 minutes of expiry
 * - Strict Location-level (Sub-Account) isolation and fallback to existing Private Integration tokens
 */

const GHL_OAUTH_CHOOSE_LOCATION_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation';
const GHL_OAUTH_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

export const DEFAULT_GHL_OAUTH_SCOPES = [
  'chat-widget.readonly',
  'chat-widget.write',
  'contacts.readonly',
  'contacts.write',
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'locations.readonly'
];

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiration

export async function ensureGhlOAuthTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ghl_oauth_states (
      state TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      redirect_after TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ghl_oauth_connections (
      creator_id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      company_id TEXT,
      user_type TEXT DEFAULT 'Location',
      scope TEXT,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at INTEGER,
      connected_by_email TEXT,
      subaccount_user_id TEXT,
      subaccount_login_email TEXT,
      subaccount_temp_password_enc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

/**
 * Derive a 256-bit AES-GCM CryptoKey from server-only secret material.
 */
async function getEncryptionKey(env = {}) {
  const secretMaterial =
    env.GHL_TOKEN_ENCRYPTION_KEY ||
    env.GHL_CLIENT_SECRET ||
    env.GOOGLE_CLIENT_SECRET ||
    'twwinz-default-dev-encryption-secret-do-not-expose';

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(secretMaterial)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptSecret(plainText, env = {}) {
  if (!plainText) return null;
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plainText));
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

export async function decryptSecret(cipherText, env = {}) {
  if (!cipherText) return null;
  const str = String(cipherText);
  if (!str.startsWith('v1:')) {
    return null;
  }
  const parts = str.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = await getEncryptionKey(env);
    const iv = base64ToBytes(parts[1]);
    const data = base64ToBytes(parts[2]);
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plainBuffer);
  } catch (_) {
    return null;
  }
}

export function isGhlOAuthConfigured(env = {}) {
  return Boolean(env.GHL_CLIENT_ID && env.GHL_CLIENT_SECRET);
}

export function getGhlOAuthRedirectUri(requestUrl, env = {}) {
  if (env.GHL_OAUTH_REDIRECT_URI) {
    return env.GHL_OAUTH_REDIRECT_URI;
  }
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase() === 'www.twwinz.com' ? 'twwinz.com' : url.host;
  return `${url.protocol}//${host}/api/oauth/ghl/callback`;
}

export async function createGhlOAuthState(db, { creatorId, userEmail, redirectAfter }) {
  await ensureGhlOAuthTables(db);
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO ghl_oauth_states (state, creator_id, user_email, redirect_after, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(state, creatorId, userEmail, redirectAfter || null, expiresAt).run();

  return state;
}

export async function consumeGhlOAuthState(db, state) {
  if (!state) return null;
  await ensureGhlOAuthTables(db);
  const row = await db.prepare('SELECT * FROM ghl_oauth_states WHERE state = ?').bind(state).first();
  await db.prepare('DELETE FROM ghl_oauth_states WHERE state = ?').bind(state).run();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  return row;
}

export function buildGhlAuthorizationUrl({ clientId, redirectUri, state, scopes = DEFAULT_GHL_OAUTH_SCOPES }) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    client_id: clientId,
    scope: scopes.join(' '),
    state
  });
  return `${GHL_OAUTH_CHOOSE_LOCATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for HighLevel Location access_token & refresh_token.
 */
export async function exchangeGhlCodeForTokens({ code, redirectUri, env, fetchImpl = fetch }) {
  if (!isGhlOAuthConfigured(env)) {
    throw new Error('HighLevel OAuth is not configured (GHL_CLIENT_ID / GHL_CLIENT_SECRET missing)');
  }

  const formBody = new URLSearchParams({
    client_id: env.GHL_CLIENT_ID,
    client_secret: env.GHL_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    user_type: 'Location',
    redirect_uri: redirectUri
  });

  const res = await fetchImpl(GHL_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: formBody.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token || !data.refresh_token) {
    const errMsg = data.error_description || data.error || data.message || `HTTP ${res.status}`;
    throw new Error(`HighLevel token exchange failed: ${errMsg}`);
  }

  if (!data.locationId) {
    throw new Error('HighLevel authorization did not include a Sub-Account locationId. Please select a Sub-Account (not an Agency view) when authorizing.');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 86399,
    locationId: data.locationId,
    companyId: data.companyId || null,
    userType: data.userType || 'Location',
    scope: data.scope || DEFAULT_GHL_OAUTH_SCOPES.join(' ')
  };
}

/**
 * Save encrypted HighLevel OAuth tokens in D1 and bind to creator_id + location_id.
 */
export async function saveGhlOAuthConnection(db, env, {
  creatorId,
  locationId,
  companyId,
  userType,
  scope,
  accessToken,
  refreshToken,
  expiresIn,
  connectedByEmail
}) {
  await ensureGhlOAuthTables(db);

  // Prevent another creator from binding the exact same non-placeholder locationId
  const conflictingCreator = await db.prepare(
    'SELECT id FROM creators WHERE ghl_location_id = ? AND id != ?'
  ).bind(locationId, creatorId).first();
  if (conflictingCreator) {
    throw new Error('This HighLevel sub-account is already linked to another Twwinz creator profile.');
  }

  const accessTokenEnc = await encryptSecret(accessToken, env);
  const refreshTokenEnc = await encryptSecret(refreshToken, env);
  const expiresAt = Date.now() + (Number(expiresIn) || 86399) * 1000;

  const existing = await db.prepare(
    'SELECT subaccount_user_id, subaccount_login_email, subaccount_temp_password_enc FROM ghl_oauth_connections WHERE creator_id = ?'
  ).bind(creatorId).first();

  await db.prepare(`
    INSERT OR REPLACE INTO ghl_oauth_connections (
      creator_id, location_id, company_id, user_type, scope,
      access_token_enc, refresh_token_enc, expires_at, connected_by_email,
      subaccount_user_id, subaccount_login_email, subaccount_temp_password_enc,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    creatorId,
    locationId,
    companyId || null,
    userType || 'Location',
    scope || '',
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt,
    connectedByEmail || null,
    existing?.subaccount_user_id || null,
    existing?.subaccount_login_email || null,
    existing?.subaccount_temp_password_enc || null
  ).run();

  await db.prepare('UPDATE creators SET ghl_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(locationId, creatorId)
    .run();
}

/**
 * Store provisioned sub-account login credentials (created at signup) so the user can sign in to GHL to authorize OAuth.
 */
export async function saveProvisionedSubAccountUser(db, env, {
  creatorId,
  locationId,
  userId,
  loginEmail,
  tempPassword
}) {
  await ensureGhlOAuthTables(db);
  const tempPasswordEnc = tempPassword ? await encryptSecret(tempPassword, env) : null;
  const existing = await db.prepare('SELECT * FROM ghl_oauth_connections WHERE creator_id = ?').bind(creatorId).first();

  if (existing) {
    await db.prepare(`
      UPDATE ghl_oauth_connections
      SET location_id = COALESCE(?, location_id),
          subaccount_user_id = COALESCE(?, subaccount_user_id),
          subaccount_login_email = COALESCE(?, subaccount_login_email),
          subaccount_temp_password_enc = COALESCE(?, subaccount_temp_password_enc),
          updated_at = CURRENT_TIMESTAMP
      WHERE creator_id = ?
    `).bind(locationId, userId || null, loginEmail || null, tempPasswordEnc, creatorId).run();
  } else {
    await db.prepare(`
      INSERT INTO ghl_oauth_connections (
        creator_id, location_id, subaccount_user_id, subaccount_login_email, subaccount_temp_password_enc
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(creatorId, locationId || '', userId || null, loginEmail || null, tempPasswordEnc).run();
  }
}

/**
 * Refresh an expired (or expiring) HighLevel OAuth access token using the stored refresh_token.
 */
export async function refreshGhlOAuthToken(db, env, creatorId, fetchImpl = fetch) {
  await ensureGhlOAuthTables(db);
  const row = await db.prepare('SELECT * FROM ghl_oauth_connections WHERE creator_id = ?').bind(creatorId).first();
  if (!row || !row.refresh_token_enc) {
    return null;
  }

  const refreshToken = await decryptSecret(row.refresh_token_enc, env);
  if (!refreshToken || !isGhlOAuthConfigured(env)) {
    return null;
  }

  const formBody = new URLSearchParams({
    client_id: env.GHL_CLIENT_ID,
    client_secret: env.GHL_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: row.user_type || 'Location'
  });

  const res = await fetchImpl(GHL_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: formBody.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.warn('[GHL OAuth Refresh Failed]', res.status, data.error || data.message || '');
    return null;
  }

  const newAccessEnc = await encryptSecret(data.access_token, env);
  const newRefreshEnc = await encryptSecret(data.refresh_token || refreshToken, env);
  const newExpiresAt = Date.now() + (Number(data.expires_in) || 86399) * 1000;
  const resolvedLocationId = data.locationId || row.location_id;

  await db.prepare(`
    UPDATE ghl_oauth_connections
    SET access_token_enc = ?,
        refresh_token_enc = ?,
        expires_at = ?,
        location_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE creator_id = ?
  `).bind(newAccessEnc, newRefreshEnc, newExpiresAt, resolvedLocationId, creatorId).run();

  return {
    accessToken: data.access_token,
    locationId: resolvedLocationId,
    expiresAt: newExpiresAt
  };
}

/**
 * Resolve a valid HighLevel bearer token and locationId for a creator.
 * Priority:
 * 1. Active OAuth 2.0 connection (auto-refreshes if within 5 min of expiry)
 * 2. Creator's existing Private Integration token (creator.ghl_api_key)
 * 3. Agency API key fallback (env.GHL_AGENCY_API_KEY)
 */
export async function resolveCreatorGhlCredentials(db, env, creator, fetchImpl = fetch) {
  if (!creator) {
    return { token: null, locationId: null, authMethod: 'none' };
  }

  await ensureGhlOAuthTables(db);
  const row = await db.prepare('SELECT * FROM ghl_oauth_connections WHERE creator_id = ?').bind(creator.id).first();

  if (row && row.access_token_enc) {
    const needsRefresh = !row.expires_at || Date.now() >= Number(row.expires_at) - REFRESH_BUFFER_MS;
    if (needsRefresh) {
      const refreshed = await refreshGhlOAuthToken(db, env, creator.id, fetchImpl);
      if (refreshed && refreshed.accessToken) {
        return {
          token: refreshed.accessToken,
          locationId: refreshed.locationId || creator.ghl_location_id,
          authMethod: 'oauth'
        };
      }
    } else {
      const accessToken = await decryptSecret(row.access_token_enc, env);
      if (accessToken) {
        return {
          token: accessToken,
          locationId: row.location_id || creator.ghl_location_id,
          authMethod: 'oauth'
        };
      }
    }
  }

  if (creator.ghl_api_key) {
    return {
      token: creator.ghl_api_key,
      locationId: creator.ghl_location_id || row?.location_id || null,
      authMethod: 'private_token'
    };
  }

  if (env?.GHL_AGENCY_API_KEY) {
    return {
      token: env.GHL_AGENCY_API_KEY,
      locationId: creator.ghl_location_id || row?.location_id || null,
      authMethod: 'agency_key'
    };
  }

  return {
    token: null,
    locationId: creator.ghl_location_id || row?.location_id || null,
    authMethod: 'none'
  };
}

/**
 * Return safe, non-sensitive OAuth status for the Settings UI.
 */
export async function getGhlConnectionStatus(db, env, creator) {
  await ensureGhlOAuthTables(db);
  const row = await db.prepare('SELECT * FROM ghl_oauth_connections WHERE creator_id = ?').bind(creator.id).first();

  const hasOAuth = Boolean(row && row.access_token_enc);
  const hasPrivateToken = Boolean(creator.ghl_api_key);
  const locationId = (row && row.location_id) || creator.ghl_location_id || null;
  const isPlaceholderLocation = !locationId || String(locationId).startsWith('loc_');

  let initialPassword = null;
  if (row && row.subaccount_temp_password_enc) {
    initialPassword = await decryptSecret(row.subaccount_temp_password_enc, env);
  }

  return {
    oauthConfigured: isGhlOAuthConfigured(env),
    connected: hasOAuth || hasPrivateToken,
    oauthConnected: hasOAuth,
    privateTokenConfigured: hasPrivateToken,
    authMethod: hasOAuth ? 'oauth' : (hasPrivateToken ? 'private_token' : 'none'),
    locationId,
    isRealLocation: !isPlaceholderLocation,
    widgetId: creator.ghl_widget_id || null,
    scope: row?.scope || null,
    expiresAt: row?.expires_at || null,
    connectedByEmail: row?.connected_by_email || null,
    subaccountLogin: {
      email: row?.subaccount_login_email || creator.email || null,
      initialPassword,
      userCreated: Boolean(row?.subaccount_user_id || initialPassword),
      loginUrl: 'https://app.gohighlevel.com/'
    }
  };
}

/**
 * Disconnect OAuth tokens for a creator.
 */
export async function disconnectGhlOAuth(db, creatorId, { clearPrivateToken = false } = {}) {
  await ensureGhlOAuthTables(db);
  await db.prepare(`
    UPDATE ghl_oauth_connections
    SET access_token_enc = NULL,
        refresh_token_enc = NULL,
        expires_at = NULL,
        scope = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE creator_id = ?
  `).bind(creatorId).run();

  if (clearPrivateToken) {
    await db.prepare('UPDATE creators SET ghl_api_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(creatorId)
      .run();
  }
}

