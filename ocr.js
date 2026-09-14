/**
 * TrọBill — ocr.js
 * OCR module: nhận diện chữ số từ ảnh chụp công tơ điện/nước
 * Sử dụng Tesseract.js (Offline Client-side, CDN lazy load)
 * Phiên bản tương tác: Cho phép người dùng kéo, zoom và đổi màu (invert) ảnh trước khi quét
 *
 * API công khai:
 *   openOcrModal(roomId, targetField, onConfirm, options)
 *     roomId      — ID phòng (để hiển thị thông tin)
 *     targetField — 'elec' | 'water'
 *     onConfirm   — callback(number, { photoDataUrl }) khi người dùng xác nhận
 */

'use strict';

// ============================================================
//  TESSERACT LAZY LOADER
// ============================================================
let _tesseractWorker = null;
let _tesseractLoading = false;
let _tesseractReady = false;
const _tesseractCDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

async function ensureTesseract() {
  if (_tesseractReady) return true;
  if (_tesseractLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (_tesseractReady || !_tesseractLoading) {
          clearInterval(check);
          resolve(_tesseractReady);
        }
      }, 100);
    });
  }

  _tesseractLoading = true;

  if (typeof Tesseract !== 'undefined') {
    _tesseractReady = true;
    _tesseractLoading = false;
    return true;
  }

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = _tesseractCDN;
    script.onload = () => {
      _tesseractReady = true;
      _tesseractLoading = false;
      resolve(true);
    };
    script.onerror = () => {
      _tesseractLoading = false;
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

// ============================================================
//  OCR INTERACTIVE CAMERA & IMAGE STATES
// ============================================================
let _ocrStream = null;          // Stream camera
let _ocrCallback = null;        // Callback trả kết quả
let _ocrPhotoOnly = false;      // Chỉ lưu ảnh, không thay chỉ số hóa đơn
let _cameraActive = false;      // Trạng thái camera đang chạy live
let _cameraLoopId = null;       // ID requestAnimationFrame cho camera loop

let _ocrImage = null;           // Đối tượng ảnh tĩnh hiện tại (khi import hoặc sau khi chụp)
let _panX = 0;                  // Tọa độ dịch chuyển X
let _panY = 0;                  // Tọa độ dịch chuyển Y
let _zoom = 1.0;                // Hệ số thu phóng
let _isDragging = false;        // Đang drag để di chuyển ảnh
let _startX = 0;                // Tọa độ click/touch bắt đầu X
let _startY = 0;                // Tọa độ click/touch bắt đầu Y
let _fitZoom = 1.0;             // Mức zoom vừa khung của ảnh hiện tại

const OCR_ZOOM_MIN = 0.1;
const OCR_ZOOM_MAX = 10;

function _clampOcrZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(OCR_ZOOM_MIN, Math.min(OCR_ZOOM_MAX, zoom));
}

function _syncOcrZoomControls() {
  const enabled = !!_ocrImage && !_cameraActive;
  const slider = document.getElementById('ocr-zoom-slider');
  const output = document.getElementById('ocr-zoom-value');
  const zoomOut = document.getElementById('ocr-zoom-out');
  const zoomIn = document.getElementById('ocr-zoom-in');
  const zoomReset = document.getElementById('ocr-zoom-reset');
  if (slider) {
    slider.value = _clampOcrZoom(_zoom).toFixed(2);
    slider.disabled = !enabled;
  }
  if (output) output.textContent = `${Math.round(_clampOcrZoom(_zoom) * 100)}%`;
  if (zoomOut) zoomOut.disabled = !enabled || _zoom <= OCR_ZOOM_MIN;
  if (zoomIn) zoomIn.disabled = !enabled || _zoom >= OCR_ZOOM_MAX;
  if (zoomReset) zoomReset.disabled = !enabled;
}

function _setOcrZoom(value) {
  if (!_ocrImage || _cameraActive) return;
  _zoom = _clampOcrZoom(value);
  _syncOcrZoomControls();
  _drawCanvas();
}

