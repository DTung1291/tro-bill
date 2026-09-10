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

- **Trạng thái:** Hoàn tất ngày 07/09/2026 trên staging và production.
- **Quyết định:** `server/schema.sql` là schema đầy đủ, mỗi thay đổi đã phát hành
  có migration tiến tới chạy lại an toàn; app dùng `tro_bill_runtime_sql` chỉ có
  quyền cần thiết, backup dùng role chỉ đọc riêng.
- **Lý do:** Serverless instance không được có quyền DDL/superuser và deploy mới
  không được khởi động trước khi schema cần thiết sẵn sàng.
- **Hệ quả:** Cập nhật grants trong cùng migration/schema, staging trước
  production; không sửa migration cũ để che lịch sử. Role quyền SQL cũ được giữ
  `NOLOGIN` làm mẫu đồng bộ grant; role Console/API kế thừa `neon_superuser` được
  xóa sau audit ownership/session. Migration phải tự dừng nếu còn session đang
  dùng role cũ.

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

## D-015 — Khóa đồng thời phải giữ nguyên least privilege và thứ tự snapshot

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Ledger append-only không được cấp `UPDATE` chỉ để dùng row
  lock; các thao tác cọc dùng advisory lock ổn định theo idempotency, giao dịch
  hoàn tác và tài khoản số dư. Vì `PUT /api/state` thay toàn bộ snapshot, frontend
  phải xếp hàng các request và server phải khóa tuần tự theo `user_id` trước mọi
  row lock.
- **Lý do:** PostgreSQL yêu cầu quyền `UPDATE` cho `SELECT ... FOR UPDATE`, từng
  làm API cọc lỗi `42501`. Nhiều autosave chạy chồng vừa có thể deadlock vừa cho
  phép snapshot cũ commit sau và ghi đè snapshot mới.
- **Hệ quả:** Không sửa lỗi khóa bằng cách nới quyền trên sổ tài chính. Mọi đường
  ghi cọc mới phải dùng cùng khóa `deposit-balance:<user>:<account>` với trigger;
  mọi thay đổi cơ chế autosave phải giữ kiểm tra account context, revision và hai
  lớp tuần tự client/server.

## D-016 — Khu/tòa nhà là thực thể ổn định ngoài snapshot state

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Khu/tòa nhà nằm trong bảng `properties` có CRUD riêng; mỗi
  phòng giữ `property_id` có ownership FK cùng `user_id`. `PUT /api/state` chỉ
  thay dữ liệu phòng và tự dùng khu mặc định khi client/import cũ thiếu
  `propertyId`, không xóa hoặc tạo lại danh sách khu.
- **Lý do:** Khu là cấu hình dài hạn, trong khi state cũ xóa/ghi lại toàn bộ
  phòng. Đưa khu vào snapshot ghi toàn phần sẽ cho tab cũ vô tình xóa khu hoặc
  tạo tham chiếu chéo tài khoản.
- **Hệ quả:** Mỗi tài khoản luôn có “Khu trọ chính”; khu mặc định không được xóa,
  khu còn phòng phải chuyển hết phòng trước khi xóa. Migration có trigger gắn
  khu mặc định cho server cũ để rollout schema trước code không làm gián đoạn
  ghi dữ liệu. Backup nhiều khu phải ánh xạ ID theo tài khoản đích trước khi ghi
  phòng; địa chỉ hợp đồng/biên bản lấy mặc định từ khu của phòng.

## D-017 — Vai trò tài khoản tách khỏi quyền truy cập dữ liệu

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Mỗi tài khoản vận hành có một membership `owner` bất biến và
  có thể gán tài khoản TrọBill đã xác minh vào một trong ba vai trò `manager`,
  `accountant`, `meter_reader`. Dữ liệu nghiệp vụ vẫn thuộc `account_user_id`
  của chủ sở hữu; membership chỉ mô tả vai trò và chưa tự cấp quyền đọc/ghi dữ
  liệu của chủ. Quyền đó chỉ được kích hoạt khi có phạm vi khu hoặc nghiệp vụ
  được giao ở hạng mục phân quyền tiếp theo.
- **Lý do:** Cho nhân viên truy cập toàn bộ dữ liệu ngay khi gán vai trò sẽ vượt
  quá nguyên tắc least privilege và làm mục “chỉ xem khu/nghiệp vụ được giao”
  không còn chốt chặn an toàn.
- **Hệ quả:** Chỉ chủ sở hữu quản lý danh sách vai trò; không thể sửa/xóa owner.
  Thêm hoặc đổi vai trò tuân theo gói và hạn mức nhân viên, nhưng thu hồi thành
  viên luôn được phép kể cả khi gói hết hạn/hạ cấp. Mọi endpoint dữ liệu dành
  cho nhân viên sau này phải xác minh membership cùng assignment cụ thể, không
  được thay `req.userId` bằng account chủ chỉ dựa trên role.

## D-018 — Workspace nhân viên tách actor khỏi phạm vi dữ liệu hiệu lực

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Cookie và `X-Trobill-Account-Context` luôn xác định tài khoản
  thật đang đăng nhập (`actor`). Client chỉ được chọn tài khoản làm việc bằng
  `X-Trobill-Workspace-Account-Id`; server phải xác minh membership, vai trò,
  ít nhất một khu và từng nghiệp vụ được giao trước khi đổi phạm vi truy vấn sang
  `account_user_id` của chủ. Workspace nhân viên hiện chỉ đọc; `PUT /api/state`
  luôn bị chặn vì endpoint này thay toàn bộ snapshot.
- **Lý do:** Dùng workspace như danh tính đăng nhập sẽ tái tạo lỗi lẫn tài khoản
  giữa các tab. Cho nhân viên ghi một snapshot đã lọc có thể xóa dữ liệu ở những
  khu họ không nhìn thấy.
- **Hệ quả:** Mọi dữ liệu trả về cho nhân viên phải vừa lọc theo khu, vừa lược bỏ
  trường ngoài nghiệp vụ. Các quyền ghi sau này cần endpoint hẹp theo từng tài
  nguyên, kiểm tra lại khu/nghiệp vụ trong transaction; không được mở ghi bằng
  cách bỏ chốt read-only của state.

## D-019 — Audit nghiệp vụ dùng chung nhật ký dữ liệu và tách actor khỏi subject

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Thay đổi biểu phí, nguồn/phát hành hóa đơn, ledger tiền
  phòng/cọc, đối soát ngân hàng và vòng đời hợp đồng được ghi vào
  `data_audit_logs` trong cùng transaction với nghiệp vụ. Nhật ký phân biệt
  `actor_user_id` là người thật đang thao tác với `subject_user_id` là tài khoản
  sở hữu dữ liệu; tác vụ tự động để actor rỗng và hiển thị là “Hệ thống”. Audit
  chỉ lưu loại thao tác, tài nguyên, tên trường đã đổi và mục đích ngắn, không
  lưu giá trị trước/sau hoặc snapshot dữ liệu nhạy cảm.
- **Lý do:** Tạo thêm một bảng audit tài chính/hợp đồng sẽ phân mảnh lịch sử và
  chính sách lưu giữ. Ghi log sau khi commit có thể làm nghiệp vụ thành công
  nhưng mất dấu vết; coi workspace là actor sẽ tiếp tục gây nhầm tài khoản khi
  nhân viên làm việc thay chủ.
- **Hệ quả:** Mọi đường ghi mới trong bốn nhóm nghiệp vụ phải dùng
  `requestDataAuditEntry` và ghi trước `COMMIT`; request idempotent phát lại
  không được tạo log mới. `PUT /api/state` phải so sánh dữ liệu hiện có với
  snapshot gửi lên để bỏ qua no-op. Trường audit mới phải được allowlist và nhật
  ký tiếp tục áp dụng retention 365 ngày.

## D-020 — Chi phí theo khu không được tự phân bổ từ dữ liệu chung

