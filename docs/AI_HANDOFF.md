# Bàn giao công việc AI — TrọBill

Tài liệu này chỉ lưu **trạng thái vận hành hiện tại** để agent kế tiếp bắt đầu
đúng chỗ. Các lý do bền vững nằm trong `AI_DECISIONS.md`; quy tắc bắt buộc nằm
trong `../AGENTS.md`.

## Trạng thái hiện tại

| Trường | Giá trị |
|---|---|
| Cập nhật lần cuối | 30/08/2026 (Asia/Ho_Chi_Minh) |
| Trạng thái | Sẵn sàng bàn giao — chờ người dùng kiểm tra trạng thái phòng |
| Branch chuẩn | `main` |
| Worktree kỳ vọng | Sạch sau commit phát hành; agent mới vẫn phải tự kiểm tra |
| Phần ứng dụng phát hành gần nhất | `ab7a952` — bản review và gia cố quản lý trạng thái phòng |
| Việc code tiếp theo | Sau khi người dùng xác nhận UI: Giai đoạn 4, một chủ quản lý nhiều khu/tòa nhà |
| Việc vận hành còn mở | Credential local `tro_bill_app` đã cũ; vẫn cần xác minh runtime role trước khi thu hồi role cũ |

Không dùng commit trên bảng làm HEAD mặc định: luôn lấy HEAD thật bằng `git log`.
“Phát hành gần nhất” chỉ là mốc ứng dụng đã được kiểm tra production.

## Mục tiêu đang theo đuổi

Tiếp tục `MONETIZATION_CHECKLIST.md` theo thứ tự, hoàn thành từng phần có test và
cho người dùng kiểm tra. Bản review trạng thái phòng đã phát hành: server suy
trạng thái từ khách/hợp đồng/giữ chỗ/sửa chữa, khóa phòng trước thao tác, ghi
event sửa chữa và cập nhật UI/cache an toàn. Migration và production đã được xác
minh. Chờ người dùng kiểm tra giao diện trước khi chuyển sang phần **Nhiều khu và
phân quyền**, bắt đầu bằng một chủ sở hữu quản lý nhiều khu/tòa nhà.

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
- Commit `5375daa` đã push lên `main`; GitHub Actions `33240721704` thành công.
  Deployment production `tro-bill-ph6am8l8m-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `5375daa1c872`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026.
- Quyết toán trả phòng có preview và biên bản in A4; tiền phòng tính bao gồm ngày
  bắt đầu/ngày trả, chỉ số điện nước phải khớp biên bản, tổng cuối khóa bất biến.
  Tiền cọc bù công nợ được tạo receipt/allocation và hai hướng khấu trừ/hoàn cọc
  dùng ledger hiện có trong cùng transaction. Các luồng QR, nhắc nợ, đối soát,
  biên nhận và export đều dùng tổng cuối sau khi chốt.
- Migration `20260830_rental_final_settlements.sql` đã chạy trên Neon
  `staging-privacy` và production ngày 30/08/2026; cả 5 cờ schema, ownership,
  snapshot bất biến và quyền append-only đều `true`. Test mục tiêu đạt 8/8, toàn
  bộ test đạt 303/303; secret scan và `git diff --check` sạch. Modal đã kiểm tra
  trực quan ở desktop, không tràn ngang và cuộn nội bộ khi viewport thấp.
- Commit `bf07073` đã push lên `main`; GitHub Actions `33298052320` thành công.
  Deployment production `tro-bill-3yjtydgpk-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `bf07073c69f2`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026.
- Claude đã push `776ea2e` cho trạng thái phòng. Review Codex bổ sung nguồn khách
  thuê cũ, server-authoritative status, chốt xung đột giữa hợp đồng/giữ chỗ/sửa,
  event append-only, chặn xóa/thêm khách vào phòng đang sửa, làm mới UI sau mọi
  thao tác, bỏ inline handler và khóa scroll modal. Test mới nâng bộ đầy đủ lên
  311/311 test thành công; syntax check và `git diff --check` cũng sạch.
- Migration `20260830_room_operational_statuses.sql` đã chạy trên Neon
  `staging-privacy` ngày 30/08/2026; production được kiểm tra lại bằng cùng SELECT.
  Cả hai môi trường đều đạt đủ 5 cờ bảng, unique active, liên kết lifecycle,
  ownership FK và quyền runtime.
- Commit review `ab7a952` đã push lên `main`; GitHub Actions `33309502867` thành
  công. Deployment production `tro-bill-ejn9hhys7-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `ab7a9526a105`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026. Quét log lỗi 10 phút sau deploy không có bản ghi lỗi. Phiên Chrome
  đã hết đăng nhập nên phần UI có dữ liệu thật chờ người dùng smoke test.

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
