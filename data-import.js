'use strict';

(function exposeDataImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TroBillDataImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDataImport() {
  const MAX_ROOMS = 500;
  const MAX_TENANTS = 2000;
  const MAX_TEXT = 500;
  const MAX_MONEY = 999999999999;

  class ImportError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'ImportError';
      this.code = code;
      this.details = details;
    }
  }

  function cleanText(value, field, max = MAX_TEXT, required = false) {
    const text = String(value ?? '').trim();
    if (required && !text) throw new ImportError('IMPORT_REQUIRED_FIELD', `${field} không được để trống`);
    if (text.length > max) throw new ImportError('IMPORT_TEXT_TOO_LONG', `${field} dài quá ${max} ký tự`);
    return text;
  }

  function integer(value, field, fallback = 0) {
    if (value === '' || value === null || value === undefined) return fallback;
    const parsed = typeof value === 'string'
      ? Number(value.replace(/[.\s₫đ,]/gi, ''))
      : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MONEY) {
      throw new ImportError('IMPORT_INVALID_NUMBER', `${field} phải là số nguyên không âm`);
    }
    return parsed;
  }

  function date(value, field) {
    const text = cleanText(value, field, 10);
    if (!text) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new ImportError('IMPORT_INVALID_DATE', `${field} phải có dạng YYYY-MM-DD`);
    }
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
      throw new ImportError('IMPORT_INVALID_DATE', `${field} không phải ngày hợp lệ`);
    }
    return text;
  }

  function period(value, field) {
    const text = cleanText(value, field, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
      throw new ImportError('IMPORT_INVALID_PERIOD', `${field} phải có dạng YYYY-MM`);
    }
    return text;
  }

  function email(value, field) {
    const text = cleanText(value, field, 254).toLowerCase();
    if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      throw new ImportError('IMPORT_INVALID_EMAIL', `${field} không hợp lệ`);
    }
    return text;
  }

  function normalizeHeader(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/đ/g, 'd')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = source.split(/\r?\n/, 1)[0] || '';
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length
      ? ';'
      : ',';
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"' && source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          cell += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === delimiter) {
        row.push(cell);
        cell = '';
      } else if (character === '\n') {
        row.push(cell.replace(/\r$/, ''));
        if (row.some((value) => String(value).trim())) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += character;
      }
    }
    if (quoted) throw new ImportError('IMPORT_INVALID_CSV', 'File CSV có ô chưa đóng dấu ngoặc kép');
    row.push(cell.replace(/\r$/, ''));
    if (row.some((value) => String(value).trim())) rows.push(row);
    return rows;
  }

  const CSV_ALIASES = Object.freeze({
    khu: 'propertyName', property: 'propertyName', property_name: 'propertyName',
    phong: 'roomName', ten_phong: 'roomName', room: 'roomName', room_name: 'roomName',
    tien_thue: 'rentPrice', rent: 'rentPrice', rent_price: 'rentPrice',
    gia_dien: 'electricRate', electric_rate: 'electricRate',
    kieu_nuoc: 'waterType', water_type: 'waterType',
    gia_nuoc: 'waterRate', water_rate: 'waterRate',
    so_nguoi: 'peopleCount', people_count: 'peopleCount',
    phi_rac: 'trashFee', trash_fee: 'trashFee',
    phi_wifi: 'wifiFee', wifi_fee: 'wifiFee',
    phi_quan_ly: 'manageFee', manage_fee: 'manageFee',
    dien_dau: 'electricPrev', electric_previous: 'electricPrev',
    nuoc_dau: 'waterPrev', water_previous: 'waterPrev',
    ngay_bat_dau: 'rentStartDate', rent_start_date: 'rentStartDate',
    ten_khach: 'tenantName', tenant_name: 'tenantName',
    dien_thoai: 'tenantPhone', tenant_phone: 'tenantPhone',
    email: 'tenantEmail', tenant_email: 'tenantEmail',
    cccd: 'tenantCccd', tenant_cccd: 'tenantCccd',
    ngay_cap: 'tenantIssueDate', tenant_issue_date: 'tenantIssueDate',
    ngay_sinh: 'tenantDob', tenant_dob: 'tenantDob',
    gioi_tinh: 'tenantGender', tenant_gender: 'tenantGender',
    dia_chi: 'tenantAddress', tenant_address: 'tenantAddress'
  });

  function csvValue(row, columns, key) {
    const index = columns.indexOf(key);
    return index < 0 ? '' : row[index];
  }

  function parseCsv(text) {
    const rows = parseCsvRows(text);
    if (rows.length < 2) throw new ImportError('IMPORT_EMPTY_CSV', 'File CSV chưa có dòng dữ liệu');
    const columns = rows[0].map((header) => CSV_ALIASES[normalizeHeader(header)] || '');
    if (!columns.includes('roomName')) {
      throw new ImportError('IMPORT_MISSING_ROOM_COLUMN', 'File CSV phải có cột phong hoặc room_name');
    }
    const roomsByKey = new Map();
    rows.slice(1).forEach((row, index) => {
      const line = index + 2;
      const roomName = cleanText(csvValue(row, columns, 'roomName'), `Dòng ${line}: phòng`, 200, true);
      const propertyName = cleanText(csvValue(row, columns, 'propertyName'), `Dòng ${line}: khu`, 200);
      const key = `${propertyName.toLocaleLowerCase('vi')}\u0000${roomName.toLocaleLowerCase('vi')}`;
      let room = roomsByKey.get(key);
      if (!room) {
        const waterTypeInput = cleanText(csvValue(row, columns, 'waterType'), `Dòng ${line}: kiểu nước`, 20).toLocaleLowerCase('vi');
        const waterType = ['khối', 'khoi', 'm3'].includes(waterTypeInput) ? 'khối' : 'người';
        room = {
          propertyName,
          name: roomName,
          rentStartDate: date(csvValue(row, columns, 'rentStartDate'), `Dòng ${line}: ngày bắt đầu`),
          rentPrice: integer(csvValue(row, columns, 'rentPrice'), `Dòng ${line}: tiền thuê`),
          electricRate: integer(csvValue(row, columns, 'electricRate'), `Dòng ${line}: giá điện`, 3500),
          waterRate: integer(csvValue(row, columns, 'waterRate'), `Dòng ${line}: giá nước`, waterType === 'khối' ? 20000 : 60000),
          waterType,
          peopleCount: integer(csvValue(row, columns, 'peopleCount'), `Dòng ${line}: số người`, 1),
          trashFee: integer(csvValue(row, columns, 'trashFee'), `Dòng ${line}: phí rác`),
          wifiFee: integer(csvValue(row, columns, 'wifiFee'), `Dòng ${line}: phí wifi`),
          manageFee: integer(csvValue(row, columns, 'manageFee'), `Dòng ${line}: phí quản lý`),
          electricPrev: integer(csvValue(row, columns, 'electricPrev'), `Dòng ${line}: điện đầu`),
          waterPrev: integer(csvValue(row, columns, 'waterPrev'), `Dòng ${line}: nước đầu`),
          notes: 'Nhập từ CSV',
          tenants: []
        };
        roomsByKey.set(key, room);
      }
      const tenantName = cleanText(csvValue(row, columns, 'tenantName'), `Dòng ${line}: tên khách`, 200);
      if (tenantName) {
        const cccd = cleanText(csvValue(row, columns, 'tenantCccd'), `Dòng ${line}: CCCD`, 20, true);
        if (!/^\d{9}$|^\d{12}$/.test(cccd)) {
          throw new ImportError('IMPORT_INVALID_CCCD', `Dòng ${line}: CCCD phải có 9 hoặc 12 chữ số`);
        }
        const genderInput = cleanText(csvValue(row, columns, 'tenantGender'), `Dòng ${line}: giới tính`, 20, true).toLocaleLowerCase('vi');
        const genderMap = { nam: 'Nam', nu: 'Nữ', 'nữ': 'Nữ', khac: 'Khác', 'khác': 'Khác' };
        if (!genderMap[genderInput]) throw new ImportError('IMPORT_INVALID_GENDER', `Dòng ${line}: giới tính phải là Nam, Nữ hoặc Khác`);
        const issueDate = date(csvValue(row, columns, 'tenantIssueDate'), `Dòng ${line}: ngày cấp`);
        const dob = date(csvValue(row, columns, 'tenantDob'), `Dòng ${line}: ngày sinh`);
        if (!issueDate || !dob) {
          throw new ImportError('IMPORT_REQUIRED_TENANT_DATE', `Dòng ${line}: khách thuê cần ngày cấp và ngày sinh dạng YYYY-MM-DD`);
        }
        room.tenants.push({
          fullName: tenantName,
          phone: cleanText(csvValue(row, columns, 'tenantPhone'), `Dòng ${line}: điện thoại`, 30),
          email: email(csvValue(row, columns, 'tenantEmail'), `Dòng ${line}: email`),
          cccd,
          issueDate,
          dob,
          gender: genderMap[genderInput],
          address: cleanText(csvValue(row, columns, 'tenantAddress'), `Dòng ${line}: địa chỉ`, 500, true)
        });
      }
    });
    return { format: 'csv', rooms: [...roomsByKey.values()] };
  }

  function normalizeTenant(input, label, makeId) {
    const fullName = cleanText(input?.fullName, `${label}: tên khách`, 200, true);
    const cccd = cleanText(input?.cccd, `${label}: CCCD`, 20, true);
    if (/[*•]/.test(cccd)) throw new ImportError('IMPORT_MASKED_CCCD', `${label}: CCCD đang bị che, cần dùng bản export đầy đủ`);
    return {
      id: cleanText(input?.id, `${label}: ID`, 200) || makeId(),
      fullName,
      phone: cleanText(input?.phone, `${label}: điện thoại`, 30),
      email: email(input?.email, `${label}: email`),
      cccd,
      issueDate: date(input?.issueDate, `${label}: ngày cấp`),
      dob: date(input?.dob, `${label}: ngày sinh`),
      gender: ['Nam', 'Nữ', 'Khác'].includes(input?.gender) ? input.gender : 'Khác',
      address: cleanText(input?.address, `${label}: địa chỉ`, 500, true),
      dataNoticeAcknowledged: false
    };
  }

  function normalizeRoom(input, index, makeId, effectivePeriod) {
    const label = `Phòng ${index + 1}`;
    const waterType = input?.waterType === 'khối' ? 'khối' : 'người';
    const room = {
      id: cleanText(input?.id, `${label}: ID`, 200) || makeId(),
      propertyId: Number.isSafeInteger(Number(input?.propertyId)) && Number(input.propertyId) > 0
        ? Number(input.propertyId)
        : null,
      propertyName: cleanText(input?.propertyName, `${label}: khu`, 200),
      name: cleanText(input?.name, `${label}: tên`, 200, true),
      rentStartDate: date(input?.rentStartDate, `${label}: ngày bắt đầu`),
      rentPrice: integer(input?.rentPrice, `${label}: tiền thuê`),
      electricRate: integer(input?.electricRate, `${label}: giá điện`, 3500),
      waterRate: integer(input?.waterRate, `${label}: giá nước`, waterType === 'khối' ? 20000 : 60000),
      waterType,
      peopleCount: integer(input?.peopleCount, `${label}: số người`, 1),
      trashFee: integer(input?.trashFee, `${label}: phí rác`),
      wifiFee: integer(input?.wifiFee, `${label}: phí wifi`),
      manageFee: integer(input?.manageFee, `${label}: phí quản lý`),
      electricPrev: integer(input?.electricPrev, `${label}: điện đầu`),
      waterPrev: integer(input?.waterPrev, `${label}: nước đầu`),
      notes: cleanText(input?.notes, `${label}: ghi chú`, 1000),
      tenants: (Array.isArray(input?.tenants) ? input.tenants : []).map((tenant, tenantIndex) => (
        normalizeTenant(tenant, `${label}, khách ${tenantIndex + 1}`, makeId)
      )),
      rateHistory: []
    };
    const sourceHistory = Array.isArray(input?.rateHistory) ? input.rateHistory : [];
    room.rateHistory = sourceHistory.length > 0
      ? sourceHistory.map((rate, rateIndex) => ({
        effectiveFrom: period(rate?.effectiveFrom, `${label}, biểu phí ${rateIndex + 1}`),
        rentPrice: integer(rate?.rentPrice, `${label}, biểu phí ${rateIndex + 1}: tiền thuê`),
        electricRate: integer(rate?.electricRate, `${label}, biểu phí ${rateIndex + 1}: giá điện`),
        waterRate: integer(rate?.waterRate, `${label}, biểu phí ${rateIndex + 1}: giá nước`),
        trashFee: integer(rate?.trashFee, `${label}, biểu phí ${rateIndex + 1}: phí rác`),
        wifiFee: integer(rate?.wifiFee, `${label}, biểu phí ${rateIndex + 1}: phí wifi`),
        manageFee: integer(rate?.manageFee, `${label}, biểu phí ${rateIndex + 1}: phí quản lý`)
      }))
      : [{
        effectiveFrom: effectivePeriod,
        rentPrice: room.rentPrice,
        electricRate: room.electricRate,
        waterRate: room.waterRate,
        trashFee: room.trashFee,
        wifiFee: room.wifiFee,
        manageFee: room.manageFee
      }];
    return room;
  }

  function parseJson(text) {
    let input;
    try { input = JSON.parse(String(text || '')); } catch (_) {
      throw new ImportError('IMPORT_INVALID_JSON', 'File JSON không đúng định dạng');
    }
    if (!input || !Array.isArray(input.rooms)) {
      throw new ImportError('IMPORT_INVALID_JSON_STATE', 'File JSON phải có danh sách rooms');
    }
    return { ...input, format: 'json' };
  }

  function normalizeImport(input, options = {}) {
    const makeId = typeof options.makeId === 'function' ? options.makeId : (() => {
      throw new ImportError('IMPORT_ID_GENERATOR_MISSING', 'Không tạo được ID dữ liệu nhập');
    });
    const effectivePeriod = period(options.currentPeriod, 'Tháng nhập');
    if (!Array.isArray(input?.rooms) || input.rooms.length < 1) {
      throw new ImportError('IMPORT_NO_ROOMS', 'File chưa có phòng nào');
    }
    if (input.rooms.length > MAX_ROOMS) {
      throw new ImportError('IMPORT_TOO_MANY_ROOMS', `Mỗi lần chỉ nhập tối đa ${MAX_ROOMS} phòng`);
    }
    const rooms = input.rooms.map((room, index) => normalizeRoom(room, index, makeId, effectivePeriod));
    const ids = new Set();
    const tenantIds = new Set();
    let tenantCount = 0;
    rooms.forEach((room) => {
      if (ids.has(room.id)) throw new ImportError('IMPORT_DUPLICATE_ROOM_ID', `ID phòng bị trùng: ${room.id}`);
      ids.add(room.id);
      room.tenants.forEach((tenant) => {
        tenantCount += 1;
        if (tenantIds.has(tenant.id)) throw new ImportError('IMPORT_DUPLICATE_TENANT_ID', `ID khách bị trùng: ${tenant.id}`);
        tenantIds.add(tenant.id);
      });
    });
    if (tenantCount > MAX_TENANTS) {
      throw new ImportError('IMPORT_TOO_MANY_TENANTS', `Mỗi lần chỉ nhập tối đa ${MAX_TENANTS} khách`);
    }
    const properties = (Array.isArray(input.properties) ? input.properties : [])
      .map((property, index) => ({
        id: Number(property?.id),
        name: cleanText(property?.name, `Khu ${index + 1}: tên`, 200, true),
        isDefault: property?.isDefault === true
      }))
      .filter((property) => Number.isSafeInteger(property.id) && property.id > 0);
    return {
      format: input.format || 'json',
      properties,
      rooms,
      billingData: input.billingData && typeof input.billingData === 'object' ? input.billingData : {},
      expenses: input.expenses && typeof input.expenses === 'object' ? input.expenses : {},
      settings: input.settings && typeof input.settings === 'object' ? input.settings : null,
      history: Array.isArray(input.history) ? input.history : [],
      theme: ['light', 'dark', 'system'].includes(input.theme) ? input.theme : null,
      summary: {
        roomCount: rooms.length,
        tenantCount,
        propertyNames: [...new Set([
          ...properties.map((property) => property.name),
          ...rooms.map((room) => room.propertyName).filter(Boolean)
        ])]
      }
    };
  }

  function remapBillingData(source, roomIdMap) {
    const output = {};
    Object.entries(source || {}).forEach(([periodKey, entries]) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey) || !entries || typeof entries !== 'object') return;
      const mapped = {};
      Object.entries(entries).forEach(([roomId, value]) => {
        const nextRoomId = roomIdMap.get(roomId);
        if (nextRoomId) mapped[nextRoomId] = value;
      });
      if (Object.keys(mapped).length > 0) output[periodKey] = mapped;
    });
    return output;
  }

  function mergeImport(current, imported, makeId) {
    const existingNames = new Set((current.rooms || []).map((room) => (
      `${Number(room.propertyId) || 0}\u0000${String(room.name || '').trim().toLocaleLowerCase('vi')}`
    )));
    const roomIdMap = new Map();
    const rooms = imported.rooms.map((room) => {
      const propertyId = Number(room.propertyId) || 0;
      const nameKey = `${propertyId}\u0000${room.name.toLocaleLowerCase('vi')}`;
      if (existingNames.has(nameKey)) {
        throw new ImportError('IMPORT_DUPLICATE_ROOM_NAME', `Phòng “${room.name}” đã có trong khu đích`);
      }
      existingNames.add(nameKey);
      const id = makeId();
      roomIdMap.set(room.id, id);
      return {
        ...room,
        id,
        tenants: room.tenants.map((tenant) => ({ ...tenant, id: makeId() }))
      };
    });
    const importedBilling = remapBillingData(imported.billingData, roomIdMap);
    const billingData = { ...(current.billingData || {}) };
    Object.entries(importedBilling).forEach(([periodKey, entries]) => {
      billingData[periodKey] = { ...(billingData[periodKey] || {}), ...entries };
    });
    return {
      ...current,
      rooms: [...(current.rooms || []), ...rooms],
      billingData
    };
  }

  function replaceImport(current, imported) {
    return {
      ...current,
      rooms: imported.rooms,
      billingData: imported.billingData,
      expenses: imported.expenses,
      settings: imported.settings || current.settings,
      history: imported.history,
      theme: imported.theme || current.theme
    };
  }

  function csvTemplate() {
    const headers = [
      'khu', 'phong', 'tien_thue', 'gia_dien', 'kieu_nuoc', 'gia_nuoc',
      'so_nguoi', 'phi_rac', 'phi_wifi', 'phi_quan_ly', 'dien_dau', 'nuoc_dau',
      'ngay_bat_dau', 'ten_khach', 'dien_thoai', 'email', 'cccd', 'ngay_cap',
      'ngay_sinh', 'gioi_tinh', 'dia_chi'
    ];
    const example = ['', 'P.101', '2500000', '3500', 'người', '60000', '1', '50000', '50000', '0', '0', '0', '', '', '', '', '', '', '', '', ''];
    return `\uFEFF${headers.join(',')}\r\n${example.join(',')}\r\n`;
  }

  return {
    ImportError,
    MAX_ROOMS,
    MAX_TENANTS,
    csvTemplate,
    mergeImport,
    normalizeImport,
    parseCsv,
    parseJson,
    replaceImport
  };
});
