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

## D-011 — Biên bản bàn giao là snapshot bất biến của hợp đồng và sổ cọc

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Mỗi hợp đồng có tối đa một biên bản nhận phòng và một biên bản
  trả phòng. Biên bản lưu snapshot bên thuê/phòng, chỉ số, chìa khóa, hiện trạng,
  tài sản, tiền cọc theo hợp đồng và số dư sổ cọc tại thời điểm xác nhận; runtime
  chỉ được SELECT/INSERT, không được UPDATE/DELETE.
- **Lý do:** Chứng từ đã ký phải phản ánh đúng thời điểm bàn giao, trong khi giao
  dịch thu/khấu trừ/hoàn cọc có thể tiếp tục phát sinh độc lập sau đó.
- **Hệ quả:** Không thêm cột số dư cọc mới và không sửa biên bản để khớp số dư
  hiện tại. Mọi điều chỉnh tiền đi qua `tenant_deposit_transactions`; chuyển/trả
  phòng sau này phải giữ nguyên biên bản cũ và tạo nghiệp vụ tiếp nối có audit.

## D-012 — Chuyển phòng tạo hợp đồng mới và vòng đời có nhật ký bất biến

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Mỗi phòng chỉ có một lượt giữ chỗ active. Chuyển phòng kết thúc
  hợp đồng cũ, chuyển tenant sang phòng đích và tạo hợp đồng active mới trong một
  transaction; không sửa `room_id` của hợp đồng cũ. Trả/chuyển phòng yêu cầu biên
  bản `check_out`. Các mốc giữ chỗ, chuyển và trả được ghi vào event append-only.
- **Lý do:** Sửa phòng trực tiếp trên hợp đồng làm sai snapshot pháp lý, lịch sử
  giá và liên kết chứng từ; thao tác rời rạc có thể để khách/hợp đồng ở trạng thái
  nửa chừng khi một bước thất bại.
- **Hệ quả:** Phòng đích phải không có hợp đồng hoặc giữ chỗ active. Giữ chỗ chỉ
  được chuyển thành hợp đồng khi client gửi đúng `reservationId`; bill cuối cùng
  và trạng thái phòng sẽ dựa trên event/hợp đồng thay vì xóa lịch sử cũ.

## D-013 — Quyết toán cuối là snapshot bất biến trên invoice và ledger hiện có

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Chỉ chốt quyết toán sau event `checked_out` và biên bản
  `check_out` cùng ngày. Giữ nguyên `issued_total_vnd`/`detail_snapshot`, ghi tổng
  và chi tiết sau quyết toán vào các cột `final_*` chỉ một lần. Tiền phòng tính từ
  ngày bắt đầu của hợp đồng (nếu cùng tháng) đến ngày trả phòng, bao gồm cả hai
  đầu ngày. Tiền cọc bù nợ tạo receipt/allocation và giao dịch khấu trừ; cọc còn
  lại tạo giao dịch hoàn, tất cả trong cùng transaction.
- **Lý do:** Sửa hóa đơn gốc làm mất chứng từ đã phát hành; tạo một nguồn công nợ
  hoặc số dư cọc khác sẽ khiến đối soát QR, nhắc nợ, biên nhận và sổ cọc lệch nhau.
- **Hệ quả:** Mọi luồng đọc số tiền phải dùng
  `COALESCE(final_total_vnd, issued_total_vnd)`. Final settlement là append-only,
  idempotent theo hợp đồng và không thể chạy nếu chỉ số điện/nước khác biên bản.
  Hoàn tiền thuê do trả thừa được lưu riêng trong snapshot quyết toán; việc chi
  tiền thực tế vẫn là nghiệp vụ vận hành cần chủ trọ xác nhận ngoài hệ thống.

## D-014 — Trạng thái phòng là dữ liệu suy ra ở server

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Không lưu một cột trạng thái phòng cho cả bốn trạng thái.
  **Đang thuê** được suy ra từ khách hiện có hoặc hợp đồng active (để tương thích
  dữ liệu trước khi có hợp đồng điện tử), **giữ chỗ** từ reservation active,
  **đang sửa** từ `room_maintenance_periods` active, còn lại là **trống**. Server
  trả trạng thái tổng hợp và đánh dấu `conflict` nếu dữ liệu cũ có nhiều nguồn
  cùng hoạt động.
- **Lý do:** Một cột do client tự cập nhật có thể lệch hợp đồng, giữ chỗ hoặc
  danh sách khách; thao tác đồng thời còn có thể ghi đè trạng thái đúng.
- **Hệ quả:** Tạo giữ chỗ, kích hoạt/chuyển hợp đồng, bắt đầu sửa và thay state
  đều phải khóa phòng rồi kiểm tra mọi nguồn xung đột trong cùng transaction.
  Sửa chữa có lịch sử riêng; hai mốc bắt đầu/hoàn thành được ghi vào event
  append-only. UI không được tự suy trạng thái từ các cache chưa tải.