function _resetOcrImageView() {
  if (!_ocrImage || _cameraActive) return;
  _panX = 0;
  _panY = 0;
  _setOcrZoom(_fitZoom);
}

// Kích thước vùng crop (guide box) trên Canvas 1280x720
// Thu hẹp chiều cao từ 200 xuống 110 và rộng từ 896 xuống 768 để loại bỏ nhãn (10000, 1000...) và chữ tiêu đề.
const CROP_W = 768;
const CROP_H = 110;
const CROP_X = (1280 - CROP_W) / 2; // 256
const CROP_Y = (720 - CROP_H) / 2;   // 305

// ============================================================
//  MAIN RENDERING PIPELINE
// ============================================================
function _drawCanvas() {
  const canvas = document.getElementById('ocr-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const video = document.getElementById('ocr-video');

  // Clear canvas
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (_cameraActive) {
    // 1. Vẽ live camera frame
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
  } else if (_ocrImage) {
    // 2. Vẽ ảnh tĩnh với Pan & Zoom
    ctx.save();
    // Di chuyển tâm vẽ về giữa canvas để zoom phóng từ giữa
    ctx.translate(canvas.width / 2 + _panX, canvas.height / 2 + _panY);
    ctx.scale(_zoom, _zoom);
    ctx.translate(-_ocrImage.width / 2, -_ocrImage.height / 2);
    ctx.drawImage(_ocrImage, 0, 0);
    ctx.restore();
  }

  if (!_ocrPhotoOnly) {
    // OCR chỉ đọc dải số đã xử lý; ảnh minh chứng dùng toàn bộ khung màu riêng.
    _processCropArea();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, CROP_Y);
    ctx.fillRect(0, CROP_Y + CROP_H, canvas.width, CROP_Y);
    ctx.fillRect(0, CROP_Y, CROP_X, CROP_H);
    ctx.fillRect(CROP_X + CROP_W, CROP_Y, CROP_X, CROP_H);

    ctx.strokeStyle = '#ff3b3b';
    ctx.lineWidth = 4;
    ctx.strokeRect(CROP_X, CROP_Y, CROP_W, CROP_H);
  }
}

/**
 * Lấy vùng ảnh nằm trong khung ngắm, tiền xử lý và hiển thị ở crop canvas bên dưới
 */
function _processCropArea() {
  const canvas = document.getElementById('ocr-canvas');
  const cropCanvas = document.getElementById('ocr-crop-canvas');
  if (!canvas || !cropCanvas) return;
  const cropCtx = cropCanvas.getContext('2d');

  // Copy vùng ngắm (CROP_X, CROP_Y, CROP_W, CROP_H) của canvas chính sang crop canvas (448x100)
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(canvas, CROP_X, CROP_Y, CROP_W, CROP_H, 0, 0, cropCanvas.width, cropCanvas.height);

  // Tiền xử lý điểm ảnh trên crop canvas
  const imgData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  const data = imgData.data;
  const invert = document.getElementById('ocr-invert-check').checked;

  for (let i = 0; i < data.length; i += 4) {
    // 1. Chuyển sang Grayscale (Luminance)
    let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    // 2. Tăng độ tương phản (Contrast Boost)
    gray = (gray - 128) * 1.8 + 128;
    gray = Math.min(255, Math.max(0, gray));

    // 3. Đảo màu nếu là chữ sáng nền tối
    if (invert) {
      gray = 255 - gray;
    }

    data[i] = data[i + 1] = data[i + 2] = gray;
  }

  cropCtx.putImageData(imgData, 0, 0);
}

