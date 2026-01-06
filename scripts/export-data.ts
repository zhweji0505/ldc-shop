
import { sql } from '@vercel/postgres';
import fs from 'fs';
import path from 'path';

// Define tables and their column mappings if needed, or expected columns
const TABLES = [
    'products',
    'cards',
    'orders',
    'reviews',
    'settings',
    'login_users'
];

async function exportTable(tableName: string) {
    try {
        const result = await sql.query(`SELECT * FROM ${tableName}`);
        return result.rows;
    } catch (e: any) {
        console.warn(`Warning: Could not fetch table ${tableName}: ${e.message}`);
        return [];
    }
}

function escapeString(val: string): string {
    if (val === null || val === undefined) return 'NULL';
    // Replace single quotes with two single quotes for SQL escaping
    return "'" + val.replace(/'/g, "''") + "'";
}

function formatValue(val: any): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'boolean') return val ? '1' : '0'; // SQLite uses 1/0
    if (val instanceof Date) return "'" + val.toISOString().replace('T', ' ').replace('Z', '') + "'"; // Simple UTC format
    if (typeof val === 'number') return val.toString();
    if (typeof val === 'string') return escapeString(val);
    return escapeString(JSON.stringify(val));
}

async function main() {
    console.log("Starting export...");

    if (!process.env.POSTGRES_URL) {
        console.error("Error: POSTGRES_URL environment variable is missing.");
        console.error("Please run with: POSTGRES_URL='...' npx tsx scripts/export-data.ts");
        process.exit(1);
    }

    let sqlContent = `-- Database Migration Dump (Vercel Postgres -> Cloudflare D1)
-- Generated at ${new Date().toISOString()}

BEGIN TRANSACTION;

`;

    for (const table of TABLES) {
        console.log(`Exporting ${table}...`);
        const rows = await exportTable(table);

        if (rows.length === 0) continue;

        for (const row of rows) {
            const keys = Object.keys(row);
            const values = keys.map(k => formatValue(row[k]));

            const columns = keys.join(', ');
            const valStr = values.join(', ');

            sqlContent += `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${valStr});\n`;
        }
        sqlContent += "\n";
    }

    sqlContent += "COMMIT;\n";

    const outputPath = path.join(process.cwd(), '_workers_v2', 'migration_data.sql');
    fs.writeFileSync(outputPath, sqlContent);

    console.log(`\n✅ Export successful!`);
    console.log(`Data written to: ${outputPath}`);
    console.log(`\nNext Step: Apply to Cloudflare D1 via:`);
    console.log(`npx wrangler d1 execute ldc-shop-db --file=_workers_v2/migration_data.sql --remote`);
}

main().catch(console.error);