- **Trạng thái:** Đã phát hành production ngày 01/09/2026.
- **Quyết định:** `expense_entries.property_id` là quan hệ nullable có ownership
  FK cùng `user_id`. `NULL` nghĩa là chi phí chung của toàn tài khoản; dashboard
  “Tất cả khu” tính cả chi phí chung và chi phí đã gắn khu, còn dashboard một khu
  chỉ tính khoản gắn trực tiếp vào khu đó. Dữ liệu cũ giữ `NULL`, không tự gán
  sang khu mặc định và không tự chia tỷ lệ theo số phòng/doanh thu.
- **Lý do:** Hệ thống không có căn cứ nghiệp vụ để biết chi phí điện, sửa chữa
  hoặc vận hành cũ thực sự thuộc khu nào. Tự gán hoặc phân bổ sẽ làm báo cáo lợi
  nhuận từng khu trông chính xác nhưng sai số liệu gốc.
- **Hệ quả:** Form chi phí phải cho chọn một khu hoặc “Chi phí chung” và giải
  thích phạm vi tính. Khu còn khoản chi đã gắn không được xóa cho đến khi khoản
  chi được chuyển khu hoặc đưa về chung. Nhân viên chỉ nhận khoản chi thuộc khu
  được giao; chi phí chung chỉ được trả về khi họ được giao toàn bộ khu của tài
  khoản. Nếu sau này cần phân bổ chi phí chung, phải thêm quy tắc và bút toán
  phân bổ có thể kiểm tra, không thay đổi âm thầm ý nghĩa của `NULL`.

## D-021 — Tài khoản nhận tiền là danh mục dùng chung, khu chỉ giữ tham chiếu

- **Trạng thái:** Đã phát hành production từ 01/09/2026.
- **Quyết định:** Mỗi chủ trọ có danh mục `rent_bank_accounts`, đúng một tài
  khoản mặc định và tối đa 20 tài khoản. `properties.rent_bank_account_id` có
  thể trỏ tới một tài khoản cùng chủ; `NULL` nghĩa là kế thừa tài khoản mặc
  định. Một tài khoản được phép dùng cho nhiều khu. Kênh SePay và giao dịch ngân
  hàng giữ `bank_account_id` để mỗi tài khoản có webhook riêng và chỉ đối soát
  với hóa đơn dùng đúng tài khoản đó. Ba trường `settings.bank_*` tiếp tục phản
  chiếu tài khoản mặc định trong giai đoạn tương thích.
- **Lý do:** Sao chép đầy đủ thông tin ngân hàng vào từng khu tạo dữ liệu trùng,
  khó đổi một tài khoản dùng chung và không mô hình hóa được nhiều webhook
  SePay. Chỉ dựa vào số tài khoản trong giao dịch cũng không đủ khóa ownership
  hoặc ngăn ghép thủ công sang hóa đơn của khu khác.
- **Hệ quả:** Đổi tài khoản mặc định phải đồng bộ cấu hình cũ trong cùng
  transaction. Không được xóa tài khoản đang là mặc định, đang gán cho khu hoặc
  đã có kênh/lịch sử đối soát. QR, email, link hóa đơn, hợp đồng và tin nhắn lấy
  tài khoản hiệu lực theo khu rồi mới fallback mặc định. Giao dịch có
  `bank_account_id` chỉ được tự động hoặc thủ công ghép với invoice có cùng tài
  khoản hiệu lực; giao dịch legacy chưa có ID vẫn giữ luồng tương thích.

## D-022 — Tài sản phòng dùng lưu trữ mềm và không giữ FK trực tiếp tới snapshot phòng

- **Trạng thái:** Đã phát hành production ngày 01/09/2026.
- **Quyết định:** Mỗi tài sản có mã ổn định, phòng hiện tại và snapshot tên
  phòng. Tài sản không có thao tác xóa vật lý; ngừng dùng phải lưu lý do và thời
  điểm, sau đó có thể khôi phục vào một phòng còn tồn tại. Không tạo foreign key
  trực tiếp từ `room_assets.room_id` sang `rooms` vì endpoint state cũ thay toàn
  bộ các row phòng. Thay vào đó mọi đường ghi khóa cùng advisory lock với state,
  xác minh ownership trong transaction và `PUT /state` chặn xóa phòng còn tài
  sản hoạt động.
- **Lý do:** Xóa tài sản làm mất lịch sử bàn giao và kiểm kê. Foreign key trực
  tiếp sẽ làm cơ chế thay snapshot phòng hiện tại lỗi hoặc buộc cascade ngoài ý
  muốn dù ID phòng logic không đổi.
- **Hệ quả:** Tài sản đã lưu trữ vẫn giữ tên phòng cuối để xuất dữ liệu. Chỉ chủ
  tài khoản được ghi; nhân viên có nghiệp vụ phòng chỉ đọc tài sản thuộc khu đã
  giao. Danh mục tài sản đang hoạt động là nguồn mặc định cho biên bản bàn giao,
  nhưng biên bản đã xác nhận vẫn là snapshot bất biến.

## D-023 — Cổng báo sửa gắn với hợp đồng và không yêu cầu tài khoản khách thuê

- **Trạng thái:** Đã phát hành production ngày 05/09/2026.
- **Quyết định:** Mỗi cổng báo sửa gắn với đúng một hợp đồng đang hoạt động. Token
  có 256-bit entropy, chỉ lưu SHA-256, hết hạn tối đa 365 ngày và nằm trong URL
  fragment để không đi vào query/referrer; frontend xóa fragment ngay sau khi
  đọc. Tạo liên kết mới thu hồi liên kết cũ. Khách không cần tài khoản TrọBill,
  được gửi nhiều yêu cầu append-only bằng idempotency key và chỉ nhận lại phòng,
  mã hợp đồng, thời hạn cùng lịch sử yêu cầu của chính liên kết. Chỉ chủ workspace
  được tạo/thu hồi portal và đọc yêu cầu trong hồ sơ hợp đồng.
- **Lý do:** Ép khách thuê tạo tài khoản làm tăng ma sát cho một thao tác hỗ trợ
  ngắn, còn token ở query có thể lọt vào log hoặc referrer. Gắn portal với hợp
  đồng giúp link tự vô hiệu khi quan hệ thuê kết thúc và tránh nhầm phòng/người.
  Một request append-only giữ nguyên nội dung khách đã báo để việc xử lý sau này
  có dấu vết rõ ràng.
- **Hệ quả:** Public API không được trả tên, tenant ID, CCCD hoặc snapshot hồ sơ;
  không được ghi plaintext token hay nội dung mô tả vào audit. Phải rate-limit
  theo IP và token hash, dùng idempotency khi gửi, đồng thời giữ cookie cùng origin
  để tương thích Vercel Preview Protection nhưng tuyệt đối không phụ thuộc phiên
  TrọBill. Bước phân công/trạng thái tiếp theo cập nhật request qua endpoint hẹp,
  không mở quyền UPDATE bảng cho runtime chỉ để tiện thao tác.

## D-024 — Công việc sửa chữa khóa theo người được giao và khu hiện tại của phòng

- **Trạng thái:** Đang áp dụng từ 05/09/2026.
- **Quyết định:** Chỉ chủ tài khoản được giao hoặc thu hồi người xử lý. Người
  nhận việc phải là thành viên có đồng thời quyền khu hiện tại của phòng và
  nghiệp vụ `rooms`. Nhân viên chỉ đọc/cập nhật yêu cầu đang giao cho chính mình
  trong khu được phép; chỉ chủ tài khoản được hủy. Trạng thái đi theo chuỗi hữu
  hạn `new -> acknowledged -> in_progress -> resolved`, cho phép chủ hủy từ
  trạng thái chưa kết thúc và bắt buộc ghi chú khi hoàn tất/hủy.
- **Lý do:** Vai trò chung không chứng minh một nhân viên chịu trách nhiệm cho sự
  cố cụ thể. Khóa theo assignment, khu và nghiệp vụ ở mỗi request ngăn xem/sửa
  chéo khi đổi workspace hoặc khi quyền thành viên đã bị thu hồi.
