'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* optional */ }
const { initDb, query, tx, close, RES } = require('./db');

async function migrate() {
  const sqliteFile = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'sovanvitou.db');
  if (!fs.existsSync(sqliteFile)) {
    console.log('No SQLite database found at:', sqliteFile);
    return;
  }

  console.log('Connecting to SQLite at:', sqliteFile);
  const sdb = new DatabaseSync(sqliteFile);
  await initDb();
  console.log('Connected to PostgreSQL. Starting migration...');

  const tables = [
    'clinic',
    'settings',
    'users',
    ...Object.keys(RES),
    'sales',
    'sale_items',
  ];

  for (const t of tables) {
    let rows = [];
    try {
      rows = sdb.prepare(`SELECT * FROM "${t}"`).all();
    } catch {
      continue;
    }
    if (!rows.length) continue;

    console.log(`Migrating ${rows.length} rows for table "${t}"...`);
    await tx(async (client) => {
      for (const row of rows) {
        const keys = Object.keys(row);
        const cols = keys.map((k) => `"${k}"`).join(',');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
        const values = Object.values(row);

        if (t === 'clinic') {
          const updateSets = keys.filter((k) => k !== 'id').map((k, i) => `"${k}"=EXCLUDED."${k}"`).join(',');
          await client.query(
            `INSERT INTO "${t}"(${cols}) VALUES(${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateSets}`,
            values
          );
        } else if (t === 'settings') {
          await client.query(
            `INSERT INTO "${t}"(${cols}) VALUES(${placeholders}) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
            values
          );
        } else if (t === 'users') {
          await client.query(
            `INSERT INTO "${t}"(${cols}) VALUES(${placeholders}) ON CONFLICT (email) DO NOTHING`,
            values
          );
        } else {
          await client.query(
            `INSERT INTO "${t}"(${cols}) VALUES(${placeholders}) ON CONFLICT DO NOTHING`,
            values
          );
        }
      }

      // Reset auto-increment sequence in PostgreSQL if table has 'id' column
      if (rows[0] && 'id' in rows[0] && t !== 'clinic') {
        try {
          await client.query(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`);
        } catch {}
      }
    });
  }

  sdb.close();
  console.log('✓ Migration from SQLite to PostgreSQL completed successfully!');
  await close();
}

migrate().catch(async (err) => {
  console.error('Migration error:', err);
  await close();
  process.exit(1);
});

