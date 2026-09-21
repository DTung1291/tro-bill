'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const ocr = fs.readFileSync(path.join(root, 'ocr.js'), 'utf8');

test('popup OCR có ngữ nghĩa dialog và quy trình ba bước', () => {
  assert.match(
    html,
    /id="ocr-modal" role="dialog" aria-modal="true" aria-labelledby="ocr-modal-title" aria-describedby="ocr-modal-description"/
  );
  assert.match(html, /aria-label="Quy trình đọc chỉ số"[\s\S]*data-ocr-step="capture"[\s\S]*data-ocr-step="adjust"[\s\S]*data-ocr-step="review"/);
  assert.match(html, /Chọn ảnh[\s\S]*Căn dãy số[\s\S]*Xác nhận/);
});

test('vùng chụp, kết quả và quyền riêng tư được phân cấp rõ', () => {
  assert.match(html, /class="ocr-workspace"[\s\S]*id="ocr-video-wrap"[\s\S]*id="ocr-crop-canvas"/);
  assert.match(html, /id="ocr-source-camera-btn"[\s\S]*id="ocr-source-upload-btn"/);
  assert.match(html, /class="ocr-review-card"[\s\S]*id="ocr-result-input"[\s\S]*id="ocr-status" role="status" aria-live="polite"/);
  assert.match(html, /Ảnh màu trong khung xem được tái mã hóa[\s\S]*Ảnh gốc và dữ liệu vị trí không được tải lên/);
});

test('ảnh có thể được thay riêng và zoom tự do bằng nhiều cách', () => {
  assert.match(html, /id="ocr-zoom-out"[\s\S]*id="ocr-zoom-slider" min="0\.1" max="10" step="0\.05"[\s\S]*id="ocr-zoom-in"[\s\S]*id="ocr-zoom-reset"/);
  assert.match(html, /id="ocr-zoom-value"[\s\S]*id="ocr-zoom-help"/);
  assert.match(ocr, /const OCR_ZOOM_MIN = 0\.1;[\s\S]*const OCR_ZOOM_MAX = 10;/);
  assert.match(ocr, /ocr-source-upload-btn'\)\.addEventListener\('click', \(\) => fileInput\.click\(\)\)/);
  assert.match(ocr, /ocr-source-camera-btn'\)\.addEventListener\('click', _restartOcrCamera\)/);
  assert.match(ocr, /ocr-zoom-out'\)\.addEventListener[\s\S]*ocr-zoom-in'\)\.addEventListener[\s\S]*ocr-zoom-reset'\)\.addEventListener/);
  assert.match(ocr, /canvas\.addEventListener\('wheel'[\s\S]*_setOcrZoom[\s\S]*canvas\.addEventListener\('touchmove'[\s\S]*_setOcrZoom/);
  assert.match(ocr, /file\.size > 20 \* 1024 \* 1024/);
  assert.match(ocr, /if \(!_ocrPhotoOnly\) \{[\s\S]*_processCropArea\(\)/);
  assert.match(ocr, /\[960, 540\][\s\S]*\[480, 270\][\s\S]*exportCtx\.drawImage\(_ocrImage/);
  assert.match(css, /\.ocr-modal-inner\[data-mode="photo"\] \.ocr-guide-box,[\s\S]*\.ocr-modal-inner\[data-mode="photo"\] \.ocr-crop-preview-wrap,[\s\S]*display:\s*none;/);
  assert.match(ocr, /Toàn bộ khung màu đang thấy sẽ được lưu/);
});

test('popup khóa chiều cao, chỉ cuộn thân và hành động an toàn trên mobile', () => {
  assert.match(css, /\.modal\.ocr-modal-inner\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.ocr-modal-body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]*?\.ocr-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*?\.ocr-primary-actions\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test('trạng thái bước thay đổi theo ảnh và kết quả nhận diện', () => {
  assert.match(ocr, /const OCR_STAGE_ORDER = \['capture', 'adjust', 'review'\]/);
  assert.match(ocr, /_setOcrStage\('capture'\)/);
  assert.match(ocr, /_setOcrStage\('adjust'\)/);
  assert.match(ocr, /_setOcrStage\('review'\)/);
  assert.match(ocr, /setAttribute\('aria-current', 'step'\)/);
});

test('nhập chỉ số thủ công mở xác nhận và chỉ chấp nhận số nguyên không âm', () => {
  assert.match(ocr, /function _syncOcrConfirmation\(\)[\s\S]*\^\\d\+\$[\s\S]*confirmBtn\.disabled = !hasValidReading/);
  assert.match(ocr, /ocr-result-input'\)\.addEventListener\('input'[\s\S]*_syncOcrConfirmation\(\)/);
  assert.match(ocr, /Number\.isSafeInteger\(val\)/);
  assert.match(ocr, /if \(!sourceCanvas \|\| !_ocrImage \|\| _cameraActive\) return ''/);
});

test('camera lỗi vẫn cho chọn ảnh và asset pin được tăng', () => {
  assert.match(ocr, /Camera không khả dụng[\s\S]*captureBtn\.disabled = true[\s\S]*libraryBtn\.textContent = 'Chọn ảnh'/);
  assert.match(html, /href="style\.css\?v=164"[\s\S]*src="ocr\.js\?v=94"[\s\S]*src="app\.js\?v=161"/);
});