- **Hệ quả:** Assignment hiện tại có thể thay đổi nhưng mỗi lần đổi người và đổi
  trạng thái phải tạo event append-only cùng audit trong transaction. Nội dung
  gốc khách gửi không được sửa. Nếu phòng chuyển khu, quyền xem công việc theo
  khu mới có hiệu lực ngay; assignment cũ không tự cấp lại quyền đã mất.

## D-025 — Chi phí sửa chữa dùng sổ chi phí hiện có và liên kết bất biến

- **Trạng thái:** Đã phát hành production ngày 06/09/2026.
- **Quyết định:** Khoản sửa chữa đã thanh toán được ghi trực tiếp vào
  `expense_entries` với category `maintenance`, đúng khu và kỳ của ngày trả tiền;
  không tạo thêm sổ tài chính song song. Dòng chi giữ FK ownership tới yêu cầu
  cùng snapshot mã yêu cầu/phòng. Chỉ owner được ghi qua endpoint hẹp có
  idempotency và audit; nhân viên xử lý không nhận số tiền trong response.
- **Lý do:** Một khoản chi nằm ở hai sổ sẽ làm dashboard/lợi nhuận lệch nhau và
  khó xác định nguồn đúng. Frontend cũ thay toàn bộ state nên một tab chưa tải
  khoản mới có thể vô tình xóa dữ liệu tài chính vừa ghi.
- **Hệ quả:** `PUT /api/state` không xóa hoặc ghi đè dòng còn liên kết với yêu
  cầu sửa chữa; endpoint ghi chi phí dùng cùng advisory lock với state. Giao
  diện chi phí hiển thị nguồn liên kết ở chế độ chỉ đọc, và thao tác chuyển tháng
  chỉ áp dụng cho khoản nhập thủ công vì kỳ của khoản sửa chữa phải theo ngày
  thanh toán thực tế.

## D-026 — Báo cáo tài chính tháng tách dòng tiền khỏi doanh thu dồn tích

- **Trạng thái:** Đã phát hành production ngày 06/09/2026.
- **Quyết định:** Doanh thu tháng là tổng giá trị hiệu lực của hóa đơn có kỳ đó.
  Thực thu là tổng bút toán `payment` và `reversal` phát sinh trong tháng theo
  `Asia/Ho_Chi_Minh`, không gồm payment method `deposit`; adjustment chỉ sửa số
  dư, không được coi là dòng tiền. Công nợ cuối tháng tính từng hóa đơn có kỳ
  không muộn hơn tháng báo cáo, trừ mọi bút toán đến hết tháng rồi chặn tại 0.
  Chi phí lấy khoản thực tế đã ghi đúng kỳ; lợi nhuận tiền mặt bằng thực thu trừ
  chi phí.
- **Lý do:** Lấy số tiền đã phân bổ cho hóa đơn của tháng làm thực thu sẽ bỏ sót
  tiền thu nợ cũ và ghi sai kỳ của khoản thu trễ. Cộng `prior_debt` từ mỗi hóa
  đơn vào báo cáo sẽ đếm cùng một khoản nợ nhiều lần. Tiền cọc chuyển sang thanh
  toán là chuyển loại số dư đã giữ từ trước, không phải tiền mới nhận trong
  tháng chốt hợp đồng.
- **Hệ quả:** Báo cáo lịch sử chốt giao dịch theo thời điểm cuối kỳ nhưng dùng
  giá trị hóa đơn hiệu lực hiện tại, kể cả snapshot chốt trả phòng. Mọi bộ lọc
  quý/năm/khu/phòng tiếp theo phải giữ nguyên định nghĩa năm chỉ số này. Staff
  chỉ được gọi báo cáo khi có nghiệp vụ `overview`, số liệu phải lọc theo khu;
  chi phí chung chỉ được trả khi staff được giao toàn bộ khu của tài khoản.

## D-027 — Bộ lọc báo cáo chỉ quy thuộc chi phí có liên kết trực tiếp

- **Trạng thái:** Đã phát hành production ngày 06/09/2026.
- **Quyết định:** Kỳ quý/năm là tổng các tháng dương lịch tương ứng; doanh thu,
  thực thu và chi phí lấy trong khoảng, còn công nợ được chốt tại cuối tháng cuối
  kỳ theo D-026. Lọc khu chỉ nhận hóa đơn/phòng thuộc khu và dòng chi có
  `property_id` đúng khu. Lọc phòng nhận hóa đơn/giao dịch theo room ID, nhưng
  chi phí chỉ nhận khoản sửa chữa có `maintenance_room_id_snapshot` đúng phòng.
  Chi phí chung hoặc chi phí khu không được tự chia xuống phòng.
- **Lý do:** Dữ liệu hiện có không lưu một quy tắc phân bổ chi phí chung đáng tin
  cậy. Tự chia theo số phòng hoặc doanh thu tạo con số lợi nhuận nhìn hợp lý nhưng
  không thể đối chiếu với chứng từ gốc.
- **Hệ quả:** UI phải giải thích phạm vi chi phí khi lọc. Nếu cần báo cáo lợi
  nhuận đầy đủ từng phòng, phải bổ sung bút toán/quy tắc phân bổ riêng có audit;
  không được âm thầm thay đổi truy vấn hiện tại. Staff vẫn cần nghiệp vụ
  `overview` và mọi khu/phòng phải nằm trong assignment của họ.

## D-028 — Cơ cấu hóa đơn phải đối soát, tiền cọc là dòng tiền riêng

- **Trạng thái:** Đã phát hành production ngày 06/09/2026.
- **Quyết định:** Cơ cấu doanh thu lấy snapshot chi tiết hiệu lực của mỗi hóa
  đơn. Tiền thuê, điện, nước và dịch vụ là các nhóm dương; điều chỉnh ròng bằng
  phụ thu cộng phí chậm trừ giảm giá. Nếu hóa đơn legacy không đủ chi tiết,
  phần chênh lệch được ghi rõ là chưa phân loại để tổng các nhóm ròng luôn bằng
  doanh thu hóa đơn. Giao dịch cọc được tổng hợp riêng thành thu, hoàn, khấu trừ
  và dòng tiền thuần; giao dịch đảo được phân loại theo bút toán gốc.
- **Lý do:** Cộng tiền cọc vào doanh thu hoặc thực thu hóa đơn sẽ đếm tiền giữ
  hộ như tiền bán dịch vụ. Khấu trừ cọc chỉ chuyển số dư đang giữ sang thanh
  toán/công nợ, không tạo tiền mặt mới. Ép dữ liệu hóa đơn cũ vào một nhóm bất kỳ
  sẽ làm báo cáo trông chi tiết nhưng không còn khả năng đối soát.
- **Hệ quả:** `deposit.netCashflowVnd` chỉ bằng tiền cọc thu trừ tiền cọc hoàn;
  khấu trừ vẫn hiển thị để kiểm toán nhưng không cộng vào dòng tiền thuần. Mọi
  bộ lọc kỳ/khu/phòng phải áp dụng đồng thời cho hóa đơn và tài khoản cọc trong
  đúng ownership/assignment. Không được bỏ nhóm chưa phân loại nếu chưa có quy
  trình backfill snapshot được kiểm chứng.

## D-029 — Lấp đầy tính theo ngày-phòng đã quan sát của danh sách phòng hiện tại

- **Trạng thái:** Đã phát hành production ngày 06/09/2026.
- **Quyết định:** Báo cáo chỉ tính từ đầu kỳ đến hết ngày hiện tại, không dự báo
  những ngày tương lai. Mỗi phòng-ngày nhận đúng một trạng thái theo ưu tiên có
  khách, giữ chỗ, đang sửa, rồi trống. Tỷ lệ lấp đầy bằng ngày-phòng có khách
  chia cho ngày-phòng có thể cho thuê; ngày sửa chữa bị loại khỏi mẫu số, còn
  ngày giữ chỗ vẫn là khả năng cho thuê đã được giữ và được trình bày riêng.
  Ngày nhận/trả phòng được tính bao gồm ngày phát sinh vì dữ liệu hiện chưa có
  thời điểm trong ngày.
