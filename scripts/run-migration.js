#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigration() {
  const migrationFile = process.argv[2];
  if (!migrationFile) {
    console.error('Usage: node run-migration.js <migration-file>');
    console.error('Example: node run-migration.js 20260830_room_operational_statuses.sql');
    process.exit(1);
  }

  const migrationPath = path.join(__dirname, '../server/migrations', migrationFile);
  if (!fs.existsSync(migrationPath)) {
    console.error(`Migration file not found: ${migrationPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set in environment');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });

  try {
    console.log(`Connecting to database...`);
    await client.connect();

    console.log(`Running migration: ${migrationFile}`);
    const result = await client.query(sql);

    console.log('Migration completed successfully!');

    // If migration returns results (like verification queries), display them
    if (result.rows && result.rows.length > 0) {
      console.log('\nVerification results:');
      console.table(result.rows);
    }
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