function _meterPhotoDataUrl() {
  const sourceCanvas = document.getElementById('ocr-canvas');
  if (!sourceCanvas || !_ocrImage || _cameraActive) return '';

  // Dựng lại toàn bộ viewport màu, không kèm overlay/khung OCR và không giữ EXIF/GPS.
  for (const [width, height] of [[960, 540], [800, 450], [640, 360], [480, 270]]) {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) continue;
    exportCtx.fillStyle = '#000';
    exportCtx.fillRect(0, 0, width, height);
    exportCtx.save();
    exportCtx.scale(width / sourceCanvas.width, height / sourceCanvas.height);
    exportCtx.translate(sourceCanvas.width / 2 + _panX, sourceCanvas.height / 2 + _panY);
    exportCtx.scale(_zoom, _zoom);
    exportCtx.translate(-_ocrImage.width / 2, -_ocrImage.height / 2);
    exportCtx.drawImage(_ocrImage, 0, 0);
    exportCtx.restore();

    for (const quality of [0.82, 0.68, 0.55, 0.42]) {
      const dataUrl = exportCanvas.toDataURL('image/jpeg', quality);
      const base64Length = dataUrl.split(',')[1]?.length || 0;
      if (Math.ceil(base64Length * 3 / 4) <= 96 * 1024) return dataUrl;
    }
  }
  return '';
}

// Loop vẽ camera
function _cameraLoop() {
  if (!_cameraActive) return;
  _drawCanvas();
  _cameraLoopId = requestAnimationFrame(_cameraLoop);
}

// ============================================================
//  OCR MODAL FLOWS
// ============================================================
function openOcrModal(roomId, targetField, onConfirm, options = {}) {
  if (typeof checkPremiumFeature === 'function') {
    checkPremiumFeature('Quét chỉ số bằng Camera (OCR)', () => {
      _openOcrModalActual(roomId, targetField, onConfirm, options);
    });
  } else {
    _openOcrModalActual(roomId, targetField, onConfirm, options);
  }
}

const OCR_STAGE_ORDER = ['capture', 'adjust', 'review'];