- **Lý do:** Dùng toàn bộ số ngày của kỳ hiện tại sẽ biến ngày tương lai thành
  phòng trống và hạ sai tỷ lệ. Tính đồng thời nhiều trạng thái cho cùng ngày sẽ
  làm tổng ngày-phòng vượt sức chứa thực. Thời gian sửa chữa không phải hàng tồn
  có thể bán nên không phù hợp trong mẫu số lấp đầy.
- **Hệ quả:** Phạm vi phòng hiện dùng danh sách phòng còn tồn tại tại thời điểm
  chạy báo cáo; phòng đã xóa trong quá khứ chưa thể tái dựng cho tới khi có lịch
  sử inventory. Khách legacy thiếu ngày bắt đầu thuê được suy từ đầu kỳ và UI
  phải cảnh báo. Một ngày chuyển phòng có thể ghi nhận cả phòng nguồn và phòng
  đích đã được sử dụng vì chưa có timestamp để chia theo giờ; không được âm thầm
  đổi quy tắc này nếu chưa bổ sung dữ liệu chi tiết và migration tương ứng.

## D-030 — File kế toán là biểu diễn của cùng snapshot báo cáo đã lọc

- **Trạng thái:** Đã phát hành production ngày 07/09/2026.
- **Quyết định:** Excel và PDF được dựng từ chính object báo cáo đã trả cho bộ
  lọc hiện tại; frontend không query thêm hoặc tính lại doanh thu, thực thu,
  công nợ, chi phí, lợi nhuận hay lấp đầy. Excel dùng OOXML `.xlsx` không nén,
  giữ VND/tỷ lệ ở ô kiểu số và mọi text ở `inlineStr`; PDF dùng A4 ngang, cho
  phép bảng phòng chảy qua nhiều trang và lặp `thead`.
- **Lý do:** Một pipeline số liệu riêng cho file xuất dễ lệch định nghĩa tại
  D-026 đến D-029. CSV không giữ chắc kiểu số, nhiều sheet và có rủi ro công
  thức khi tên phòng/khu bắt đầu bằng ký tự đặc biệt. Bảng dài bị ép vào một
  trang sẽ làm mất nội dung giống lỗi hợp đồng trước đây.
- **Hệ quả:** Nút xuất chỉ bật khi snapshot của đúng cache key kỳ/khu/phòng đã
  tải xong. Workbook không dùng công thức từ dữ liệu người dùng và không cần
  thư viện bên thứ ba; PDF phải giữ quy tắc `table-header-group` và
  `break-inside: avoid-page`. File hiện chỉ gồm số liệu tài chính/vận hành đã
  được scope bởi quyền `overview`, không đưa tên hay định danh khách thuê vào
  bản xuất.

## D-031 — Báo cáo năm là bằng chứng doanh thu hóa đơn, không tự tính nghĩa vụ thuế

- **Trạng thái:** Đã phát hành production ngày 07/09/2026.
- **Quyết định:** Báo cáo năm dùng tổng giá trị hiệu lực của hóa đơn đã phát hành
  theo D-026 và D-028, trình bày đủ 12 tháng cùng tổng theo khu/địa điểm kinh
  doanh. Các cấu phần tiền thuê, điện, nước, dịch vụ, điều chỉnh và chưa phân
  loại phải đối soát về tổng doanh thu của cùng snapshot và bộ lọc. Tiền thanh
  toán, công nợ và tiền cọc không được thay cho doanh thu hóa đơn trong bảng kê
  này.
- **Lý do:** Hồ sơ khai thuế năm cần số liệu doanh thu có thể đối chiếu theo kỳ
  và địa điểm, nhưng doanh thu tính thuế và số thuế phải nộp còn phụ thuộc chủ
  thể, phương pháp khai và quy định áp dụng. Ứng dụng không có đủ dữ liệu pháp
  lý để tự kết luận các giá trị đó.
- **Hệ quả:** UI, Excel và PDF phải ghi rõ đây là tài liệu hỗ trợ chuẩn bị hồ sơ,
  không phải tờ khai hay tư vấn thuế. Không tự áp ngưỡng, thuế suất hoặc tính số
  thuế phải nộp. Nếu sau này sinh tờ khai chính thức, phải thu thập cấu hình thuế
  có hiệu lực, lưu căn cứ phiên bản hóa và được kế toán/đơn vị tư vấn pháp lý
  kiểm tra trước khi phát hành.

## D-032 — Chọn nhà cung cấp HĐĐT qua sandbox và contract hiện hành

- **Trạng thái:** Đang áp dụng từ 07/09/2026.
- **Quyết định:** MISA meInvoice là shortlist kỹ thuật đầu tiên để xin sandbox vì
  có tài liệu REST/JSON và môi trường test/production công khai. VNPT Invoice là
  phương án đối chứng bắt buộc về giá, SLA và hỗ trợ; Viettel S-Invoice là dự
  phòng. Đây chưa phải quyết định mua hoặc tích hợp. Không viết adapter production
  chỉ dựa trên trang giới thiệu, public SOAP demo hoặc tài liệu không xác định
  phiên bản.
- **Lý do:** Phát hành hóa đơn là hành vi pháp lý không thể retry mù hoặc dùng
  chung danh tính thuế. Tài liệu công khai giữa các nhà cung cấp có độ đầy đủ và
  tuổi đời khác nhau; một demo chạy được không chứng minh luồng ủy quyền SaaS,
  chống trùng, xử lý sai sót hay tuân thủ quy định 2026.
- **Hệ quả:** Trước proof of concept phải có API contract 2026, sandbox, báo giá,
  SLA, điều khoản dữ liệu và mô hình credential riêng cho từng chủ trọ. Adapter
  phải đặt sau interface nội bộ, lưu external reference/trạng thái, hỗ trợ
  idempotency cùng điều chỉnh/thay thế. Kế toán hoặc đơn vị tư vấn pháp lý phải
  duyệt mapping nghiệp vụ trước lần phát hành thật đầu tiên.

## D-033 — Hóa đơn nội bộ không đồng nghĩa hóa đơn điện tử thuế

- **Trạng thái:** Đang áp dụng từ 07/09/2026.
- **Quyết định:** Mọi workspace HĐĐT bắt đầu ở `review_required`. Bill, link thanh
  toán và biên nhận TrọBill chỉ là chứng từ vận hành nội bộ. Chỉ bật phát hành
  HĐĐT khi đã xác minh loại chủ thể/hoạt động, đăng ký HĐĐT, provider, credential
  riêng, mẫu/ký hiệu/chữ ký và căn cứ còn hiệu lực. Cá nhân/hộ chỉ cho thuê bất
  động sản thuộc nhóm không phải sử dụng HĐĐT theo Điều 7 Nghị định 254/2026;
  họ vẫn có thể đăng ký dùng tự nguyện. Dịch vụ lưu trú không được tự nhận miễn
  trừ này.
- **Lý do:** TrọBill phục vụ cả chủ nhà cá nhân lẫn hộ/doanh nghiệp, trong khi
  nghĩa vụ HĐĐT phụ thuộc tư cách và bản chất hoạt động. Bật chung một nút phát
  hành dễ tạo hóa đơn dưới sai mã số thuế, sai loại hoạt động hoặc biến chứng từ
  nội bộ thành tài liệu có vẻ hợp pháp nhưng chưa được cơ quan thuế chấp nhận.
- **Hệ quả:** Cần hồ sơ HĐĐT có hiệu lực theo workspace, trạng thái quyết định và
  audit trước adapter. Thu cọc bảo đảm hợp đồng không tự phát hành HĐĐT. Trường
  hợp hỗn hợp phải rà soát theo hoạt động/dòng hóa đơn; hệ thống chỉ đề xuất,
  không thay kết luận của kế toán, tư vấn pháp lý hoặc cơ quan thuế.

## D-034 — Hồ sơ HĐĐT tách khỏi bill và credential nhà cung cấp

