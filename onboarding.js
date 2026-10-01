/* Tiến độ bắt đầu được suy ra từ dữ liệu workspace, không lưu cờ riêng. */
(function (global) {
  'use strict';

  const hasNumber = value => value !== '' && value !== null && value !== undefined
    && Number.isFinite(Number(value));

  function hasCompleteReading(rooms, billingData) {
    const roomById = new Map((rooms || []).map(room => [String(room.id), room]));
    return Object.values(billingData || {}).some(byRoom => Object.entries(byRoom || {}).some(([roomId, record]) => {
      const room = roomById.get(String(roomId));
      if (!room || !record || !hasNumber(record.electricNew)) return false;
      return room.waterType === 'khối'
        ? hasNumber(record.waterNew)
        : hasNumber(record.waterUnits) || (room.waterType === 'người' && Number(room.peopleCount) > 0);
    }));
  }

  function getProgress({ properties = [], rooms = [], billingData = {}, invoices = [],
    invoicesAvailable = false, history = [] } = {}) {
    const hasBill = invoices.length > 0 || history.some(entry => Array.isArray(entry.bills) && entry.bills.length > 0);
    const hasRoom = rooms.length > 0 || hasBill;
    const hasReading = hasCompleteReading(rooms, billingData) || hasBill;
    const steps = [
      { id: 'property', status: properties.length > 0 || hasBill ? 'done' : 'pending' },
      { id: 'room', status: hasRoom ? 'done' : 'pending' },
      { id: 'reading', status: hasReading ? 'done' : 'pending' },
      { id: 'bill', status: hasBill ? 'done' : hasReading && !invoicesAvailable ? 'unknown' : 'pending' }
    ];
    return {
      steps,
      completed: steps.filter(step => step.status === 'done').length,
      next: steps.find(step => step.status !== 'done')?.id || null
    };
  }

  global.Onboarding = { getProgress };
  if (typeof module !== 'undefined') module.exports = { getProgress };
})(typeof window === 'undefined' ? globalThis : window);
