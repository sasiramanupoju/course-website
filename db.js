const { Pool } = require('pg');
require('dotenv').config();

// Vercel sometimes prefers explicit configurations over a single connection string
// This manually parses your DATABASE_URL if it exists
let dbConfig = {};

if (process.env.DATABASE_URL) {
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      // rejectUnauthorized: false
    },
    connectionTimeoutMillis: 5000 // Fails fast instead of hanging
  };
} else {
  // Fallback for localhost if you are still using individual variables there
  dbConfig = {
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT || 5432,
    ssl: {
      rejectUnauthorized: false
    }
  };
}

const pool = new Pool(dbConfig);

// Test the connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('VERCEL DIAGNOSTIC - Connection Error:', err.message);
    console.error('VERCEL DIAGNOSTIC - Host Attempted:', dbConfig.host || 'Parsed from URL');
  } else {
    console.log('VERCEL DIAGNOSTIC - Successfully connected to database!');
    release();
  }
});

module.exports = pool;