- **Trạng thái:** Đã phát hành production ngày 07/09/2026.
- **Quyết định:** Mỗi workspace có đúng một hồ sơ HĐĐT owner-only, lưu loại chủ
  thể, hoạt động, nhóm doanh thu, mã số thuế/địa chỉ, trạng thái đăng ký, provider
  dự kiến và khoảng hiệu lực. Eligibility được suy lại ở server từ dữ liệu chủ
  tự khai; chủ phải xác nhận độ chính xác mỗi lần lưu. Trình duyệt chỉ được nhập
  mã tham chiếu tài khoản provider, không được nhận API key, mật khẩu hoặc
  credential phát hành. Credential về sau chỉ lưu dưới dạng opaque reference ở
  server; mọi thay đổi hồ sơ phải xóa xác minh kết nối và kết quả review cũ.
- **Lý do:** Bill nội bộ, danh tính pháp lý và quyền phát hành là ba lớp khác
  nhau. Lưu credential trong form hoặc giữ trạng thái ready sau khi MST/provider
  thay đổi có thể phát hành dưới sai chủ thể. Cho nhân viên xem hồ sơ này cũng
  mở rộng phạm vi dữ liệu thuế ngoài nhiệm vụ vận hành đã giao.
- **Hệ quả:** Runtime chỉ có SELECT/INSERT/UPDATE trên bảng hồ sơ, không DELETE;
  API chặn staff, response không trả credential reference và export tài khoản có
  hồ sơ để đáp ứng tính di chuyển dữ liệu. Audit chỉ lưu tên trường thay đổi,
  không lưu MST, địa chỉ, căn cứ hay mã tài khoản. Các trạng thái `*_ready`
  không thể do biểu mẫu tự bật; adapter/provider verifier tương lai phải xác minh
  credential riêng. Mục đồng bộ nhà cung cấp vẫn để mở cho tới khi có sandbox,
  API contract 2026 và luồng draft idempotent được kiểm thử.

## D-035 — Tiền kiểm HĐĐT dùng snapshot tối thiểu và không có quyền phát hành

- **Trạng thái:** Đã phát hành production ngày 07/09/2026.
- **Quyết định:** Trước adapter, server dựng một snapshot tiền kiểm từ đúng hóa
  đơn, snapshot chi tiết hiệu lực, tổng thanh toán, hợp đồng giao kỳ và hồ sơ
  HĐĐT của owner. Dòng tiền được chuẩn hóa thành tiền phòng, điện, nước, rác,
  Wifi, quản lý, giảm giá âm, phụ thu và phí chậm; tổng phải đối soát đúng VND
  nguyên. Nếu nhiều hợp đồng giao cùng kỳ thì bắt buộc chọn rõ; hóa đơn quyết
  toán khóa theo hợp đồng đã chốt. Dữ liệu người mua chỉ gồm mã hợp đồng nội bộ,
  tên và địa chỉ cần thiết; không đưa CCCD, điện thoại hoặc email. Snapshot có
  fingerprint SHA-256 ổn định nhưng luôn trả `dispatchAllowed=false`.
- **Lý do:** Dữ liệu state và hợp đồng cũ có thể chồng lấn trong cùng kỳ; tự chọn
  khách có thể phát hành sai người mua. Gửi toàn bộ hồ sơ khách thuê làm tăng dữ
  liệu cá nhân ngoài nhu cầu hóa đơn. Một nút tiền kiểm nhìn giống nút phát hành
  cũng dễ khiến chủ trọ hiểu nhầm bill nội bộ đã được gửi sang cơ quan thuế.
- **Hệ quả:** UI phải ghi rõ đây là tiền kiểm nội bộ và chưa gửi/phát hành.
  Fingerprint là đầu vào chống lặp cho adapter tương lai, không phải mã tra cứu
  HĐĐT. Chỉ adapter đã kiểm thử bằng sandbox/API contract hiện hành, credential
  riêng từng workspace và mapping được người có thẩm quyền duyệt mới được phép
  thay đổi quyền dispatch hoặc lưu external reference/trạng thái provider.

## D-036 — Bảng giá công khai dùng cùng nguồn dữ liệu với quyền lợi gói

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Landing page không ghi cứng giá hoặc gói trả phí. Endpoint
  `GET /api/public/plans` dùng cùng truy vấn plan phía server nhưng chỉ trả các
  dòng đồng thời `is_active=true` và `is_public=true`; route `/api/plans` trong
  ứng dụng vẫn yêu cầu đăng nhập. Frontend lọc phòng thủ thêm hai cờ public và
  active, render dữ liệu bằng DOM/text và hiển thị trạng thái không tải được
  thay vì dùng giá dự phòng.
- **Lý do:** Giá thử nghiệm chưa được khách hàng chấp nhận và có thể thay đổi từ
  trang admin. Ghi một mức giá riêng trong HTML sẽ làm landing page lệch với
  giá dùng để tạo đơn hàng, hoặc công khai gói chưa sẵn sàng mở bán.
- **Hệ quả:** Admin phải cấu hình đủ giá tháng/năm rồi kích hoạt và công khai gói
  thì gói đó mới xuất hiện. Production hiện chỉ hiển thị Free 0 đ / 10 phòng;
  việc thiếu cấu hình gói trả phí không được coi là lỗi render và không được tự
  điền một mức giá giả định.

## D-037 — Dữ liệu onboarding chỉ được tải xuống và không chứa dữ liệu cá nhân

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Trang `/huong-dan` tạo file JSON mẫu ngay trên trình duyệt theo
  tháng hiện tại. Mỗi lượt tạo ba room UUID mới, biểu phí và chỉ số giả lập;
  không tạo tenant, CCCD, điện thoại, email hoặc tài khoản ngân hàng. Trang chỉ
  tải file xuống, không gọi API ghi và không tự import vào workspace.
- **Lý do:** Tự nạp seed vào một tài khoản có thể ghi đè dữ liệu thật vì luồng
  state hiện thay toàn bộ rooms. Dùng ID cố định còn có thể xung đột khóa chính
  giữa nhiều tài khoản. Dữ liệu giả có định danh giống người thật cũng tạo ra
  rủi ro riêng tư và gây hiểu nhầm trong vận hành.
- **Hệ quả:** Người dùng phải chủ động chọn file trong Cài đặt và được cảnh báo
  chỉ dùng tài khoản trống hoặc export trước. Hạng mục import kế tiếp phải thêm
  bước preview/validation và lựa chọn merge/replace rõ ràng; không được biến
  generator này thành thao tác ghi một chạm nếu chưa có guard chống mất dữ liệu.

## D-038 — Import dữ liệu phải preview và xác nhận quyền xử lý dữ liệu

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Import nhận JSON hoặc CSV UTF-8 xuất từ Excel, luôn chuẩn hóa và
  preview trước khi ghi. Mặc định là gộp với ID phòng/khách mới; thay thế toàn bộ
  phòng, khách, chi phí và lịch sử phải có xác nhận riêng. File chứa khách yêu
  cầu chủ tài khoản xác nhận có quyền xử lý dữ liệu cá nhân. Import không tự tạo
  khu: tên khu trong file phải khớp một khu hiện có. Sau preview, server mới là
  nguồn xác nhận cuối cùng; giao diện chỉ rollback về snapshot cũ khi PUT chưa
  được server lưu, không rollback giả nếu PUT thành công nhưng GET sau đó lỗi.
- **Lý do:** Luồng cũ nạp state rồi báo thành công trước khi server phản hồi, có
  thể khiến người dùng tưởng dữ liệu đã lưu hoặc vô tình ghi đè workspace. Giữ ID
  ngoài có thể đụng khóa và tự tạo khu từ lỗi chính tả làm phân tán ownership.
  Dữ liệu khách thuê còn cần sự xác nhận rõ ràng về nguồn và quyền sử dụng.
