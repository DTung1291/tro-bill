# Báo cáo lỗ hổng bảo mật TrọBill

## Kênh báo cáo riêng tư

Không đăng lỗ hổng, token, cookie, ảnh CCCD, dữ liệu khách thuê hoặc thông tin
tài khoản vào GitHub Issue công khai.

Hãy mở tab **Security** của repository, chọn **Advisories** rồi
**Report a vulnerability** để gửi báo cáo riêng tư cho chủ repository. Nếu bạn
không thấy nút này, chỉ gửi một Issue công khai nói rằng cần kênh liên hệ bảo
mật; không đưa chi tiết kỹ thuật hoặc dữ liệu nhạy cảm vào Issue đó.

Báo cáo nên có:

- URL/môi trường và thời điểm phát hiện;
- loại tài khoản dùng để kiểm tra, không gửi mật khẩu hoặc cookie;
- các bước tái hiện tối thiểu bằng dữ liệu giả;
- tác động quan sát được và `incidentId`/`requestId` nếu ứng dụng hiển thị;
- ảnh hoặc log đã che toàn bộ thông tin định danh và secret.

## Phạm vi kiểm tra an toàn

Chỉ kiểm tra bằng tài khoản và dữ liệu do bạn sở hữu hoặc được phép sử dụng.
Không truy cập dữ liệu của người khác, không làm gián đoạn dịch vụ, không thử
social engineering, không phá hủy dữ liệu và không tiếp tục khai thác sau khi đã
đủ bằng chứng tái hiện. TrọBill chưa vận hành chương trình thưởng lỗi bảo mật.

## Quy trình xử lý

Người phụ trách repository sẽ:

1. xác nhận báo cáo có đủ thông tin để tái hiện;
2. phân loại mức độ ảnh hưởng và cô lập phạm vi nếu cần;
3. sửa trên môi trường tách biệt, chạy regression test và kiểm tra dữ liệu;
4. phát hành bản sửa, giám sát lỗi rồi phối hợp công bố khi an toàn;
5. lưu nguyên nhân và biện pháp ngăn tái diễn mà không chép dữ liệu nhạy cảm.

Chưa có SLA phản hồi công khai trong giai đoạn pilot. Thời gian cam kết sẽ chỉ
được công bố sau khi chủ sản phẩm xác nhận kênh hỗ trợ và lịch trực chính thức.

## Phiên bản được hỗ trợ

Nhánh `main` và deployment production hiện tại là phiên bản được duy trì. Bản
Preview chỉ dùng cho kiểm thử được phép và có thể bị xóa bất kỳ lúc nào.
