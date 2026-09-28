'use strict';

// Khách chưa có hợp đồng (dữ liệu cũ/nhập tay) vẫn được xem là đang ở.
// Khi đã có hợp đồng kết thúc, chỉ hợp đồng active đúng phòng mới làm khách
// được tính là đang ở; hồ sơ tenant được giữ lại để tra cứu lịch sử.
function currentTenantPredicate(alias) {
  if (!['tenant', 'occupant'].includes(alias)) throw new Error('Alias khách thuê không hợp lệ');
  return `(EXISTS (
    SELECT 1 FROM rental_contracts current_contract
    WHERE current_contract.user_id=${alias}.user_id
      AND current_contract.tenant_id=${alias}.id
      AND current_contract.room_id=${alias}.room_id
      AND current_contract.status='active'
  ) OR NOT EXISTS (
    SELECT 1 FROM rental_contracts ended_contract
    WHERE ended_contract.user_id=${alias}.user_id
      AND ended_contract.tenant_id=${alias}.id
      AND ended_contract.status='ended'
  ))`;
}

module.exports = { currentTenantPredicate };