- **Hệ quả:** File bị giới hạn 5 MB, 500 phòng, 2.000 khách và bị từ chối khi sai
  trường bắt buộc, ngày/email/CCCD, trùng ID hoặc trùng phòng trong cùng khu.
  CCCD đã che không được coi là dữ liệu có thể import. CSV chỉ mang phòng/khách;
  nếu chọn thay thế thì chi phí/lịch sử bị xóa còn settings được giữ, đúng với
  cảnh báo ở preview. Production revision `eab951bd939e`, CI `34177957306`.

## D-039 — Trạng thái chỉ xem được cưỡng chế tại route server, có ngoại lệ giảm rủi ro

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Mọi API ghi vận hành cần entitlement `full` lấy trực tiếp từ
  subscription và plan của workspace owner. Middleware dùng `accountUserId` sau
  khi phân giải workspace, không tin cờ Premium hoặc giới hạn do client gửi.
  Luồng state vẫn kiểm tra riêng số phòng sắp ghi; luồng nhân viên kiểm tra riêng
  `staff_limit` ngay trước INSERT trong transaction.
- **Lý do:** Các module mới đã tự chặn hết hạn nhưng một số route thanh toán,
  cọc, gửi hóa đơn, VietQR và tài khoản nhận tiền cũ chưa dùng chung guard. Chỉ
  khóa nút ở frontend không ngăn request API trực tiếp và làm trạng thái
  `read_only` không đúng nghĩa.
- **Hệ quả:** Hết trial và hết ba ngày ân hạn trả 403
  `SUBSCRIPTION_READ_ONLY` trước handler ghi. Luôn cho phép đọc, xuất/xóa tài
  khoản, mua/gia hạn gói và workflow hoàn tiền. Các thao tác chỉ giảm rủi ro như
  thu hồi link, hủy lịch gửi, tắt kênh thanh toán hoặc xóa nhân viên cũng không
  bị khóa. Webhook và submission công khai vẫn append để không làm mất dấu giao
  dịch/yêu cầu đã phát sinh. Production revision `d5adcd7282d4`, CI
  `34178776243`, 433/433 test.

## D-040 — Chính sách hoàn tiền chỉ điều chỉnh phí TrọBill và bám workflow thực tế

- **Trạng thái:** Bản pilot phát hành production ngày 08/09/2026; chưa đủ điều
  kiện pháp lý để mở bán đại trà.
- **Quyết định:** Chính sách hoàn tiền tách khoản mua/nâng/gia hạn subscription
  khỏi tiền thuê và tiền cọc đi thẳng vào tài khoản chủ trọ. Chính sách chỉ mô
  tả khả năng hệ thống đang có: người dùng tạo yêu cầu từ payment của mình,
  admin rà soát theo trạng thái hữu hạn và chỉ đánh dấu đã hoàn khi có mã giao
  dịch. Không hứa hoàn tự động hoặc thời hạn chưa được chủ sản phẩm cam kết;
  quyền bắt buộc theo pháp luật không bị loại trừ.
- **Lý do:** Gộp tiền thuê/cọc vào chính sách phí SaaS sẽ khiến người dùng hiểu
  nhầm TrọBill giữ hộ tiền. Cam kết số ngày xử lý khi chưa có kênh/người trực hỗ
  trợ là không trung thực. Nội dung được đối chiếu ở mức sản phẩm với Luật Bảo
  vệ quyền lợi người tiêu dùng 19/2023/QH15, Luật Bảo vệ dữ liệu cá nhân
  91/2025/QH15 và hướng dẫn website thương mại điện tử của Bộ Công Thương,
  nhưng không thay thế ý kiến tư vấn pháp lý.
- **Hệ quả:** Terms/privacy tăng phiên bản `2026-09-08` và tài khoản cũ phải xác
  nhận lại. Privacy công khai đúng provider hiện tại là Neon, Vercel, Brevo;
  Resend chỉ là phương án cấu hình tương lai. Checklist pháp lý vẫn mở cho tới
  khi có tên pháp nhân, địa chỉ/kênh liên hệ, SLA, thủ tục website và kết quả rà
  soát của người có chuyên môn. Production revision `3daf767b2024`, CI
  `34179242211`, 436/436 test.

## D-041 — Event webhook trùng ID phải trùng cả loại và payload

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Một `X-Payment-Event-Id` đã tồn tại chỉ được coi là retry hợp
  lệ khi `event_type` và SHA-256 của raw request body giống bản đã lưu. Nếu khác,
  server trả `409 WEBHOOK_EVENT_PAYLOAD_MISMATCH`, không tra cứu payment và không
  kích hoạt/gia hạn subscription; số lần nhận event vẫn tăng để phục vụ đối soát.
- **Lý do:** Chỉ khóa unique event ID có thể che giấu việc provider hoặc adapter
  tái sử dụng nhầm ID cho một giao dịch khác. Xử lý bản sau như retry bình thường
  sẽ khiến phản hồi thành công dù nội dung mới chưa từng được ghi nhận.
- **Hệ quả:** Adapter tương lai phải giữ nguyên raw payload khi retry cùng event
  ID và sinh ID mới cho event mới. Cơ chế này mới bảo đảm idempotency của contract
  nội bộ; checklist thanh toán tự động vẫn mở cho tới khi có provider thật và
  giao dịch pilot production được xác minh. Production revision `ac14d1ccb3ff`,
  CI `34193887394`, 437/437 test.

## D-042 — Lỗ hổng bảo mật nhận qua kênh riêng tư, không qua Issue công khai

- **Trạng thái:** Đang áp dụng từ 08/09/2026.
- **Quyết định:** GitHub Private Vulnerability Reporting là kênh nhận báo cáo lỗ
  hổng của repository. `SECURITY.md` yêu cầu dữ liệu giả, cấm đăng cookie, CCCD,
  dữ liệu khách hoặc chi tiết khai thác lên Issue công khai. Chủ repository là
  người triage hiện tại; không công bố thời hạn phản hồi khi chưa có lịch trực.
- **Lý do:** Issue công khai có thể biến báo cáo thiện chí thành sự cố lộ dữ liệu
  hoặc hướng dẫn khai thác. Dùng email/chat cá nhân chưa xác minh cũng làm mất
  dấu vết, phân quyền và phối hợp disclosure.
- **Hệ quả:** Báo cáo được xử lý trong advisory riêng tư, thêm regression test,
  kiểm tra Preview rồi production và rotate credential nếu bị ảnh hưởng. Mục hỗ
  trợ tổng thể chỉ được đóng sau khi có kênh khách hàng cùng SLA được chủ sản
  phẩm phê duyệt. GitHub API xác nhận `enabled=true` ngày 08/09/2026.

## D-043 — Mã tra cứu HĐĐT chỉ được ghi từ sự kiện provider đã xác minh

- **Trạng thái:** Đã phát hành production ngày 08/09/2026.
- **Quyết định:** Mỗi tài liệu HĐĐT ngoài được khóa theo workspace, hóa đơn nguồn,
  provider, `provider_document_id` và fingerprint của snapshot tiền kiểm. Adapter
  nội bộ là nơi duy nhất gọi service ghi; không mở route ghi cho trình duyệt.
  Callback provider bắt buộc có event ID, trạng thái, thời điểm, SHA-256 payload
  và chỉ lưu hash thay vì raw payload. Mã tra cứu, mã cơ quan thuế, số hóa đơn và
  thời điểm phát hành trở thành bất biến sau khi có giá trị. Lịch sử trạng thái
  append-only; event trùng chỉ là retry khi toàn bộ định danh/hash khớp, event cũ
  hơn mốc mới nhất bị từ chối và chuyển trạng thái được cưỡng chế cả service lẫn
  trigger database.
- **Lý do:** Mã tra cứu và trạng thái là bằng chứng nhận từ hệ thống bên ngoài;
  cho client tự ghi hoặc cho callback đến trễ ghi đè sẽ làm TrọBill hiển thị một
  hóa đơn chưa phát hành hoặc quay ngược vòng đời. Lưu raw callback tạo thêm dữ
  liệu ngoài nhu cầu đối soát và có thể chứa thông tin nhạy cảm của provider.
