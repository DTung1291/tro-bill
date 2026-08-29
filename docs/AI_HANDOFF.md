# Bàn giao công việc AI — TrọBill

Tài liệu này chỉ lưu **trạng thái vận hành hiện tại** để agent kế tiếp bắt đầu
đúng chỗ. Các lý do bền vững nằm trong `AI_DECISIONS.md`; quy tắc bắt buộc nằm
trong `../AGENTS.md`.

## Trạng thái hiện tại

| Trường | Giá trị |
|---|---|
| Cập nhật lần cuối | 29/08/2026 (Asia/Ho_Chi_Minh) |
| Trạng thái | Đang phát hành — giữ chỗ, chuyển phòng và trả phòng |
| Branch chuẩn | `main` |
| Worktree kỳ vọng | Có thay đổi vòng đời chưa commit trong lúc phát hành; agent mới phải kiểm tra Git và không ghi đè |
| Phần ứng dụng phát hành gần nhất | `2ded7ef` — biên bản nhận/trả phòng và bàn giao tài sản bất biến |
| Việc code tiếp theo | Sau khi phát hành/xác minh phần đang dở: chốt bill cuối cùng khi khách trả phòng |
| Việc vận hành còn mở | Xác minh deployment mới dùng `tro_bill_runtime_sql`, sau đó mới thu hồi role cũ `tro_bill_app` |

Không dùng commit trên bảng làm HEAD mặc định: luôn lấy HEAD thật bằng `git log`.
“Phát hành gần nhất” chỉ là mốc ứng dụng đã được kiểm tra production.

## Mục tiêu đang theo đuổi

Tiếp tục `MONETIZATION_CHECKLIST.md` theo thứ tự, hoàn thành từng phần có test và
cho người dùng kiểm tra. Phần **giữ chỗ, chuyển phòng và trả phòng** đã code/test,
migration đã chạy trên staging/production và đang chờ commit, CI cùng xác minh
deployment. Không bắt đầu bill cuối cùng trước khi mốc phát hành này sạch.

## Bản đồ hệ thống ngắn

- Frontend thuần: `index.html`, `app.js`, `style.css`, `api.js` và các module ở
  thư mục gốc. Server phục vụ frontend và API cùng origin.
- Backend Express/CommonJS: `server/index.js` lắp route; nghiệp vụ tách theo
  module trong `server/`; `api/index.js` là entry cho Vercel.
- Database: Neon PostgreSQL. Schema đầy đủ ở `server/schema.sql`; migration tiến
  tới ở `server/migrations/`; runtime role mục tiêu là `tro_bill_runtime_sql`.
- State cũ của frontend được tách/lắp trong `server/state.js`. Các luồng tài
  chính, hợp đồng, subscription và dữ liệu nhạy cảm có API/bảng riêng.
- Test dùng `node:test` trong `server/test/`. Lệnh đầy đủ từ root là `npm test`.
- Vận hành/deploy: `vercel.json`, `.github/workflows/`, `OPERATIONS.md`.
- Production: `https://tro-bill.vercel.app`.
- Mẫu hợp đồng nguồn: `document/HopDongThuePhongNew.docx`; HTML in được dựng bởi
  `contract-template.js`, chu kỳ bởi `rental-contract-cycle.js`.

## Mốc đã giao gần đây

- `772ce86`: tạo hợp đồng từ mẫu DOCX đã cung cấp và luồng xem/in.
- `08a206f`: chu kỳ thanh toán hợp đồng 1/3/6/12 tháng và ngày đến hạn.
- `696bea5`: cảnh báo + email nhắc hợp đồng hết hạn ở mốc 30/14/7/3/1 ngày.
- `842e246`: bỏ khóa viewport của modal trong print media; bản hợp đồng Letter đã
  tạo và kiểm tra trực quan đủ 5 trang, không mất nội dung/chữ ký.
- Toàn bộ migration đến
  `20260828_rental_contract_expiry_notifications.sql` đã được ghi nhận là áp dụng
  và xác minh quyền trên Neon staging lẫn production ngày 28/08/2026.
- Tại mốc `842e246`, bộ test tự động đạt 282/282, quét secret sạch và production
  readiness trả `200`. Agent mới phải chạy lại test sau thay đổi của mình.
- Sau khi tạo bộ tài liệu bàn giao ngày 29/08/2026, `npm test` tiếp tục đạt
  282/282, `npm run check:secrets` sạch và `git diff --check` không có lỗi.
