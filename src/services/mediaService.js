/**
 * Cloudflare R2 Media Storage & Signed URL Service
 * Stores creator-uploaded photos in R2 (`MEDIA_BUCKET`) instead of D1 data URIs,
 * serves them via HMAC-signed or session-authenticated URLs (`/api/media/...`),
 * and provides a one-time migration helper for legacy data-URI images in D1.
 */

const FALLBACK_MEMORY_BUCKET = new Map();

export function getMediaBucket(env) {
  if (env && env.MEDIA_BUCKET && typeof env.MEDIA_BUCKET.put === 'function') {
    return env.MEDIA_BUCKET;
  }
  return {
    async put(key, bytes, options = {}) {
      const copy = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new TextEncoder().encode(String(bytes));
      FALLBACK_MEMORY_BUCKET.set(key, {
        body: copy,
        httpMetadata: options.httpMetadata || { contentType: 'image/jpeg' },
        customMetadata: options.customMetadata || {},
        size: copy.byteLength,
        uploaded: new Date()
      });
      return { key, size: copy.byteLength };
    },
    async get(key) {
      const entry = FALLBACK_MEMORY_BUCKET.get(key);
      if (!entry) return null;
      return {
        body: entry.body,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
        size: entry.size,
        async arrayBuffer() {
          return entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength);
        }
      };
    },
    async delete(key) {
      FALLBACK_MEMORY_BUCKET.delete(key);
    }
  };
}

export function isDataUriImage(value) {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+/i.test(value.trim());
}

export function parseDataUriImage(dataUri) {
  if (!isDataUriImage(dataUri)) return null;
  const trimmed = dataUri.trim();
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return null;

  const header = trimmed.slice(0, commaIdx);
  const payload = trimmed.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?$/i);
  if (!mimeMatch) return null;

  const contentType = mimeMatch[1].toLowerCase();
  const isBase64 = Boolean(mimeMatch[2]);

  let bytes;
  try {
    if (isBase64) {
      const cleanB64 = payload.replace(/\s+/g, '');
      const binStr = atob(cleanB64);
      bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch (_) {
    return null;
  }

  let ext = 'jpg';
  if (contentType.includes('png')) ext = 'png';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('gif')) ext = 'gif';

  return { contentType, ext, bytes };
}

export async function uploadImageToR2(env, { creatorId, itemId, dataUri, fileName }) {
  const parsed = parseDataUriImage(dataUri);
  if (!parsed) {
    throw new Error('Invalid image data URI');
  }
  if (parsed.bytes.byteLength > 5 * 1024 * 1024) {
    throw new Error('Image exceeds maximum size of 5MB');
  }

  const safeCreator = String(creatorId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeItem = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const r2Key = `creators/${safeCreator}/${safeItem}.${parsed.ext}`;

  const bucket = getMediaBucket(env);
  await bucket.put(r2Key, parsed.bytes, {
    httpMetadata: { contentType: parsed.contentType },
    customMetadata: {
      creatorId: String(creatorId),
      itemId: String(itemId),
      fileName: String(fileName || `${safeItem}.${parsed.ext}`)
    }
  });

  return {
    r2_key: r2Key,
    image_url: `/api/media/${r2Key}`,
    content_type: parsed.contentType,
    size_bytes: parsed.bytes.byteLength,
    file_name: fileName || `${safeItem}.${parsed.ext}`
  };
}

function getSigningSecret(env) {
  return (env && (env.MEDIA_SIGNING_SECRET || env.GOOGLE_CLIENT_SECRET || env.GHL_WEBHOOK_SECRET)) || 'twwinz-r2-media-signing-key';
}

async function computeHmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function extractR2Key(r2KeyOrUrl) {
  if (!r2KeyOrUrl || typeof r2KeyOrUrl !== 'string') return null;
  const trimmed = r2KeyOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return null;
  const withoutQuery = trimmed.split('?')[0];
  if (withoutQuery.startsWith('/api/media/')) {
    return withoutQuery.slice('/api/media/'.length);
  }
  if (withoutQuery.startsWith('creators/')) {
    return withoutQuery;
  }
  return null;
}

export async function signMediaUrl(r2KeyOrUrl, env, ttlSeconds = 3600) {
  if (!r2KeyOrUrl || typeof r2KeyOrUrl !== 'string') return null;
  const r2Key = extractR2Key(r2KeyOrUrl);
  if (!r2Key) return r2KeyOrUrl;

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await computeHmacHex(getSigningSecret(env), `${r2Key}:${exp}`);
  return `/api/media/${r2Key}?exp=${exp}&sig=${sig}`;
}

export async function verifyMediaSignature(r2Key, expParam, sigParam, env) {
  if (!r2Key || !expParam || !sigParam) return false;
  const exp = Number(expParam);
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) {
    return false;
  }
  const expected = await computeHmacHex(getSigningSecret(env), `${r2Key}:${exp}`);
  if (expected.length !== String(sigParam).length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ String(sigParam).charCodeAt(i);
  }
  return diff === 0;
}

