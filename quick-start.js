'use strict';

(function initQuickStart() {
  const downloadButton = document.getElementById('download-sample');
  const status = document.getElementById('download-status');
  const periodLabel = document.getElementById('sample-period');

  function currentPeriod() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function randomId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function room(id, name, values) {
    return {
      id,
      name,
      rentStartDate: '',
      rentPrice: values.rentPrice,
      electricRate: 3500,
      waterRate: values.waterRate,
      waterType: values.waterType,
      peopleCount: values.peopleCount,
      trashFee: 50000,
      wifiFee: 50000,
      manageFee: 0,
      electricPrev: values.electricPrev,
      waterPrev: values.waterPrev,
      notes: 'Dữ liệu giả lập từ hướng dẫn TrọBill',
      tenants: [],
      rateHistory: [{
        effectiveFrom: currentPeriod(),
        rentPrice: values.rentPrice,
        electricRate: 3500,
        waterRate: values.waterRate,
        trashFee: 50000,
        wifiFee: 50000,
        manageFee: 0
      }]
    };
  }

  function sampleState() {
    const period = currentPeriod();
    const rooms = [
      room(randomId(), 'P.101', { rentPrice: 2500000, waterRate: 60000, waterType: 'người', peopleCount: 2, electricPrev: 1250, waterPrev: 0 }),
      room(randomId(), 'P.102', { rentPrice: 2800000, waterRate: 20000, waterType: 'khối', peopleCount: 1, electricPrev: 840, waterPrev: 112 }),
      room(randomId(), 'P.103', { rentPrice: 3200000, waterRate: 20000, waterType: 'khối', peopleCount: 1, electricPrev: 2060, waterPrev: 245 })
    ];
    return {
      rooms,
      billingData: {
        [period]: {
          [rooms[0].id]: { electricNew: 1328, waterUnits: 2, note: 'Bill giả lập' },
          [rooms[1].id]: { electricNew: 903, waterNew: 119, note: 'Bill giả lập' },
          [rooms[2].id]: { electricNew: 2141, waterNew: 254, note: 'Bill giả lập' }
        }
      },
      expenses: {},
      settings: {
        deduction: 0,
        bankId: '',
        bankAccount: '',
        bankOwnerName: '',
        bankTransferPattern: '',
        reminderEnabled: false,
        reminderDay: 30,
        reminderTime: '20:00',
        invoiceReminderEnabled: false,
        invoiceReminderBeforeDays: [3, 1],
        invoiceReminderAfterDays: [1, 3, 7]
      },
      currentPeriod: period,
      history: [],
      theme: 'system',
      sampleData: {
        source: 'trobill-quick-start',
        generatedAt: new Date().toISOString(),
        containsTenantPersonalData: false
      }
    };
  }

  function downloadSample() {
    const json = JSON.stringify(sampleState(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trobill_du_lieu_mau_${currentPeriod()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Đã tạo file mới. Hãy kiểm tra thư mục Tải xuống trên thiết bị.';
  }

  const [year, month] = currentPeriod().split('-');
  periodLabel.textContent = `${month}/${year}`;
  downloadButton.addEventListener('click', downloadSample);
})();
