const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  // Vercel serverless functions can hang if a connection drops. 
  // This tells the pool to timeout and throw an error after 5 seconds if it can't connect.
  connectionTimeoutMillis: 5000, 
  idleTimeoutMillis: 30000
});

// This will log database connection errors directly to your Vercel logs
// pool.on('error', (err, client) => {
//   console.error('Unexpected error on idle client', err);
// });

// module.exports = pool;

// Test the connection on startup
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client for Neon DB', err.stack);
  }
  console.log('Successfully connected to Neon PostgreSQL Database');
  release();
});

module.exports = pool;