export async function signKnowledgeItemsMedia(items, env) {
  if (!Array.isArray(items)) return [];
  return Promise.all(items.map(async (item) => {
    if (!item || !item.metadata) return item;
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : { ...item.metadata };
      const keyOrUrl = meta.r2_key || meta.image_url;
      if (keyOrUrl && extractR2Key(keyOrUrl)) {
        meta.image_url = await signMediaUrl(keyOrUrl, env);
        return {
          ...item,
          metadata: typeof item.metadata === 'string' ? JSON.stringify(meta) : meta
        };
      }
    } catch (_) {}
    return item;
  }));
}

/**
 * One-time migration: finds any `knowledge_items` storing a raw `data:image/...` URI
 * in `metadata` or `content`, uploads the image binary to R2 (`MEDIA_BUCKET`),
 * and updates the D1 row to store only the R2 key/URL and metadata.
 */
export async function migrateDataUriImages(db, env) {
  const { results: rows } = await db.prepare(
    'SELECT id, creator_id, category, title, content, metadata FROM knowledge_items WHERE is_active = 1'
  ).all();

  const migratedIds = [];
  for (const row of rows || []) {
    let metaObj = null;
    if (row.metadata) {
      try {
        metaObj = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : { ...row.metadata };
      } catch (_) {
        metaObj = {};
      }
    }

    const metaDataUri = metaObj && isDataUriImage(metaObj.image_url) ? metaObj.image_url : null;
    const contentDataUri = isDataUriImage(row.content) ? row.content : null;
    const dataUriToMigrate = metaDataUri || contentDataUri;

    if (!dataUriToMigrate) continue;

    const uploaded = await uploadImageToR2(env, {
      creatorId: row.creator_id,
      itemId: row.id,
      dataUri: dataUriToMigrate,
      fileName: (metaObj && metaObj.file_name) || `${row.id}.jpg`
    });

    const updatedMeta = {
      ...(metaObj || {}),
      r2_key: uploaded.r2_key,
      image_url: uploaded.image_url,
      content_type: uploaded.content_type,
      size_bytes: uploaded.size_bytes,
      file_name: uploaded.file_name,
      migrated_at: new Date().toISOString()
    };

    const updatedContent = contentDataUri
      ? (row.title || 'Official uploaded photo')
      : row.content;

    await db.prepare(
      'UPDATE knowledge_items SET metadata = ?, content = ? WHERE id = ?'
    ).bind(JSON.stringify(updatedMeta), updatedContent, row.id).run();

    migratedIds.push({ id: row.id, creator_id: row.creator_id, r2_key: uploaded.r2_key });
  }

  return {
    migratedCount: migratedIds.length,
    migrated: migratedIds
  };
}

