# Nhật ký quyết định kỹ thuật và nghiệp vụ

Tài liệu này giữ “mindset” có thể kiểm chứng của dự án dưới dạng quyết định,
không lưu suy luận nội bộ hoặc transcript phiên chat. Mục đã phát hành không bị
xóa; khi đổi hướng, thêm quyết định mới có dòng `Thay thế:` trỏ tới mục cũ.

## D-001 — Dữ liệu luôn thuộc một tài khoản

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** API nghiệp vụ lấy chủ sở hữu từ phiên (`req.userId`), mọi truy
  vấn và quan hệ database scope theo `user_id`; client không được chọn owner.
- **Lý do:** Lỗi lẫn phiên/tài khoản từng có khả năng khiến state của người này
  hiển thị hoặc ghi vào người khác. Đây là rủi ro mất dữ liệu nghiêm trọng.
- **Hệ quả:** Mọi route/bảng mới phải có test ownership/cross-account; khóa ngoại
  ghép được ưu tiên khi quan hệ đi qua phòng.

## D-002 — Cookie phiên và account context chống ghi chéo tab

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** JWT chỉ ở cookie `HttpOnly`; frontend xác minh account context
  trước khi nạp/lưu state và vô hiệu hóa dữ liệu cũ khi tài khoản đổi.
- **Lý do:** Nhiều tài khoản đăng nhập trên cùng browser từng reload lẫn nhau.
- **Hệ quả:** Không khôi phục token/local state cũ để “đơn giản hóa” đăng nhập;
  mọi thay đổi auth phải chạy test `account-session-isolation` và cookie.

## D-003 — Giá có mốc hiệu lực, chứng từ là snapshot

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Giá phòng, điện, nước và phí lưu theo `effectiveFrom`; hóa đơn
  và hợp đồng lưu snapshot tại thời điểm phát hành/tạo.
- **Lý do:** Giá từ tháng 2 hoặc tháng 4 không được làm thay đổi tháng trước hay
  chứng từ đã chốt.
- **Hệ quả:** Không cập nhật ngược mọi kỳ khi sửa giá. Tháng bắt đầu thuê tính
  tiền theo ngày và tính cả ngày vào ở: ngày 10/08 là 22/31 ngày.

## D-004 — Sổ tài chính append-only

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Thanh toán, cọc, hoàn cọc, khấu trừ và sửa/hủy giao dịch dùng
  bút toán/điều chỉnh có dấu vết; webhook và delivery có khóa idempotency.
- **Lý do:** Xóa/sửa trực tiếp làm mất khả năng đối soát và có thể ghi tiền hai
  lần khi request được gửi lại.
- **Hệ quả:** Hạng mục đặt cọc/biên bản sắp tới phải tái sử dụng
  `tenant_deposit_ledger`, không tạo cột số dư hoặc ledger cạnh tranh.

## D-005 — CCCD che mặc định và mọi lần mở đều có trách nhiệm

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** State/UI chỉ nhận CCCD đã che. Reveal/export bản đầy đủ kiểm tra
  ownership, yêu cầu lý do hỗ trợ hoặc xác thực mật khẩu theo luồng, trả
  `no-store` và ghi audit tối giản.
- **Lý do:** Admin không phải “người kiểm duyệt” tự do; admin chỉ hỗ trợ kỹ thuật
  và chính người phụ trách dữ liệu phải có thể rà soát lý do truy cập.
- **Hệ quả:** Không đưa CCCD vào log, message lỗi, handoff hoặc fixture chứa dữ
  liệu thật.

## D-006 — Migration tiến tới và runtime least privilege

- **Trạng thái:** Đang áp dụng; thu hồi role cũ còn chờ xác minh deployment.
- **Quyết định:** `server/schema.sql` là schema đầy đủ, mỗi thay đổi đã phát hành
  có migration tiến tới chạy lại an toàn; app dùng `tro_bill_runtime_sql` chỉ có
  quyền cần thiết, backup dùng role chỉ đọc riêng.
- **Lý do:** Serverless instance không được có quyền DDL/superuser và deploy mới
  không được khởi động trước khi schema cần thiết sẵn sàng.
- **Hệ quả:** Cập nhật grants trong cùng migration/schema, staging trước
  production; không sửa migration cũ để che lịch sử.

## D-007 — Chu kỳ hợp đồng không đổi chu kỳ lập hóa đơn vận hành

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Hợp đồng có thể ghi thanh toán 1/3/6/12 tháng mỗi kỳ, nhưng hóa
  đơn TrọBill vẫn được lập theo tháng.
- **Lý do:** Chu kỳ hợp đồng mô tả nghĩa vụ hai bên; thay cơ chế billing hiện hữu
  sẽ tác động công nợ, điện nước và nhắc nợ ngoài phạm vi tính năng hợp đồng.
- **Hệ quả:** Không tự gộp hóa đơn nhiều tháng chỉ vì hợp đồng có chu kỳ 3 tháng.

## D-008 — Email/cron retry an toàn và ưu tiên kênh miễn phí

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Email hiện ưu tiên Brevo Free; Web Share dùng cho Zalo/ứng dụng.
  Cron/delivery giới hạn batch, chống gửi trùng và chỉ retry lỗi tạm thời.
- **Lý do:** Giữ chi phí pilot thấp nhưng không hy sinh tính đúng/idempotency.
- **Hệ quả:** SMS/Zalo API trả phí sau này là add-on minh bạch, không tự gộp vào
  subscription.

## D-009 — Tài liệu hợp đồng phải được kiểm tra bằng PDF thật

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Mẫu HTML bám nội dung DOCX được cung cấp; print media phải bỏ
  `position: fixed`/khóa overflow của modal và cho nội dung chảy qua nhiều trang.
- **Lý do:** Preview HTML đúng vẫn có thể in 1/1 trang và cắt toàn bộ nội dung sau
  viewport.
- **Hệ quả:** Mọi sửa CSS/template hợp đồng phải tạo PDF, đếm trang và kiểm tra
  trực quan trang đầu, giữa và cuối.

## D-010 — Context của agent nằm trong Git, không nằm trong một cuộc chat

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Quy tắc ở `AGENTS.md`, trạng thái sống ở `AI_HANDOFF.md`, quyết
  định bền vững ở tài liệu này; `CLAUDE.md` nhập lại cùng nguồn thay vì sao chép.
- **Lý do:** Transcript dài chứa giả định/lối thử đã bỏ và chỉ agent gốc nhìn
  thấy; Git cho mọi agent cùng xem phiên bản, diff, review và rollback.
- **Hệ quả:** Agent kết thúc tính năng phải cập nhật handoff trong commit cuối;
  không lưu chain-of-thought, secret hoặc dữ liệu khách hàng để “giữ context”.