function _setOcrStage(stage) {
  const card = document.querySelector('#ocr-modal .ocr-modal-inner');
  if (!card || !OCR_STAGE_ORDER.includes(stage)) return;
  card.dataset.stage = stage;

  const activeIndex = OCR_STAGE_ORDER.indexOf(stage);
  card.querySelectorAll('[data-ocr-step]').forEach((step) => {
    const stepIndex = OCR_STAGE_ORDER.indexOf(step.dataset.ocrStep);
    step.classList.toggle('is-active', stepIndex === activeIndex);
    step.classList.toggle('is-complete', stepIndex < activeIndex);
    if (stepIndex === activeIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function _setOcrStatus(message, tone = '') {
  const statusEl = document.getElementById('ocr-status');
  if (!statusEl) return;
  statusEl.textContent = message;
  if (tone) statusEl.dataset.tone = tone;
  else statusEl.removeAttribute('data-tone');
}

function _syncOcrConfirmation() {
  const resultInput = document.getElementById('ocr-result-input');
  const confirmBtn = document.getElementById('ocr-confirm-btn');
  if (!resultInput || !confirmBtn) return;
  if (_ocrPhotoOnly) {
    const hasPhoto = !!_ocrImage && !_cameraActive;
    confirmBtn.disabled = !hasPhoto;
    if (hasPhoto) _setOcrStage('review');
    return;
  }
  const hasValidReading = /^\d+$/.test(resultInput.value.trim());
  confirmBtn.disabled = !hasValidReading;
  if (hasValidReading) _setOcrStage('review');
}

function _openOcrModalActual(roomId, targetField, onConfirm, options = {}) {
  _ocrCallback = onConfirm;
  _ocrPhotoOnly = options.photoOnly === true;
  const modal = document.getElementById('ocr-modal');
  const card = modal?.querySelector('.ocr-modal-inner');
  const titleEl = document.getElementById('ocr-modal-title');
  const kicker = document.getElementById('ocr-modal-kicker');
  const journey = document.getElementById('ocr-journey');
  const descriptionEl = document.getElementById('ocr-modal-description');
  const reviewHeading = document.getElementById('ocr-review-heading');
  const reviewDescription = document.getElementById('ocr-review-description');
  const confirmBtn = document.getElementById('ocr-confirm-btn');
  const resultInput = document.getElementById('ocr-result-input');
  const zoomSlider = document.getElementById('ocr-zoom-slider');
  const invertCheck = document.getElementById('ocr-invert-check');
  const captureHeading = document.getElementById('ocr-capture-heading');
  const captureDescription = document.getElementById('ocr-capture-description');
  const adjustStepTitle = document.getElementById('ocr-adjust-step-title');
  const adjustStepDescription = document.getElementById('ocr-adjust-step-description');
  const guideHint = document.getElementById('ocr-guide-hint');

  const meterLabel = targetField === 'elec' ? 'điện' : 'nước';
  kicker.textContent = _ocrPhotoOnly ? 'Ảnh minh chứng hóa đơn' : 'Ghi chỉ số bằng ảnh';
  journey.setAttribute('aria-label', _ocrPhotoOnly ? 'Quy trình chỉnh ảnh minh chứng' : 'Quy trình đọc chỉ số');
  titleEl.textContent = _ocrPhotoOnly ? `Thêm ảnh đồng hồ ${meterLabel}` : `Chụp chỉ số ${meterLabel}`;
  descriptionEl.textContent = _ocrPhotoOnly
    ? 'Chụp hoặc tải ảnh màu, kéo và zoom tùy ý rồi lưu làm minh chứng cho hóa đơn.'
    : 'Chụp hoặc chọn ảnh, căn đúng dãy số rồi kiểm tra kết quả trước khi dùng.';
  reviewHeading.textContent = _ocrPhotoOnly ? 'Xác nhận ảnh' : 'Kiểm tra chỉ số';
  reviewDescription.textContent = _ocrPhotoOnly
    ? 'Kiểm tra lần cuối toàn bộ khung ảnh màu trước khi lưu.'
    : 'Bạn có thể sửa trực tiếp nếu máy đọc chưa chính xác.';
  captureHeading.textContent = _ocrPhotoOnly ? 'Chọn và căn ảnh minh chứng' : 'Chụp và căn dãy số công tơ';
  captureDescription.textContent = _ocrPhotoOnly
    ? 'Kéo và zoom ảnh theo ý muốn. Toàn bộ khung màu đang thấy sẽ được lưu.'
    : 'Giữ ảnh rõ, đủ sáng và chỉ đặt dãy số cần đọc trong khung đỏ.';
  adjustStepTitle.textContent = _ocrPhotoOnly ? 'Căn ảnh' : 'Căn dãy số';
  adjustStepDescription.textContent = _ocrPhotoOnly ? 'Kéo và zoom tùy ý' : 'Đưa số vào đúng khung';
  guideHint.textContent = _ocrPhotoOnly ? 'Toàn bộ khung màu này sẽ được lưu' : 'Căn dãy số vào khung đỏ';
  confirmBtn.textContent = _ocrPhotoOnly ? 'Lưu ảnh' : 'Dùng chỉ số này';
  if (card) card.dataset.mode = _ocrPhotoOnly ? 'photo' : 'reading';
  resultInput.value = '';
  _setOcrStatus('Đang khởi động camera...');
  document.getElementById('ocr-confirm-btn').disabled = true;
  invertCheck.checked = false;
  zoomSlider.value = 1.0;

  _ocrImage = null;
  _panX = 0;
  _panY = 0;
  _zoom = 1;
  _fitZoom = 1;
  _cameraActive = true;
  _syncOcrZoomControls();
  _setOcrStage('capture');

  // Cập nhật trạng thái nút
  _updateButtonUI();

  modal.hidden = false;
  _startCamera();
}

function closeOcrModal() {
  _stopCamera();
  document.getElementById('ocr-modal').hidden = true;
  _ocrCallback = null;
  _ocrPhotoOnly = false;
  _ocrImage = null;
  _syncOcrZoomControls();
}

async function _startCamera() {
  const video = document.getElementById('ocr-video');
  try {
    _ocrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = _ocrStream;
    video.play();
    _cameraActive = true;
    _updateButtonUI();
    _setOcrStage('capture');
    _setOcrStatus(_ocrPhotoOnly
      ? 'Đặt toàn bộ đồng hồ trong khung rồi bấm “Chụp ảnh”.'
      : 'Đặt dãy số công tơ vào khung đỏ rồi bấm “Chụp ảnh”.');
    _cameraLoopId = requestAnimationFrame(_cameraLoop);
  } catch (err) {
    _cameraActive = false;
    _updateButtonUI();
    _setOcrStatus('Không truy cập được camera. Hãy chọn ảnh từ thiết bị.', 'error');
    console.warn('Camera stream error:', err);
    // Draw empty canvas overlay to keep layout clean
    _drawCanvas();
  }
}

function _stopCamera() {
  _cameraActive = false;
  if (_cameraLoopId) {
    cancelAnimationFrame(_cameraLoopId);
    _cameraLoopId = null;
  }
  if (_ocrStream) {
    _ocrStream.getTracks().forEach(t => t.stop());
    _ocrStream = null;
  }
  const video = document.getElementById('ocr-video');
  video.srcObject = null;
}

function _updateButtonUI() {
  const captureBtn = document.getElementById('ocr-capture-btn');
  const libraryBtn = document.getElementById('ocr-library-btn');

  if (_cameraActive) {
    captureBtn.textContent = 'Chụp ảnh';
    captureBtn.className = 'btn btn--primary';
    captureBtn.disabled = false;
    libraryBtn.textContent = 'Chọn ảnh';
  } else if (_ocrImage) {
    captureBtn.textContent = _ocrPhotoOnly ? 'Dùng khung ảnh này' : 'Nhận diện chỉ số';
    captureBtn.className = 'btn btn--success';
    captureBtn.disabled = false;
    libraryBtn.textContent = 'Chọn ảnh khác';
  } else {
    captureBtn.textContent = 'Camera không khả dụng';
    captureBtn.className = 'btn btn--primary';
    captureBtn.disabled = true;
    libraryBtn.textContent = 'Chọn ảnh';
  }
  _syncOcrZoomControls();
}

function _loadOcrImage(source) {
  const canvas = document.getElementById('ocr-canvas');
  if (!canvas || !source) return;
  const image = new Image();
  image.onload = () => {
    _ocrImage = image;
    _panX = 0;
    _panY = 0;
    const fitScale = Math.min(canvas.width / image.width, canvas.height / image.height);
    _fitZoom = _clampOcrZoom(fitScale);
    _zoom = _fitZoom;
    _drawCanvas();
    _updateButtonUI();
    _setOcrStage('adjust');
    _setOcrStatus(_ocrPhotoOnly
      ? 'Kéo hoặc zoom ảnh tùy ý; toàn bộ khung màu đang thấy sẽ được lưu.'
      : 'Kéo hoặc thu phóng để đưa dãy số vào khung đỏ, sau đó bấm “Nhận diện chỉ số”.');
  };
  image.onerror = () => {
    _ocrImage = null;
    _updateButtonUI();
    _setOcrStatus('Không đọc được tệp ảnh. Hãy chọn ảnh JPG, PNG hoặc WebP hợp lệ.', 'error');
  };
  image.src = source;
}

function _restartOcrCamera() {
  _stopCamera();
  _ocrImage = null;
  _panX = 0;
  _panY = 0;
  _zoom = 1;
  _fitZoom = 1;
  _updateButtonUI();
  _setOcrStage('capture');
  _setOcrStatus('Đang khởi động camera...');
  _startCamera();
}

// ============================================================
//  OCR CORE (Tesseract API)
// ============================================================
async function recognizeDigits(imageSource) {
  const available = await ensureTesseract();
  if (!available) throw new Error('Tesseract.js không tải được (cần Internet lần đầu)');

  // Khởi tạo worker của Tesseract.js
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: () => {} // Tắt logs verbose để giảm tải console
  });

  await worker.setParameters({
    tessedit_char_whitelist: '0123456789', // Chỉ nhận dạng chữ số
    tessedit_pageseg_mode: '7',            // Xem ảnh như một dòng chữ duy nhất (Single text line)
  });

  const { data } = await worker.recognize(imageSource);
  await worker.terminate();

  // Trích xuất chỉ các ký tự số
  const digits = data.text.replace(/\D/g, '').trim();
  return digits;
}

// ============================================================
//  OCR ACTIONS
// ============================================================
async function _runOcr() {
  const resultInput = document.getElementById('ocr-result-input');
  const confirmBtn = document.getElementById('ocr-confirm-btn');
  const cropCanvas = document.getElementById('ocr-crop-canvas');

  _setOcrStage('review');
  _setOcrStatus('Đang phân tích chữ số...');
  resultInput.value = '';
  confirmBtn.disabled = true;

  try {
    // Quét trực tiếp trên ảnh đã tiền xử lý ở crop canvas
    const digits = await recognizeDigits(cropCanvas);

    if (digits && digits.length > 0) {
      resultInput.value = digits;
      _setOcrStatus(`Đã nhận diện ${digits}. Hãy đối chiếu lại với ảnh.`, 'success');
      _syncOcrConfirmation();
      resultInput.focus();
      resultInput.select();
    } else {
      _setOcrStatus('Không nhận dạng được số. Hãy căn ảnh rõ hơn hoặc thử “Chữ sáng trên nền tối”.', 'error');
    }
  } catch (err) {
    _setOcrStatus(`Không thể nhận diện: ${err.message}`, 'error');
    console.error('OCR run error:', err);
  }
}

// ============================================================
//  BIND EVENTS AND INTERACTIONS
// ============================================================
function initOcrModalEvents() {
  const modal = document.getElementById('ocr-modal');
  const canvas = document.getElementById('ocr-canvas');
  if (!modal || !canvas) return;

  // Đóng modal
  document.getElementById('ocr-modal-close').addEventListener('click', closeOcrModal);
  document.getElementById('ocr-cancel-btn').addEventListener('click', closeOcrModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeOcrModal(); });

  // Nút chụp ảnh / nhận diện (Dynamic action)
  document.getElementById('ocr-capture-btn').addEventListener('click', () => {
    if (_cameraActive) {
      // 1. Chụp ảnh từ camera stream
      _stopCamera();
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext('2d');
      // Lấy frame hiện tại trước khi stop camera
      tempCtx.drawImage(canvas, 0, 0);

      _loadOcrImage(tempCanvas.toDataURL('image/jpeg'));
    } else {
      // 2. Chạy OCR hoặc xác nhận vùng ảnh dùng làm minh chứng.
          if (_ocrPhotoOnly) {
            _setOcrStage('review');
            _setOcrStatus('Ảnh màu đã sẵn sàng. Kiểm tra toàn bộ khung bên trên rồi bấm “Lưu ảnh”.', 'success');
        _syncOcrConfirmation();
      } else {
        _runOcr();
      }
    }
  });

  // Chọn hoặc thay ảnh từ thiết bị; camera có nút nguồn riêng trong vùng làm việc.
  const fileInput = document.getElementById('ocr-file-input');
  document.getElementById('ocr-library-btn').addEventListener('click', () => fileInput.click());
  document.getElementById('ocr-source-upload-btn').addEventListener('click', () => fileInput.click());
  document.getElementById('ocr-source-camera-btn').addEventListener('click', _restartOcrCamera);

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      _setOcrStatus('Tệp đã chọn không phải hình ảnh.', 'error');
      fileInput.value = '';
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      _setOcrStatus('Ảnh vượt quá 20 MB. Hãy chọn ảnh nhỏ hơn.', 'error');
      fileInput.value = '';
      return;
    }

    _stopCamera();
    const reader = new FileReader();
    reader.onload = (event) => {
      _loadOcrImage(event.target.result);
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  // Thay đổi thanh Zoom
  document.getElementById('ocr-zoom-slider').addEventListener('input', (e) => {
    _setOcrZoom(e.target.value);
  });
  document.getElementById('ocr-zoom-out').addEventListener('click', () => {
    _setOcrZoom(_zoom / 1.15);
  });
  document.getElementById('ocr-zoom-in').addEventListener('click', () => {
    _setOcrZoom(_zoom * 1.15);
  });
  document.getElementById('ocr-zoom-reset').addEventListener('click', _resetOcrImageView);

  // Thay đổi Checkbox Invert
  document.getElementById('ocr-invert-check').addEventListener('change', () => {
    _drawCanvas();
  });

  document.getElementById('ocr-result-input').addEventListener('input', () => {
    _syncOcrConfirmation();
    const rawValue = document.getElementById('ocr-result-input').value.trim();
    if (/^\d+$/.test(rawValue)) {
      _setOcrStatus('Chỉ số đã được nhập thủ công. Hãy đối chiếu lại với ảnh trước khi dùng.', 'success');
    }
  });

  // Xác nhận kết quả điền vào form
  document.getElementById('ocr-confirm-btn').addEventListener('click', () => {
    const rawValue = document.getElementById('ocr-result-input').value.trim();
    const val = Number(rawValue);
    const photoDataUrl = _meterPhotoDataUrl();
    if (_ocrPhotoOnly && photoDataUrl && _ocrCallback) {
      _ocrCallback(null, { photoDataUrl });
      closeOcrModal();
    } else if (_ocrPhotoOnly && !photoDataUrl) {
      _setOcrStatus('Không thể tối ưu ảnh trong giới hạn lưu trữ. Hãy thử thu nhỏ hoặc chọn ảnh khác.', 'error');
    } else if (/^\d+$/.test(rawValue) && Number.isSafeInteger(val) && _ocrCallback) {
      _ocrCallback(val, { photoDataUrl });
      closeOcrModal();
    }
  });

  // ============================================================
  //  MOUSE & TOUCH GESTURES (PAN IMAGE)
  // ============================================================
  const getEventPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const startDrag = (e) => {
    if (!_ocrImage) return;
    _isDragging = true;
    const pos = getEventPos(e);
    _startX = pos.x - _panX;
    _startY = pos.y - _panY;
  };

  const drag = (e) => {
    if (!_isDragging || !_ocrImage) return;
    const pos = getEventPos(e);
    _panX = pos.x - _startX;
    _panY = pos.y - _startY;
    _drawCanvas();
    
    // Ngăn cuộn trang web khi đang vuốt canvas trên mobile
    if (e.cancelable) e.preventDefault();
  };

  const endDrag = () => {
    _isDragging = false;
  };

  // Chuột
  canvas.addEventListener('mousedown', startDrag);
  canvas.addEventListener('mousemove', drag);
  window.addEventListener('mouseup', endDrag);

  // Cuộn con trỏ chuột để Zoom (Wheel zoom)
  canvas.addEventListener('wheel', (e) => {
    if (!_ocrImage) return;
    e.preventDefault();
    _setOcrZoom(_zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // Touch Pinch-to-zoom & Pan
  let _initialTouchDistance = null;
  let _initialTouchZoom = 1.0;

  const getTouchDistance = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  canvas.addEventListener('touchstart', (e) => {
    if (!_ocrImage) return;
    if (e.touches.length === 2) {
      _isDragging = false;
      _initialTouchDistance = getTouchDistance(e.touches);
      _initialTouchZoom = _zoom;
    } else if (e.touches.length === 1) {
      startDrag(e);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!_ocrImage) return;
    if (e.touches.length === 2 && _initialTouchDistance) {
      if (e.cancelable) e.preventDefault();
      const currentDist = getTouchDistance(e.touches);
      const scale = currentDist / _initialTouchDistance;
      _setOcrZoom(_initialTouchZoom * scale);
    } else if (e.touches.length === 1 && _isDragging) {
      drag(e);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      _initialTouchDistance = null;
    }
    if (e.touches.length === 0) {
      endDrag();
    }
  });
}