- Biên bản nhận/trả phòng lưu snapshot bất biến, giới hạn một bản mỗi loại trên
  mỗi hợp đồng và dùng số dư từ `tenant_deposit_transactions`. Migration
  `20260829_rental_handover_records.sql` đã chạy thành công trên Neon branch
  `staging-privacy` và production ngày 29/08/2026; cả 6 cờ xác minh đều `true`.
  Branch cũ tên `staging` thiếu `rental_contracts`, lần chạy thử đã rollback và
  không phải database Preview; không dùng branch đó cho migration tiếp theo.
- Bộ test đầy đủ đạt 288/288, secret scan sạch, popup đã kiểm tra ở 1440×900 và
  390×844. PDF A4 thử nghiệm 32 tài sản có đủ 3 trang; đã nhìn cả trang đầu,
  giữa và cuối, không mất phần đối chiếu cọc hoặc chữ ký.
- GitHub Actions `33239622788` thành công; production readiness revision
  `2ded7ef3a030` trả HTTP 200 với database, runtime role và schema đều `ok`.
- Giữ chỗ, chuyển phòng và trả phòng đã có API/UI/schema/test. Migration
  `20260829_rental_lifecycle.sql` đã chạy trên `staging-privacy` và production
  ngày 29/08/2026; cả 6 cờ bảng, ownership, unique active reservation và quyền
  event append-only đều `true`. Test mục tiêu đạt 18/18, toàn bộ test đạt
  295/295; giao diện đã kiểm tra tại 1440×900 và 390×844 không tràn viewport.

## Việc chưa được xem là hoàn tất

1. Checkbox thay runtime role trong phần **An toàn dữ liệu và vận hành** vẫn mở.
   Code/migration đã tạo `tro_bill_runtime_sql`, nhưng không thu hồi
   `tro_bill_app` cho đến khi kiểm tra credential của deployment mới trên cả
   Preview và Production. Đây là thao tác từ xa có thể gây downtime; cần quyền
   rõ ràng và rollback plan.
2. `OPS_ALERT_WEBHOOK_URL` là kênh cảnh báo bổ sung tùy chọn; GitHub Issue và
   Vercel Runtime Logs vẫn là cơ chế mặc định. Không để cảnh báo tùy chọn này
   chặn tính năng sản phẩm.
3. Các mục phỏng vấn/pilot/pháp lý trong checklist cần đầu vào của người dùng;
   agent không được tự đánh dấu hoàn thành bằng code.
4. Google Play Billing chỉ cần khi thực sự bán subscription trong Android app.

## Quy trình tiếp quản không conflict

### Bắt đầu phiên

1. Đọc `AGENTS.md`, tài liệu này, `AI_DECISIONS.md` và phần checklist liên quan.
2. Chạy `git status --short`, `git branch --show-current`, `git log --oneline -8`
   và `git diff --stat`.
3. Nếu worktree bẩn, xác định các tệp/ý định đang dở trước khi sửa. Không tự dọn
   hay commit hộ.
4. Đối chiếu “Việc code tiếp theo” với code/test hiện tại; tài liệu có thể chậm
   hơn Git nếu một phiên trước bị ngắt giữa chừng.
5. Chuyển trạng thái bảng trên thành `Đang làm — <agent>/<phạm vi>` ngay trong
   thay đổi của phiên nếu công việc kéo dài hoặc sẽ bàn giao giữa chừng.

### Kết thúc phiên

1. Chạy test mục tiêu, `npm test`, `npm run check:secrets`, `git diff --check`.
2. Ghi migration theo từng môi trường và deployment revision đã thật sự xác minh.
3. Cập nhật bảng trạng thái, “mốc đã giao”, phần còn mở và **một bước tiếp theo**.
4. Nếu có quyết định mới, thêm vào `AI_DECISIONS.md`.
5. Commit nguyên tử; push/deploy chỉ khi được phép; để worktree sạch nếu bàn giao.

### Nếu cần làm song song

Không chia sẻ worktree. Tạo branch/worktree riêng cho từng agent, cập nhật từ
`origin/main` trước khi hợp nhất, chạy lại toàn bộ test sau khi resolve conflict
và hợp nhất qua PR. Không cho cả Codex và Claude “tiếp tục” cùng một tệp trên
`main` ở cùng thời điểm.

## Prompt bàn giao dùng ngay

Khi mở agent khác tại root repository, có thể dùng:

> Đọc toàn bộ `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DECISIONS.md` và phần
> liên quan trong `MONETIZATION_CHECKLIST.md`. Kiểm tra Git trước khi sửa, tiếp
> tục đúng “Việc code tiếp theo”, không đè thay đổi chưa commit. Chạy kiểm thử
> bắt buộc và cập nhật handoff/decision trước khi kết thúc.

Nếu chỉ muốn agent rà soát phiên trước, thêm: “Chưa sửa code; trước tiên báo lại
HEAD, worktree, thay đổi đã có, bằng chứng test/deploy và điểm chưa rõ.”
