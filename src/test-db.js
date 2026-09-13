
import pool from './db.js';

async function testDatabase() {
    try {
        const result = await pool.query(
            'SELECT current_database(), current_timestamp'
        );

        console.log(result.rows);
    } catch (err) {
        console.error('Database connection failed:', err);
    } finally {
        await pool.end();
    }
}

testDatabase();