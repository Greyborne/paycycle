import pg from 'pg';
import { config } from './config.js';

// DATE columns come back as plain 'YYYY-MM-DD' strings (never JS Dates, which
// drag timezones into day-only arithmetic).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT (SUM() results) as Number - cent sums stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool(
  config.databaseUrl
    ? { connectionString: config.databaseUrl }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
      }
);

export function q(text, params) {
  return pool.query(text, params);
}
