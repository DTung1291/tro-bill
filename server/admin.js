'use strict';

// ============================================================
//  API dành cho admin — tất cả route dùng requireAuth + requireAdmin
// ============================================================
const bcrypt = require('bcryptjs');
const db = require('./db');
const { buildState } = require('./state');

// GET /api/admin/users — danh sách user + vài số liệu tóm tắt
async function listUsers(req, res) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.is_admin, u.created_at,
            (SELECT COUNT(*)::int FROM rooms r WHERE r.user_id = u.id)              AS room_count,
            (SELECT COUNT(*)::int FROM history_snapshots h WHERE h.user_id = u.id)  AS history_count
     FROM users u
     ORDER BY u.id`
  );
  res.json({
    users: rows.map((u) => ({
      id: Number(u.id),
      email: u.email,
      isAdmin: !!u.is_admin,
      createdAt: u.created_at,
      roomCount: u.room_count,
      historyCount: u.history_count
    }))
  });
}

// GET /api/admin/users/:id/state — xem toàn bộ dữ liệu trọ của 1 user
async function getUserState(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const found = await db.query('SELECT id, email FROM users WHERE id=$1', [id]);
  if (found.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });

  const state = await buildState(id);
  res.json({ user: { id, email: found.rows[0].email }, state });
}

// DELETE /api/admin/users/:id — xoá user (cascade dọn toàn bộ dữ liệu con)
async function deleteUser(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  if (id === Number(req.userId)) return res.status(400).json({ error: 'Không thể tự xoá chính mình' });

  const r = await db.query('DELETE FROM users WHERE id=$1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
  res.json({ ok: true });
}

// POST /api/admin/users/:id/password — đặt lại mật khẩu cho user
async function resetPassword(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });

  const hash = await bcrypt.hash(password, 10);
  const r = await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
  res.json({ ok: true });
}

// POST /api/admin/users/:id/admin — bật/tắt quyền admin
async function setAdmin(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  const makeAdmin = !!req.body.isAdmin;
  if (id === Number(req.userId) && !makeAdmin) {
    return res.status(400).json({ error: 'Không thể tự gỡ quyền admin của chính mình' });
  }
  const r = await db.query('UPDATE users SET is_admin=$1 WHERE id=$2', [makeAdmin, id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
  res.json({ ok: true, isAdmin: makeAdmin });
}

module.exports = { listUsers, getUserState, deleteUser, resetPassword, setAdmin };
