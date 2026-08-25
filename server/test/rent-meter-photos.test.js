'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  MAX_PHOTO_BYTES,
  photoInput,
  upsertMeterPhoto
} = require('../rent-meter-photos');

function jpegDataUrl(size = 120) {
  const bytes = Buffer.alloc(size, 1);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

test('ảnh đồng hồ chỉ nhận JPEG nhỏ đã tái mã hóa và tính SHA-256 phía server', () => {
  const parsed = photoInput({
    roomId: 'room-1',
    period: '2026-08',
    meterType: 'electricity',
    dataUrl: jpegDataUrl()
  });
  assert.equal(parsed.imageData.length, 120);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.meterType, 'electricity');

  assert.throws(
    () => photoInput({ roomId: 'room-1', period: '2026-08', meterType: 'gas', dataUrl: jpegDataUrl() }),
    (error) => error.code === 'INVALID_METER_PHOTO'
  );
  assert.throws(
    () => photoInput({
      roomId: 'room-1',
      period: '2026-08',
      meterType: 'water',
      dataUrl: jpegDataUrl(MAX_PHOTO_BYTES + 1)
    }),
    (error) => error.code === 'INVALID_METER_PHOTO'
  );
  assert.throws(
    () => photoInput({
      roomId: 'room-1',
      period: '2026-08',
      meterType: 'water',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo='
    }),
    (error) => error.code === 'INVALID_METER_PHOTO'
  );
});

test('upload khóa ownership theo user và upsert đúng một ảnh mỗi loại/phòng/tháng', async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT 1 FROM rooms')) return { rows: [{ '?column?': 1 }] };
    return { rows: [{
      room_id: 'room-1',
      period: '2026-08',
      meter_type: 'electricity',
      byte_size: 120,
      sha256: 'a'.repeat(64),
      updated_at: '2026-08-25T00:00:00.000Z'
    }] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await upsertMeterPhoto({
    userId: 7,
    body: {
      roomId: 'room-1',
      period: '2026-08',
      meterType: 'electricity',
      dataUrl: jpegDataUrl()
    }
  }, response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.photo.byteSize, 120);
  assert.deepEqual(calls[0].params, [7, 'room-1']);
  assert.match(calls[1].sql, /ON CONFLICT \(user_id, room_id, period, meter_type\) DO UPDATE/);
  assert.equal(Buffer.isBuffer(calls[1].params[4]), true);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('schema, migration, OCR và trang khách thuê bảo vệ dung lượng và không lưu ảnh gốc', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_meter_photos.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const ocrSource = fs.readFileSync(path.join(root, 'ocr.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const publicJs = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rent_meter_photos/);
    assert.match(source, /byte_size BETWEEN 100 AND 98304/);
    assert.match(source, /octet_length\(image_data\)=byte_size/);
    assert.match(source, /PRIMARY KEY \(user_id, room_id, period, meter_type\)/);
    assert.match(source, /GRANT UPDATE \(mime_type, image_data, byte_size, sha256, updated_at\)/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*runtime_photo_update_ready/);
  assert.match(serverSource, /'\/api\/rent-meter-photos'/);
  assert.match(apiSource, /function upsertRentMeterPhoto/);
  assert.match(appSource, /saveMeterPhoto\('electricity', capture\)/);
  assert.match(appSource, /saveMeterPhoto\('water', capture\)/);
  assert.match(ocrSource, /function _meterPhotoDataUrl/);
  assert.match(ocrSource, /toDataURL\('image\/jpeg'/);
  assert.match(ocrSource, /_ocrCallback\(val, \{ photoDataUrl:/);
  assert.match(htmlSource, /ocr\.js\?v=90/);
  assert.match(publicHtml, /id="invoice-meter-photos"/);
  assert.match(publicHtml, /invoice-public\.css\?v=6[\s\S]*invoice-public\.js\?v=6/);
  assert.match(publicJs, /function renderMeterPhotos/);
  assert.doesNotMatch(publicJs, /innerHTML/);
});