- **Hệ quả:** Chủ workspace đọc hồ sơ và lịch sử tại popup tiền kiểm; staff bị
  chặn. Runtime không có DELETE record, không có UPDATE/DELETE event. Các trạng
  thái `adjusted`, `replaced`, `cancelled` mới chỉ là nền tảng dữ liệu; quy trình
  yêu cầu điều chỉnh/thay thế vẫn để mở cho tới khi có contract provider và phê
  duyệt nghiệp vụ. Migration đạt 5/5 trên Preview và Production; commit
  `968076b`, CI `34233340040`, Preview E2E `34234080279`, Production deployment
  `dpl_5Yf9EG7jqkDUnQGCEakrPiowXPq9` readiness HTTP 200.

## D-044 — Xử lý sai HĐĐT bắt đầu bằng phân loại, không bắt đầu bằng một nút sửa

- **Trạng thái:** Runbook áp dụng từ 08/09/2026; tự động hóa vẫn chờ provider.
- **Quyết định:** Quy trình tách bốn nhánh: chỉ thông báo sai sót; điều chỉnh;
  thay thế; và hóa đơn/chứng từ cho phần chênh lệch do thanh toán/quyết toán. Chủ
  workspace mở hồ sơ, kế toán/đơn vị tư vấn chọn nghiệp vụ, provider thực hiện,
  adapter chỉ ghi kết quả sau khi xác minh. Hóa đơn gốc, reference và event luôn
  được giữ; `cancelled` không phải đường tắt mặc định. UI TrọBill không có nút
  điều chỉnh/thay thế cho tới khi contract, credential, mapping, webhook và nơi
  lưu bằng chứng provider đã sẵn sàng.
- **Lý do:** Quy định hiện hành không yêu cầu lập lại cho mọi loại sai sót, trong
  khi sai MST/số tiền/thuế/hàng hóa có thể dẫn đến điều chỉnh hoặc thay thế. Một
  nút chung trước bước phân loại có thể tạo sai nghiệp vụ thuế; cho support tự
  gắn trạng thái lại phá vỡ nguyên tắc provider-verified ở D-043.
- **Hệ quả:** `docs/E_INVOICE_CORRECTION_RUNBOOK.md` là quy trình vận hành bắt
  buộc, gồm cổng phân loại, vai trò, bằng chứng đóng hồ sơ và xử lý timeout/retry/
  duplicate/out-of-order. Checklist “có quy trình” được đóng, nhưng đồng bộ thật
  và rà soát chuyên môn vẫn mở; không diễn giải runbook thành khả năng phát hành
  production của TrọBill.

## D-045 — Pilot đầu tiên chỉ tính đúng mẫu chủ trọ trực tiếp vận hành 10–50 phòng

- **Trạng thái:** Áp dụng cho giai đoạn kiểm chứng từ 08/09/2026.
- **Quyết định:** ICP v1 là chủ trọ hoặc người có quyền quyết định trực tiếp vận
  hành 10–50 phòng đang hoạt động, có bill hằng tháng và theo dõi thu/công nợ.
  Họ sẵn sàng mô tả quy trình, dùng dữ liệu mẫu đã ẩn danh và thử hai chu kỳ.
  Người dưới 10 hoặc trên 50 phòng có thể cung cấp góc nhìn nhưng không thay thế
  mẫu kiểm chứng chính; nhu cầu giữ hộ tiền hoặc phát hành HĐĐT chưa xác minh nằm
  ngoài pilot.
- **Lý do:** Một mẫu quá rộng sẽ trộn nhu cầu chủ trọ nhỏ với chuỗi vận hành cần
  ERP/tích hợp riêng, khiến vấn đề và mức sẵn sàng trả tiền không thể so sánh.
  Checklist đã định hướng 10–50 phòng nên tiêu chí tuyển phải đủ cụ thể để biết
  cuộc phỏng vấn nào được tính.
- **Hệ quả:** Dùng `docs/PILOT_CUSTOMER_PROFILE.md` để sàng lọc. Không đánh dấu
  phỏng vấn, ba vấn đề, thông điệp, bảng giá hoặc pilot là hoàn thành chỉ từ giả
  thuyết nội bộ. Bằng chứng trong Git phải ẩn danh; dữ liệu liên hệ nằm ngoài
  repository trong công cụ riêng tư của chủ sản phẩm.

## D-046 — Xác nhận thanh toán thủ công dùng chung định danh với webhook

- **Trạng thái:** Đã phát hành Production ngày 09/09/2026.
- **Quyết định:** Webhook là đường xác nhận tự động chính; admin có đường dự
  phòng để xác nhận payment `pending` sau khi đối chiếu tiền thực nhận. Cả hai
  đường dùng cùng cặp `bank_transfer + transactionId`, khóa payment/subscription
  và cập nhật trạng thái payment, subscription, audit trong một transaction.
  Xác nhận thủ công bắt buộc mã giao dịch, thời điểm nhận và lý do; chỉ nhận giao
  dịch trong thời hạn đơn và khi subscription chưa đổi so với lúc tạo đơn.
- **Lý do:** VietQR tĩnh không phát webhook nên nếu chỉ có tự động, đơn có thể
  chờ vô hạn; nếu admin cấp gói bằng thao tác rời, cùng giao dịch có thể được
  webhook đến muộn áp dụng thêm lần nữa và mất liên kết với payment gốc.
- **Hệ quả:** Một giao dịch không thể dùng cho hai payment; webhook đến sau xác
  nhận thủ công chỉ là retry và không gia hạn lặp. Mọi thao tác thủ công có actor,
  reason và payment ID trong audit. Yêu cầu “đã chuyển khoản” từ người dùng chỉ
  mở đối soát, không tự chuyển payment sang `paid`. Checklist tự động vẫn mở tới
  khi có adapter provider thật và giao dịch pilot Production. Revision
  `5332f0638046`, CI `34299403260`, deployment
  `dpl_CxQGts8wZu3VMaSc3e4W3y851ayt` ready; không cần migration mới.

## D-047 — Lần hiển thị đầu không chờ đồng bộ ledger hoặc dữ liệu cài đặt phụ

- **Trạng thái:** Đã phát hành Production ngày 09/09/2026.
- **Quyết định:** Luồng khởi động owner chỉ chờ state, entitlement, tóm tắt sổ
  thu và trạng thái sửa chữa trước khi render. Đồng bộ hóa đơn với ledger, danh
  sách workspace, tài khoản ngân hàng, plans/lịch sử payment, kênh đối soát,
  team và hồ sơ HĐĐT chạy sau lần render đầu. `/api/me`, login và xác minh email
  trả thêm `accountUserId`; client dùng giá trị đã khóa với `accountContext` để
  vào thẳng workspace của chính phiên, còn workspace được giao vẫn phải xác
  minh qua `/api/workspaces`. Mọi kết quả nền chỉ được áp dụng khi đồng thời còn
  đúng session generation, account context và workspace ID.
- **Lý do:** Runtime Logs cho thấy startup cũ chạy `/me → /workspaces → 11 API`
  rồi còn chờ đồng bộ toàn bộ hóa đơn lịch sử; riêng sync có thể giữ màn hình
  khoảng 15 giây dù dữ liệu ít. Sau khi bỏ sync khỏi critical path, phép đo đúng
  tới lúc kỳ và 7 phòng được render vẫn là 6,59 giây vì 11 request phụ cùng nằm
  trong `Promise.all`. Các dữ liệu cài đặt đó không cần để dashboard đầu tiên
  chính xác.
- **Hệ quả:** Ledger vẫn được đồng bộ ở nền khi tổng, chi tiết hoặc cờ paid cũ
  thật sự lệch; summary trả `detailSnapshot` để không bỏ sót thay đổi cùng tổng.
  Tác vụ của phiên cũ tự hủy và promise cũ không được xóa promise của phiên mới.
  Production cùng Chrome/account đo ba hard navigation tới sentinel dữ liệu thật
  là 4,60 giây, 4,36 giây và 1,80 giây (trung vị 4,36 giây); dữ liệu phụ sau đó
  đầy đủ và console sạch. Commits `c42019a` + `3f4695a`, CI `34317034949` và
  `34318766043`; deployment cuối `dpl_6egiSBnuuFJmJkBEPsaLK9EDEwVi`, không có
  migration.

