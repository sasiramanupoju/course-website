const { Pool } = require('pg');

// Paste your NeonDB connection string directly here
const myDatabaseUrl = 'postgresql://neondb_owner:npg_9ify1KvpCGFA@ep-divine-bonus-anjev2p4-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
    connectionString: myDatabaseUrl,
    ssl: {
      rejectUnauthorized: false
    },
    connectionTimeoutMillis: 5000 // Fails fast instead of hanging
});

// Test the connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Connection Error:', err.message);
  } else {
    console.log('Successfully connected to database!');
    release();
  }
});

module.exports = pool;