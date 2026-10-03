'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { digits, format, caretAfterDigits } = require('../../money-input');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('hiển thị phân cách hàng nghìn nhưng giữ nguyên số VND để tính toán', () => {
  assert.equal(format('500000'), '500.000');
  assert.equal(format('2200000'), '2.200.000');
  assert.equal(format('0'), '0');
  assert.equal(format(''), '');
  assert.equal(format('000500000'), '500.000');
  assert.equal(digits('2.200.000'), '2200000');
  assert.equal(digits('500,000 đ'), '500000');
  assert.equal(caretAfterDigits('2.200.000', 4), 5);
});

test('ô nhập hiển thị dấu chấm còn value cho app là chữ số thuần', () => {
  class FakeInput {
    constructor(value) {
      this.native = value;
      this.defaultValue = value;
      this.type = 'number';
      this.dataset = {};
      this.attributes = { min: '0', max: '' };
      this.listeners = {};
      this.placeholder = '500000';
    }
    get value() { return this.native; }
    set value(value) { this.native = String(value); }
    matches() { return true; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    setCustomValidity(message) { this.validationMessage = message; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setSelectionRange(start) { this.selectionStart = start; }
  }
  const context = vm.createContext({ HTMLInputElement: FakeInput, module: { exports: {} } });
  vm.runInContext(read('money-input.js'), context);
  const input = new FakeInput('500000');
  context.MoneyInput.enhance(input);
  assert.equal(input.type, 'text');
  assert.equal(input.native, '500.000');
  assert.equal(input.value, '500000');
  assert.equal(input.placeholder, '500.000');
  input.value = '1250000';
  assert.equal(input.native, '1.250.000');
  assert.equal(input.value, '1250000');
  assert.equal(input.validationMessage, ''); // max="" không phải giới hạn bằng 0.
  input.native = '1234567';
  input.selectionStart = 7;
  input.listeners.input({ isComposing: false });
  assert.equal(input.native, '1.234.567');
  assert.equal(input.value, '1234567');
  input.attributes.max = '1000000';
  input.value = '1250000';
  assert.notEqual(input.validationMessage, '');
  input.attributes.max = '';
  input.attributes.step = '5000';
  input.value = '7500';
  assert.notEqual(input.validationMessage, '');
  input.value = '10000';
  assert.equal(input.validationMessage, '');
});

test('các ô tiền dùng bộ định dạng chung, chỉ số và số lượng vẫn là number', () => {
  const index = read('index.html');
  const admin = read('admin.html');
  const app = read('app.js');
  const adminScript = read('admin.js');
  for (const id of [
    'expense-amount', 'deduction-input', 'donate-amount-input', 'subscription-refund-amount',
    'room-rent', 'room-elec-rate', 'room-trash', 'room-water-rate', 'room-wifi-fee',
    'room-manage-fee', 'rental-reservation-deposit', 'rental-contract-rent',
    'rental-contract-deposit', 'tenant-maintenance-expense-amount', 'rental-lifecycle-rent',
    'rental-lifecycle-deposit', 'rental-final-settlement-applied',
    'rental-final-settlement-refunded', 'rent-payment-entry-amount', 'deposit-amount'
  ]) {
    assert.match(index, new RegExp(`<input[^>]*data-money-input[^>]*id="${id}"|<input[^>]*id="${id}"[^>]*data-money-input`), id);
  }
  for (const id of ['financial-report-year', 'room-people-count', 'rental-handover-electricity', 'ocr-result-input']) {
    const tag = index.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag && !tag.includes('data-money-input'), `${id} không phải tiền`);
  }
  assert.match(app, /name="newMonthlyRentVnd"/);
  assert.match(app, /class="bill-adjustment-input"/);
  assert.match(app, /id="room-asset-price" type="number"/);
  assert.match(adminScript, /input\.className = 'admin-plan-price'/);
  const formatter = read('money-input.js');
  assert.match(formatter, /input\[name="newMonthlyRentVnd"\]/);
  assert.match(formatter, /input\.bill-adjustment-input/);
  assert.match(formatter, /input#room-asset-price/);
  assert.match(formatter, /input\.admin-plan-price/);
  assert.ok(index.indexOf('money-input.js?v=1') < index.indexOf('app.js?v=175'));
  assert.ok(admin.indexOf('money-input.js?v=1') < admin.indexOf('admin.js?v=85'));
  assert.match(read('money-input.css'), /\.billing-table input\[data-money-input\]/);
});
