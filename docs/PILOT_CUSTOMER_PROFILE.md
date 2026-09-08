# Hồ sơ khách hàng mục tiêu và tuyển pilot

Phiên bản: 1.0 — 08/09/2026 (Asia/Ho_Chi_Minh)

## Trạng thái bằng chứng

Hồ sơ này chốt **giả thuyết khách hàng mục tiêu ban đầu** để tuyển người phỏng
vấn và pilot. Nó chưa chứng minh nhu cầu thị trường, mức giá hoặc thông điệp bán
hàng. Những kết luận đó chỉ được cập nhật sau khi có bằng chứng từ ít nhất 10
cuộc phỏng vấn và 5 khách pilot phù hợp.

## Khách hàng mục tiêu chính

TrọBill ưu tiên **chủ trọ trực tiếp vận hành 10–50 phòng**, thường có 1–3 khu,
tự lập bill hoặc có một nhóm nhỏ hỗ trợ. Người tham gia phải là chủ sở hữu hoặc
người có quyền quyết định dùng phần mềm và thay đổi quy trình thu tiền.

Một khách phù hợp khi đáp ứng toàn bộ điều kiện:

1. Đang có từ 10 đến 50 phòng cho thuê thực tế, không chỉ là kế hoạch xây mới.
2. Có chu kỳ lập bill lặp lại hằng tháng cho tiền phòng và ít nhất một khoản điện,
   nước hoặc dịch vụ.
3. Trực tiếp theo dõi tiền đã thu, tiền còn thiếu hoặc giao việc này cho tối đa
   vài nhân viên.
4. Có thể mô tả quy trình hiện tại và cho xem dữ liệu mẫu đã ẩn danh; không yêu
   cầu đưa dữ liệu khách thuê thật vào repository hoặc công cụ khảo sát công khai.
5. Sẵn sàng thử ít nhất hai kỳ bill và phản hồi cả lỗi lẫn thời gian tiết kiệm
   được.

## Công việc cần giải quyết — giả thuyết để kiểm chứng

Khi đến kỳ thu tiền, chủ trọ cần chốt đúng tiền phòng và dịch vụ, gửi thông tin
thanh toán/QR, nhận biết giao dịch nào thuộc hóa đơn nào và theo dõi công nợ mà
không phải ghép thủ công nhiều bảng tính, tin nhắn và ứng dụng ngân hàng.

Đây là giả thuyết phỏng vấn, chưa được dùng để đánh dấu “ba vấn đề lớn nhất” hoặc
chốt thông điệp marketing trong checklist.

## Thứ tự ưu tiên tuyển người phỏng vấn

Ưu tiên trước các trường hợp có nhiều tín hiệu vận hành cần TrọBill:

- quản lý từ hai khu trở lên hoặc có người cùng vận hành;
- có thanh toán một phần, thu nợ cũ hoặc nhiều tài khoản nhận tiền;
- đang lập bill bằng Excel/sổ tay rồi gửi thủ công qua tin nhắn;
- từng nhầm kỳ, nhầm số tiền, bỏ sót công nợ hoặc mất thời gian đối soát;
- sẵn sàng dùng dữ liệu thật trên tài khoản riêng sau khi đã export/backup.

## Ngoài phạm vi pilot đầu tiên

- Dưới 10 phòng: vẫn có thể dùng Free hoặc tham gia phỏng vấn, nhưng không thay
  thế mẫu khách mục tiêu 10–50 phòng.
- Trên 50 phòng, chuỗi quản lý chuyên nghiệp hoặc cần tích hợp ERP/kế toán tùy
  biến: ghi nhận cho giai đoạn Business, không để yêu cầu riêng làm lệch pilot.
- Đơn vị yêu cầu TrọBill giữ hộ tiền thuê, tự phát hành HĐĐT thuế khi chưa được
  provider xác minh hoặc cam kết pháp lý riêng: chưa nhận vào pilot.
- Người không có quyền quyết định và không trực tiếp biết quy trình bill/thu nợ:
  có thể cung cấp góc nhìn phụ, nhưng không tính là một cuộc phỏng vấn đủ chuẩn.

## Bộ câu hỏi sàng lọc

1. Hiện đang quản lý bao nhiêu phòng hoạt động và bao nhiêu khu?
2. Ai là người chốt chỉ số, lập bill, gửi bill và đối soát tiền?
3. Mỗi tháng có khoảng bao nhiêu hóa đơn và bao nhiêu giao dịch cần ghép?
4. Đang dùng sổ, Excel, ứng dụng ngân hàng hay phần mềm nào cho từng bước?
5. Có thanh toán một phần, nợ qua kỳ hoặc nhiều tài khoản nhận tiền không?
6. Người trả lời có quyền quyết định thử phần mềm bằng dữ liệu thật không?
7. Có thể dành thời gian phản hồi trong hai chu kỳ bill liên tiếp không?

## Cách ghi bằng chứng an toàn

- Gán mã `I01`–`I10` cho phỏng vấn và `P01`–`P05` cho pilot.
- Không commit tên, email, số điện thoại, địa chỉ, CCCD, số tài khoản hoặc dữ liệu
  khách thuê vào Git. Danh sách liên hệ phải nằm trong công cụ riêng tư do chủ
  sản phẩm kiểm soát.
- Trong repository chỉ ghi kết luận đã ẩn danh: dải số phòng, số khu, công cụ
  hiện tại, bước mất thời gian, loại sai sót, tần suất và trích dẫn đã diễn giải.
- Không tính một cuộc trao đổi là hoàn thành nếu thiếu số phòng, vai trò người
  trả lời, quy trình hiện tại hoặc một ví dụ sự cố cụ thể.

## Mẫu biên bản phỏng vấn ẩn danh

```text
Mã: I__
Ngày:
Vai trò: chủ trọ / người quyết định vận hành
Quy mô: 10–25 / 26–50 phòng; số khu:
Quy trình hiện tại:
Bước mất thời gian nhất + tần suất:
Sự cố/thất thoát gần nhất (đã ẩn danh):
Cách đang khắc phục:
Tín hiệu sẵn sàng pilot: có / không / cần theo dõi
Điều kiện hoặc lo ngại:
```

## Tiêu chí chuyển sang bước tiếp theo

Chỉ đánh dấu mục “phỏng vấn ít nhất 10 chủ trọ” khi có đủ 10 biên bản đạt chuẩn,
trong đó người trả lời thuộc đúng vai trò và mẫu 10–50 phòng. Sau đó tổng hợp vấn
đề theo số người gặp, tần suất và hậu quả thực tế; không xếp hạng chỉ theo ý kiến
của đội phát triển.

Tiến độ và biên bản ẩn danh được ghi trong `docs/PILOT_INTERVIEW_LOG.md`. Mười
hàng `Chưa thực hiện` ban đầu không phải bằng chứng phỏng vấn.
