#!/usr/bin/env node
/**
 * One-Time Migration Script: Move legacy Data-URI images from D1 `knowledge_items` into Cloudflare R2.
 *
 * Usage:
 *   # Against production / deployed Worker (using your session cookie or admin token):
 *   TWWINZ_SESSION="sess_..." node scripts/migrate-images-to-r2.js https://www.twwinz.com
 *
 *   # Or invoke `migrateDataUriImages(db, env)` directly inside Worker / tests.
 */

const baseUrl = (process.argv[2] || process.env.TWWINZ_URL || 'https://www.twwinz.com').replace(/\/$/, '');
const sessionToken = process.env.TWWINZ_SESSION || '';

async function main() {
  if (!sessionToken) {
    console.log('Usage: TWWINZ_SESSION="<your_session_token>" node scripts/migrate-images-to-r2.js [base_url]');
    console.log('Tip: You can also trigger migration while signed in from the browser console:');
    console.log('  fetch("/api/admin/migrate-images", { method: "POST" }).then(r => r.json()).then(console.log)');
    process.exit(0);
  }

  const res = await fetch(`${baseUrl}/api/admin/migrate-images`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Migration failed:', res.status, data);
    process.exit(1);
  }

  console.log(`Migration complete! Migrated ${data.migratedCount} image(s) to R2:`, data.migrated);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

