'use strict';
// ============================================================================
// Local Supabase-compatible Postgres for verification
// ----------------------------------------------------------------------------
// Boots a real PostgreSQL server (embedded-postgres) and adds the small amount
// of Supabase surface the schema depends on: the `auth` schema, `auth.uid()`
// and the anon / authenticated / service_role roles. That is enough to run the
// real migrations — including RLS policies — exactly as they run on Supabase.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadEmbedded() {
  try {
    // embedded-postgres is ESM with a default export
    return require('embedded-postgres').default || require('embedded-postgres');
  } catch (e) {
    return null;
  }
}

async function startLocalSupabase({ port = 55432, keepData = false } = {}) {
  const EmbeddedPostgres = loadEmbedded();
  if (!EmbeddedPostgres) {
    const err = new Error('embedded-postgres is not installed. Run: npm i -D embedded-postgres');
    err.code = 'MISSING_EMBEDDED_PG';
    throw err;
  }

  const dir = keepData
    ? path.join(os.tmpdir(), 'spinto-pg-fixed')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-pg-'));
  fs.mkdirSync(dir, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: keepData,
  });
  await pg.initialise();
  await pg.start();

  const { Client } = require('pg');
  const connect = () => new Client({
    host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  const client = connect();
  await client.connect();

  // --- Supabase shims -------------------------------------------------------
  await client.query('create schema if not exists auth');
  await client.query(`create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    encrypted_password text,
    email_confirmed_at timestamptz,
    created_at timestamptz default now()
  )`);
  // Supabase's auth.uid() reads the JWT subject claim.
  await client.query(`create or replace function auth.uid() returns uuid
    language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$`);
  await client.query(`create or replace function auth.role() returns text
    language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')
  $$`);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        execute 'create role ${role} nologin';
      end if;
    end $$`);
  }
  await client.query('grant usage on schema auth to anon, authenticated, service_role');

  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  return {
    url,
    port,
    client,
    connect,
    async stop() {
      try { await client.end(); } catch (e) { /* already closed */ }
      await pg.stop();
      if (!keepData) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startLocalSupabase };
