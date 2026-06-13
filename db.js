// db.js ? PostgreSQL 연결 및 쿼리 모듈
require('dotenv').config();
const { Pool } = require('pg');

console.log('PostgreSQL process.env.DB_HOST :', process.env.DB_HOST);
console.log('PostgreSQL process.env.DB_PORT :', process.env.DB_PORT);
console.log('PostgreSQL process.env.DB_NAME :', process.env.DB_NAME);
console.log('PostgreSQL process.env.DB_USER :', process.env.DB_USER);
console.log('PostgreSQL process.env.DB_PASSWORD :', process.env.DB_PASSWORD);


const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'cafe_order_e88c',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  // 연결 풀 설정
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl : true,
});


pool.on('error', (err) => {
  console.error('PostgreSQL 풀 오류:', err.message);
});

// ── 테이블 초기화
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id           SERIAL PRIMARY KEY,
        order_no     VARCHAR(10)  NOT NULL UNIQUE,   -- e.g. #1001
        customer_name VARCHAR(100) NOT NULL,
        table_number VARCHAR(20)  DEFAULT '-',
        total        INTEGER      NOT NULL DEFAULT 0,
        status       VARCHAR(20)  NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','completed','cancelled')),
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id           SERIAL PRIMARY KEY,
        order_no     VARCHAR(10)  NOT NULL REFERENCES orders(order_no) ON DELETE CASCADE,
        item_id      VARCHAR(50)  NOT NULL,
        item_name    VARCHAR(100) NOT NULL,
        emoji        VARCHAR(10),
        price        INTEGER      NOT NULL,
        quantity     INTEGER      NOT NULL,
        subtotal     INTEGER      NOT NULL
      );
    `);

    // updated_at 자동 갱신 트리거
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
      CREATE TRIGGER trg_orders_updated_at
        BEFORE UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `);

    console.log('?  PostgreSQL 테이블 준비 완료');
  } finally {
    client.release();
  }
}

// ── 헬퍼
function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

// ── DB 상태 확인
async function ping() {
  const res = await pool.query('SELECT NOW() AS now');
  return res.rows[0].now;
}

// ── order_no 시퀀스 생성 (현재 최대값 기반)
async function nextOrderNo() {
  const res = await pool.query(`SELECT MAX(CAST(SUBSTRING(order_no FROM 2) AS INTEGER)) AS max_no FROM orders`);
  const max = res.rows[0].max_no || 1000;
  return `#${max + 1}`;
}

module.exports = { initDB, query, getClient, ping, nextOrderNo };
