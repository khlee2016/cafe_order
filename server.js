require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 메뉴 데이터 (변경 없음)
const MENU = {
  coffee: [
    { id: 'espresso',   name: '에스프레소', price: 3500, emoji: '☕' },
    { id: 'americano',  name: '아메리카노', price: 4000, emoji: '☕' },
    { id: 'latte',      name: '카페 라떼',  price: 4500, emoji: '🥛' },
    { id: 'cappuccino', name: '카푸치노',   price: 4500, emoji: '☕' },
    { id: 'mocha',      name: '카페 모카',  price: 5000, emoji: '🍫' },
    { id: 'cold_brew',  name: '콜드브루',   price: 5000, emoji: '🧊' },
  ],
  tea: [
    { id: 'green_tea',  name: '녹차',       price: 3500, emoji: '🍵' },
    { id: 'earl_grey',  name: '얼그레이',   price: 4000, emoji: '🫖' },
    { id: 'chamomile',  name: '캐모마일',   price: 4000, emoji: '🌼' },
    { id: 'peppermint', name: '페퍼민트',   price: 4000, emoji: '🌿' },
    { id: 'rooibos',    name: '루이보스',   price: 4000, emoji: '🍂' },
    { id: 'oolong',     name: '우롱차',     price: 4500, emoji: '🫖' },
  ],
};
const ALL_MENU = [...MENU.coffee, ...MENU.tea];

// ── DB 조회 결과를 API 응답 포맷으로 변환
function formatOrder(row, items = []) {
  return {
    id:           row.order_no,
    customerName: row.customer_name,
    tableNumber:  row.table_number,
    total:        row.total,
    status:       row.status,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
    items: items.map(i => ({
      id:       i.item_id,
      name:     i.item_name,
      emoji:    i.emoji,
      price:    i.price,
      quantity: i.quantity,
      subtotal: i.subtotal,
    })),
  };
}

// ── 주문 + 아이템 JOIN 조회 (단건)
async function fetchOrder(orderNo) {
  const oRes = await db.query(
    'SELECT * FROM orders WHERE order_no = $1', [orderNo]
  );
  if (!oRes.rows.length) return null;
  const iRes = await db.query(
    'SELECT * FROM order_items WHERE order_no = $1 ORDER BY id', [orderNo]
  );
  return formatOrder(oRes.rows[0], iRes.rows);
}

// ── 전체 주문 + 아이템 JOIN 조회
async function fetchAllOrders(status) {
  const where = status ? 'WHERE o.status = $1' : '';
  const params = status ? [status] : [];

  const oRes = await db.query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC`, params
  );
  if (!oRes.rows.length) return [];

  const orderNos = oRes.rows.map(r => r.order_no);
  const iRes = await db.query(
    `SELECT * FROM order_items WHERE order_no = ANY($1) ORDER BY id`,
    [orderNos]
  );

  const itemMap = {};
  iRes.rows.forEach(i => {
    if (!itemMap[i.order_no]) itemMap[i.order_no] = [];
    itemMap[i.order_no].push(i);
  });

  return oRes.rows.map(r => formatOrder(r, itemMap[r.order_no] || []));
}

// ═══════════════════════════════
//   API 라우트
// ═══════════════════════════════

// GET /api/menu
app.get('/api/menu', (req, res) => {
  res.json({ success: true, menu: MENU });
});

// GET /api/db-status  — DB 연결 상태 확인
app.get('/api/db-status', async (req, res) => {
  try {
    const now = await db.ping();
    res.json({ success: true, connected: true, serverTime: now });
  } catch (err) {
    res.status(503).json({ success: false, connected: false, error: err.message });
  }
});

// POST /api/orders  — 주문 생성
app.post('/api/orders', async (req, res) => {
  const { customerName, items, tableNumber } = req.body;

  if (!customerName || !items || items.length === 0) {
    return res.status(400).json({ success: false, message: '주문 정보가 올바르지 않습니다.' });
  }

  // 메뉴 검증 및 금액 계산
  let resolvedItems;
  try {
    resolvedItems = items.map(item => {
      const menuItem = ALL_MENU.find(m => m.id === item.id);
      if (!menuItem) throw new Error(`메뉴 없음: ${item.id}`);
      return { ...menuItem, quantity: item.quantity, subtotal: menuItem.price * item.quantity };
    });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }

  const total = resolvedItems.reduce((s, i) => s + i.subtotal, 0);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const orderNo = await db.nextOrderNo();

    await client.query(
      `INSERT INTO orders (order_no, customer_name, table_number, total, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [orderNo, customerName, tableNumber || '-', total]
    );

    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO order_items (order_no, item_id, item_name, emoji, price, quantity, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderNo, item.id, item.name, item.emoji, item.price, item.quantity, item.subtotal]
      );
    }

    await client.query('COMMIT');

    const order = await fetchOrder(orderNo);
    res.status(201).json({ success: true, order });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('주문 생성 오류:', err);
    res.status(500).json({ success: false, message: '주문 처리 중 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// GET /api/orders  — 전체 주문 조회
app.get('/api/orders', async (req, res) => {
  try {
    const { status } = req.query;
    const orders = await fetchAllOrders(status);
    res.json({ success: true, orders });
  } catch (err) {
    console.error('주문 조회 오류:', err);
    res.status(500).json({ success: false, message: '주문 조회 중 오류가 발생했습니다.' });
  }
});

// GET /api/orders/:id  — 단건 조회
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/orders/:id  — 상태 변경
app.patch('/api/orders/:id', async (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'accepted', 'completed', 'cancelled'];
  if (!valid.includes(status)) {
    return res.status(400).json({ success: false, message: '올바르지 않은 상태입니다.' });
  }
  try {
    const result = await db.query(
      `UPDATE orders SET status = $1 WHERE order_no = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    }
    const order = await fetchOrder(req.params.id);
    res.json({ success: true, order });
  } catch (err) {
    console.error('상태 변경 오류:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/orders/:id
app.delete('/api/orders/:id', async (req, res) => {
  try {
    // CASCADE로 order_items도 함께 삭제됨
    const result = await db.query(
      'DELETE FROM orders WHERE order_no = $1 RETURNING order_no',
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('주문 삭제 오류:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/stats  — 통계 (관리자용)
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE status = 'pending')       AS pending,
        COUNT(*) FILTER (WHERE status = 'accepted')      AS accepted,
        COUNT(*) FILTER (WHERE status = 'completed')     AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')     AS cancelled,
        COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0) AS revenue
      FROM orders
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 페이지 라우트
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── 서버 시작 (DB 초기화 후)
db.initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n☕  카페 주문 서버: http://localhost:${PORT}`);
      console.log(`📋  관리자 페이지: http://localhost:${PORT}/admin\n`);
    });
  })
  .catch(err => {
    console.error('❌  DB 초기화 실패:', err.message);
    console.error('   .env 파일의 DB 설정을 확인하세요.');
    process.exit(1);
  });
