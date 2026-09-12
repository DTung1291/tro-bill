'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const DataImport = require('../../data-import');

const root = path.join(__dirname, '..', '..');

function idFactory(prefix = 'id') {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

test('CSV từ Excel gom nhiều khách vào đúng phòng và đọc được dấu phân cách chấm phẩy', () => {
  const csv = [
    'khu;phong;tien_thue;gia_dien;kieu_nuoc;gia_nuoc;ten_khach;email;cccd;ngay_cap;ngay_sinh;gioi_tinh;dia_chi',
    'Khu A;P.101;2.500.000;3.500;người;60.000;Nguyễn Văn A;a@example.com;079099001234;2021-05-10;1999-08-15;Nam;Đà Nẵng',
    'Khu A;P.101;2.500.000;3.500;người;60.000;Trần Thị B;b@example.com;079199005678;2022-01-20;2000-11-02;Nữ;Huế',
    'Khu A;P.102;2.800.000;3.500;khối;20.000;;;;;;;'
  ].join('\r\n');
  const parsed = DataImport.parseCsv(csv);
  const normalized = DataImport.normalizeImport(parsed, {
    currentPeriod: '2026-09',
    makeId: idFactory()
  });

  assert.equal(normalized.format, 'csv');
  assert.equal(normalized.summary.roomCount, 2);
  assert.equal(normalized.summary.tenantCount, 2);
  assert.equal(normalized.rooms[0].rentPrice, 2500000);
  assert.equal(normalized.rooms[0].tenants[1].gender, 'Nữ');
  assert.equal(normalized.rooms[1].waterType, 'khối');
  assert.equal(normalized.rooms[1].rateHistory[0].effectiveFrom, '2026-09');
});

test('CSV từ chối khách thiếu hồ sơ bắt buộc trước khi chạm state', () => {
  const csv = [
    'phong,tien_thue,ten_khach,cccd,ngay_cap,ngay_sinh,gioi_tinh,dia_chi',
    'P.101,2500000,Khách A,123456789012,,2000-01-01,Nam,Đà Nẵng'
  ].join('\n');
  assert.throws(
    () => DataImport.parseCsv(csv),
    (error) => error.code === 'IMPORT_REQUIRED_TENANT_DATE'
  );
});

test('JSON từ chối CCCD đã che và ID phòng trùng', () => {
  const masked = DataImport.parseJson(JSON.stringify({
    rooms: [{
      id: 'room-1', name: 'P.1', rentPrice: 1,
      tenants: [{ fullName: 'Khách A', cccd: '••••••••1234', address: 'Huế' }]
    }]
  }));
  assert.throws(
    () => DataImport.normalizeImport(masked, { currentPeriod: '2026-09', makeId: idFactory() }),
    (error) => error.code === 'IMPORT_MASKED_CCCD'
  );

  const duplicate = DataImport.parseJson(JSON.stringify({
    rooms: [{ id: 'same', name: 'P.1' }, { id: 'same', name: 'P.2' }]
  }));
  assert.throws(
    () => DataImport.normalizeImport(duplicate, { currentPeriod: '2026-09', makeId: idFactory() }),
    (error) => error.code === 'IMPORT_DUPLICATE_ROOM_ID'
  );
});

test('JSON giữ ánh xạ tên khu để app không âm thầm dồn phòng về khu mặc định', () => {
  const imported = DataImport.normalizeImport(DataImport.parseJson(JSON.stringify({
    properties: [{ id: 7, name: 'Khu ven sông', isDefault: false }],
    rooms: [{ id: 'room-7', propertyId: 7, name: 'P.7' }]
  })), { currentPeriod: '2026-09', makeId: idFactory() });

  assert.deepEqual(imported.properties, [{ id: 7, name: 'Khu ven sông', isDefault: false }]);
  assert.deepEqual(imported.summary.propertyNames, ['Khu ven sông']);
  assert.equal(imported.rooms[0].propertyId, 7);
});

test('merge tạo ID mới, remap kỳ bill và giữ cài đặt hiện tại', () => {
  const imported = DataImport.normalizeImport(DataImport.parseJson(JSON.stringify({
    rooms: [{ id: 'source-room', name: 'P.2', rentPrice: 2000000 }],
    billingData: { '2026-09': { 'source-room': { electricNew: 20 } } },
    settings: { bankAccount: 'khong-duoc-ghi-de' }
  })), { currentPeriod: '2026-09', makeId: idFactory('normalized') });
  imported.rooms[0].propertyId = 10;
  const current = {
    rooms: [{ id: 'current-room', propertyId: 10, name: 'P.1', tenants: [] }],
    billingData: { '2026-09': { 'current-room': { electricNew: 10 } } },
    expenses: {},
    settings: { bankAccount: 'giu-nguyen' },
    history: [],
    theme: 'dark'
  };
  const merged = DataImport.mergeImport(current, imported, idFactory('merged'));

  assert.equal(merged.rooms.length, 2);
  assert.equal(merged.rooms[1].id, 'merged-1');
  assert.equal(merged.billingData['2026-09']['merged-1'].electricNew, 20);
  assert.equal(merged.settings.bankAccount, 'giu-nguyen');
});

test('merge từ chối trùng tên phòng trong cùng khu', () => {
  const imported = DataImport.normalizeImport(DataImport.parseJson(JSON.stringify({
    rooms: [{ id: 'source-room', name: 'P.1', rentPrice: 2000000 }]
  })), { currentPeriod: '2026-09', makeId: idFactory() });
  imported.rooms[0].propertyId = 10;
  assert.throws(
    () => DataImport.mergeImport({ rooms: [{ propertyId: 10, name: 'P.1' }] }, imported, idFactory()),
    (error) => error.code === 'IMPORT_DUPLICATE_ROOM_NAME'
  );
});

test('UI có preview, consent, rollback và tải module trước app', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /accept="\.json,\.csv,application\/json,text\/csv"/);
  assert.match(html, /id="data-import-modal"[\s\S]*name="data-import-mode"[\s\S]*id="data-import-tenant-consent-check"[\s\S]*id="data-import-replace-consent-check"/);
  assert.match(html, /data-import\.js\?v=1[\s\S]*app\.js\?v=143/);
  assert.match(html, /style\.css\?v=140/);
  assert.match(app, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(app, /await flushState\(\{ throwOnError: true \}\)/);
  assert.match(app, /const needsReplaceConsent = dataImportMode\(\) === 'replace'/);
  assert.match(app, /stateWasApplied && !stateWasPersisted/);
  assert.doesNotMatch(app, /confirm\(\s*`File có/);
  assert.match(css, /\.data-import-modal/);
  assert.match(css, /@media \(max-width: 560px\)/);
});
