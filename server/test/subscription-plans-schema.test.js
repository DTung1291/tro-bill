'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const plansTable = schema.match(/CREATE TABLE IF NOT EXISTS plans \(([\s\S]*?)\n\);/);
const plansSeed = schema.match(/INSERT INTO plans\n([\s\S]*?)ON CONFLICT \(code\) DO NOTHING;/);

test('schema plans lưu mã gói, giá VND và giới hạn sử dụng ở server', () => {
  assert.ok(plansTable, 'Thiếu bảng plans');

  const definition = plansTable[1];
  assert.match(definition, /code\s+TEXT NOT NULL UNIQUE/);
  assert.match(definition, /monthly_price_vnd\s+NUMERIC\(12, 0\)/);
  assert.match(definition, /yearly_price_vnd\s+NUMERIC\(12, 0\)/);
  assert.match(definition, /room_limit\s+INTEGER NOT NULL/);
  assert.match(definition, /staff_limit\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(definition, /CHECK \(monthly_price_vnd IS NULL OR monthly_price_vnd >= 0\)/);
  assert.match(definition, /CHECK \(yearly_price_vnd IS NULL OR yearly_price_vnd >= 0\)/);
  assert.match(definition, /CHECK \(room_limit > 0\)/);
  assert.match(definition, /CHECK \(staff_limit >= 0\)/);
});

test('seed plans tạo đủ bốn gói theo giới hạn phòng trong checklist', () => {
  assert.ok(plansSeed, 'Thiếu dữ liệu plans mặc định');

  const seed = plansSeed[1];
  assert.match(seed, /'free'[\s\S]*?10/);
  assert.match(seed, /'standard'[\s\S]*?25/);
  assert.match(seed, /'pro'[\s\S]*?50/);
  assert.match(seed, /'business'[\s\S]*?100/);
});

test('chỉ Free được mở; schema không ghi đè giá do admin đã cấu hình', () => {
  assert.ok(plansSeed, 'Thiếu dữ liệu plans mặc định');

  const seed = plansSeed[1];
  assert.match(seed, /'free'[\s\S]*?0, 0, 10, 0, true, true/);
  assert.match(seed, /'standard'[\s\S]*?NULL, NULL, 25, 0, false, false/);
  assert.match(seed, /'pro'[\s\S]*?NULL, NULL, 50, 0, false, false/);
  assert.match(seed, /'business'[\s\S]*?NULL, NULL, 100, 1, false, false/);
  assert.match(schema, /ON CONFLICT \(code\) DO NOTHING;/);
  assert.doesNotMatch(schema, /ON CONFLICT \(code\) DO UPDATE/);
});