## D-048 — Super Admin nền tảng tách khỏi Owner workspace

- **Trạng thái:** Đã push `main` ngày 09/09/2026 tại commit `ed42a8f`; chưa xác
  minh deployment Production trong phiên hiện tại.
- **Quyết định:** Quyền quản trị toàn nền tảng được gọi là **Super Admin** và
  chỉ vai trò này vào `admin.html` hoặc `/api/admin/*`. Owner là chủ trọ sở hữu
  workspace và tiếp tục quản lý Cài đặt, khu, dữ liệu và nhân viên của mình;
  `manager`, `accountant`, `meter_reader` giữ phạm vi được Owner phân công.
  Không tồn tại nút hoặc API web để cấp/thu hồi Super Admin; thao tác này chỉ
  được thực hiện bằng biến môi trường bảo mật hoặc CLI `make-super-admin`.
- **Lý do:** “Admin” trước đây vừa bị hiểu là chủ trọ vừa biểu thị quyền xem và
  sửa toàn hệ thống. Cho phép một Super Admin cấp thêm Super Admin ngay trong
  web làm tăng rủi ro leo thang đặc quyền và biến sai sót vận hành thành quyền
  truy cập mọi workspace.
- **Hệ quả:** API phiên dùng `isSuperAdmin`, middleware dùng
  `requireSuperAdmin` và luôn kiểm tra lại database mỗi request. Cột
  `users.is_admin` được giữ như tên legacy để rollout không cần migration; nó
  chỉ còn mang nghĩa Super Admin. Các tài khoản đang có cờ này không bị tự động
  thu hồi; phải kiểm kê và thu hồi thủ công sau khi xác nhận tài khoản
  break-glass. Web cũng từ chối đổi mật khẩu hoặc xóa một Super Admin khác;
  phải thu hồi cờ bằng CLI trước. Biến `ADMIN_*` cũ chỉ được seed đọc fallback để deployment hiện
  tại không mất quyền truy cập trong lúc chuyển sang `SUPER_ADMIN_*`.

## D-049 — Làm mới UI theo từng luồng, không viết lại toàn bộ frontend

- **Trạng thái:** Áp dụng từ 09/09/2026; đăng nhập/đăng ký đã push tại `d98b8cd`,
  bảng giá/gia hạn/thanh toán tại `1e66c8b`, Tổng quan tại `9289f1a`; Quản lý
  phòng đã push tại `f51acf9`, Nhập chỉ số/Hóa đơn tại `4113398`, Chi phí thực
  tế/Lịch sử tháng tại `627f2c9`, Cài đặt vận hành tại `aaa5f0f`; Super Admin
  đã hoàn thành local và đang chờ người dùng kiểm tra.
- **Quyết định:** Chuẩn hóa giao diện theo thứ tự luồng tạo doanh thu, bắt đầu từ
  đăng nhập/đăng ký, sau đó mới tới bảng giá và gia hạn/thanh toán. Giữ nguyên
  HTML/CSS/JavaScript hiện tại và nghiệp vụ đã kiểm thử; mỗi lát cắt phải độc lập,
  responsive và được người dùng duyệt trước khi chuyển sang phần kế tiếp.
- **Lý do:** Frontend đã có nhiều nghiệp vụ ổn định nhưng stylesheet lớn và các
  popup/bảng được bổ sung theo thời gian. Viết lại đồng loạt làm tăng nguy cơ phá
  luồng bill, auth và phân quyền; sửa theo luồng cho phép đo chất lượng và rollback
  từng phần.
- **Hệ quả:** Màn hình auth dùng bố cục giới thiệu + form trên desktop, một cột
  trên mobile. Khu vực gói trong Cài đặt có thứ bậc riêng cho gói hiện tại, chọn
  gói, lịch sử và popup VietQR ba bước; popup thu về một cột và nút sao chép toàn
  chiều rộng trên mobile. Hai lát cắt chỉ dùng CSS/HTML nhẹ, không thay đổi API,
  webhook, đối soát hoặc logic phiên. Asset CSS phải tăng version; các test pin
  asset và responsive contract phải được cập nhật cùng thay đổi. Không đánh dấu
  checklist thương mại là hoàn thành chỉ vì giao diện đẹp hơn.

  Lát cắt Tổng quan nhóm số liệu thành khối dòng tiền ba cột, ưu tiên tổng phải
  thu và tách danh sách trạng thái hóa đơn thành một bề mặt riêng. Responsive
  lần lượt về hai cột và một cột; công thức tài chính, lọc khu và logic render
  hiện hữu được giữ nguyên.

  Lát cắt Quản lý phòng ưu tiên trạng thái và giá thuê hiện hành, nhóm phí và
  metadata, đưa chỉ số điện nước vào vùng mở rộng, đồng thời tách thao tác nghiệp
  vụ khỏi sửa/xóa. Markup động vẫn dùng listener hiện hữu; dữ liệu ghi chú phải
  escape trước khi đưa vào thẻ. Không thay đổi mô hình trạng thái phòng, giá theo
  mốc hiệu lực, khách, hợp đồng hoặc API.

  Lát cắt Nhập chỉ số/Hóa đơn biểu diễn quy trình thành hai bước. Tiến độ chỉ số
  được suy từ các thẻ bill hợp lệ và CTA sang hóa đơn chỉ bật khi có ít nhất một
  phòng hoàn thành; nhân viên không có nghiệp vụ hóa đơn không thấy CTA. Trang
  Hóa đơn ưu tiên danh sách thu tiền trước phần phân tích tài chính, trình bày
  riêng tổng phải thu, đã thu và tổng còn phải thu gồm nợ cũ. Các phép tính,
  ledger, đồng bộ invoice, gửi/chia sẻ và phân quyền server không thay đổi; dữ
  liệu tên phòng/ghi chú động tiếp tục phải escape.

  Lát cắt Chi phí thực tế/Lịch sử tháng tách tổng quan chi ra khỏi form và sổ
  chi, hiển thị cả nhóm “Khác” thay vì làm nó biến mất khỏi cơ cấu. Lịch sử vẫn
  là snapshot hóa đơn đã lưu nhưng số thu tiếp tục đọc từ ledger hiện hành; giao
  diện phải gọi rõ “Sau khấu trừ” thay cho nhãn dễ nhầm với tổng tiền đã thu.
  Việc mở snapshot phải dùng được bằng bàn phím và phản ánh `aria-expanded`.
  Không thay đổi cách lưu/xóa chi phí, snapshot lịch sử hoặc giao dịch thanh toán.

  Lát cắt Cài đặt vận hành thêm mục lục anchor thuần HTML để đi tới năm vùng
  chính, đồng thời chia phần cấu hình dài thành Tài chính, Tự động hóa và Dữ liệu
  & bảo mật. Những form cũ vẫn giữ nguyên ID/listener nhưng bỏ kích thước inline
  ở các khối chính để responsive nhất quán; trên mobile trường nhập và CTA xếp
  dọc. Không thêm trạng thái client, request API hay quyền mới cho việc điều
  hướng và trình bày này.

  Lát cắt Super Admin dùng header riêng để phân biệt quyền nền tảng với Owner,
  thêm thanh anchor bám phía trên và gom các bề mặt theo Tổng quan, đối soát,
  cấu hình, tài khoản và audit. Thẻ chỉ số có màu ngữ nghĩa nhưng số liệu vẫn do
  luồng render hiện hữu cấp; bảng rộng tiếp tục cuộn có chủ đích, riêng bảng tài
  khoản chuyển sang card responsive. Modal giữ header cố định trong khung và chỉ
  cuộn phần nội dung để không vượt viewport. Không đổi API, ID listener hoặc mô
  hình phân quyền Super Admin đã chốt tại D-048.
