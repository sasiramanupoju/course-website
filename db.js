const { Pool } = require('pg');
require('dotenv').config();

// Neon requires SSL for all connections
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false // Ensures compatibility with cloud certs on macOS
  }
});

// Test the connection on startup
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client for Neon DB', err.stack);
  }
  console.log('Successfully connected to Neon PostgreSQL Database');
  release();
});

module.exports = pool;