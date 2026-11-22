const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// numeric -> JS number (amounts here are far below 2^53 paise)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

/** Run a query. Returns the pg result ({ rows, rowCount }). */
const query = (text, params) => pool.query(text, params);
/** First row or null. */
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
/** All rows. */
const many = async (text, params) => (await pool.query(text, params)).rows;

/** Run fn(client) inside a transaction; client has .query. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = { pool, query, one, many, tx, init };
