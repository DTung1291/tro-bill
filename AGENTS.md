# Quy ước làm việc cho AI agent

Tệp này áp dụng cho toàn bộ repository. Mục tiêu là để Codex, Claude Code hoặc
agent khác có thể tiếp quản công việc mà không dựa vào lịch sử chat riêng.

## Nguồn sự thật và thứ tự đọc

Trước khi sửa bất kỳ tệp nào, đọc theo thứ tự:

1. `AGENTS.md` — quy trình và ràng buộc bắt buộc.
2. `docs/AI_HANDOFF.md` — trạng thái hiện tại, việc đang làm và bước tiếp theo.
3. `docs/AI_DECISIONS.md` — các quyết định nghiệp vụ/kỹ thuật không được vô tình
   đảo ngược.
4. `MONETIZATION_CHECKLIST.md` — thứ tự phát triển và tiêu chí sản phẩm.
5. `README.md`, `OPERATIONS.md`, `PAYMENT_WEBHOOK.md` cùng mã nguồn/test liên quan.

Khi tài liệu mâu thuẫn, ưu tiên mã nguồn + schema + test đang chạy, sau đó đến
quyết định đã ghi nhận. Không đoán rằng một checkbox hoặc ghi chú cũ vẫn đúng;
phải kiểm tra bằng code, Git và môi trường tương ứng.

## Kiểm tra bắt buộc khi bắt đầu

Chạy và đọc kết quả trước khi chỉnh sửa:

```bash
git status --short
git branch --show-current
git log --oneline -8
git diff --stat
```

- Worktree sạch là trạng thái bàn giao mặc định.
- Nếu worktree bẩn, coi mọi thay đổi chưa commit là của người dùng hoặc agent
  khác. Đọc diff, không xóa, stash, reset, checkout hoặc ghi đè chúng.
- Chỉ tiếp tục khi thay đổi mới không chồng lấn và nguồn gốc phần đang dở đã rõ;
  nếu không, báo người dùng trước khi sửa.
- Không dùng `git push --force`. Không sửa history đã chia sẻ.

## Chống conflict giữa nhiều agent

- Cách an toàn nhất là làm tuần tự trên `main`: agent trước phải test, cập nhật
  `docs/AI_HANDOFF.md`, commit và để worktree sạch trước khi agent sau bắt đầu.
- Nếu thật sự làm song song, mỗi agent phải dùng một branch và Git worktree
  riêng, ví dụ `agent/claude-asset-handover`; không cho hai agent sửa cùng một
  worktree hoặc cùng một branch.
- Mỗi commit chỉ chứa một phần việc có thể kiểm tra độc lập. Không gom thay đổi
  không liên quan và không tự commit phần việc của người khác.
- Chỉ push/deploy/chạy migration trên môi trường từ xa khi yêu cầu hiện tại cho
  phép. Agent không phải chủ repository phải tạo branch/PR; `main` không được
  force-push hoặc xóa.

## Bất biến nghiệp vụ và bảo mật

- Mọi truy vấn dữ liệu người dùng phải scope bằng `req.userId`/`user_id`; quan hệ
  phòng, khách, hóa đơn và hợp đồng phải giữ cùng chủ sở hữu.
- Không đưa JWT trở lại `localStorage`. Phiên đăng nhập dùng cookie `HttpOnly` và
  account context phải ngăn tab/tài khoản cũ ghi đè state của tài khoản mới.
- CCCD luôn được che mặc định. Mở/xuất bản đầy đủ phải kiểm tra quyền, yêu cầu lý
  do hoặc mật khẩu đúng luồng, không cache và ghi audit không chứa số CCCD.
- Giá phòng/dịch vụ thay đổi bằng mốc hiệu lực; không tính lại hóa đơn snapshot
  cũ. Tháng vào ở tính cả ngày bắt đầu thuê.
- Thanh toán, cọc, điều chỉnh, webhook và nhật ký nhạy cảm ưu tiên append-only và
  idempotent; không xóa dấu vết tài chính để “sửa” dữ liệu.
- Không log request body, cookie, token, secret, connection string hoặc dữ liệu
  nhạy cảm. Không đọc/in giá trị `.env` khi tệp `.env.*.example` đã đủ để làm việc.
- Không commit secret. Secret từng lộ phải được thu hồi/rotate, không chỉ xóa khỏi
  commit mới.

Chi tiết lý do của các bất biến nằm trong `docs/AI_DECISIONS.md`.

## Quy ước code và database

- Runtime là Node.js 20+, backend Express/CommonJS trong `server/`, frontend
  JavaScript/CSS/HTML thuần ở thư mục gốc, database là PostgreSQL/Neon.
- Giữ thay đổi nhỏ, theo pattern hiện có; dùng prepared parameters cho SQL và
  escape mọi dữ liệu người dùng đưa vào HTML.
- Thay đổi schema phải đồng bộ `server/schema.sql` và thêm migration tiến tới,
  có thể chạy lại an toàn. Không sửa migration đã áp dụng để thay đổi lịch sử.
- Migration phải giữ/cấp đúng quyền tối thiểu cho runtime role
  `tro_bill_runtime_sql`; staging trước, production sau và chỉ khi đã có quyền.
- Khi code mới cần schema mới để khởi động/readiness, áp dụng và xác minh migration
  trước khi phát hành code đó.
- Frontend tĩnh được cache theo query version; khi sửa asset đã tham chiếu bằng
  `?v=...`, tăng version tương ứng trong HTML.

## Kiểm thử và phát hành

Chạy test mục tiêu trong lúc phát triển, rồi trước bàn giao chạy tối thiểu:

```bash
npm test
npm run check:secrets
git diff --check
```

- Thay đổi UI phải được kiểm tra ở kích thước liên quan; popup phải khóa scroll
  nền và không tràn viewport.
- Thay đổi in/PDF phải tạo PDF thật, kiểm tra số trang và nhìn tất cả trang; không
  chỉ kiểm tra HTML hoặc ảnh trang đầu.
- Thay đổi DB/permission cần có test schema và truy vấn xác minh trên từng môi
  trường được phép.
- Sau deploy, kiểm tra `/api/health/ready`, revision production và luồng người
  dùng bị ảnh hưởng. Không tuyên bố xong nếu chỉ có build xanh.
- Chỉ đánh dấu `[x]` trong checklist khi tiêu chí thật sự đạt và có bằng chứng.

## Bàn giao bắt buộc khi kết thúc phiên

Cập nhật `docs/AI_HANDOFF.md` trong cùng commit cuối của phần việc:

- trạng thái `Đang làm`, `Bị chặn` hoặc `Sẵn sàng bàn giao`;
- phạm vi và tệp đã thay đổi;
- migration đã/chưa chạy trên môi trường nào;
- test/kiểm tra đã chạy và kết quả;
- commit/deployment ứng dụng gần nhất đã xác minh (không cố tự tham chiếu commit
  chỉ chứa bản cập nhật handoff);
- blocker, giả định còn mở và đúng **một bước an toàn tiếp theo**.

Chỉ ghi sự thật đã kiểm chứng, quyết định và bằng chứng. Không lưu chain-of-thought,
toàn bộ hội thoại, token, dữ liệu khách thuê hoặc secret. Khi một quyết định kiến
trúc/nghiệp vụ thay đổi, thêm mục mới vào `docs/AI_DECISIONS.md` và đánh dấu mục
cũ được thay thế thay vì âm thầm viết lại lịch sử.
