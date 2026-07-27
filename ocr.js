/**
 * TrọBill — ocr.js
 * OCR module: nhận diện chữ số từ ảnh chụp công tơ điện/nước
 * Sử dụng Tesseract.js (Offline Client-side, CDN lazy load)
 * Phiên bản tương tác: Cho phép người dùng kéo, zoom và đổi màu (invert) ảnh trước khi quét
 *
 * API công khai:
 *   openOcrModal(roomId, targetField, onConfirm)
 *     roomId      — ID phòng (để hiển thị thông tin)
 *     targetField — 'elec' | 'water'
 *     onConfirm   — callback(number) khi người dùng xác nhận kết quả OCR
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
let _cameraActive = false;      // Trạng thái camera đang chạy live
let _cameraLoopId = null;       // ID requestAnimationFrame cho camera loop

let _ocrImage = null;           // Đối tượng ảnh tĩnh hiện tại (khi import hoặc sau khi chụp)
let _panX = 0;                  // Tọa độ dịch chuyển X
let _panY = 0;                  // Tọa độ dịch chuyển Y
let _zoom = 1.0;                // Hệ số thu phóng
let _isDragging = false;        // Đang drag để di chuyển ảnh
let _startX = 0;                // Tọa độ click/touch bắt đầu X
let _startY = 0;                // Tọa độ click/touch bắt đầu Y

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

  // 3. Thực hiện copy vùng crop và xử lý ảnh (Grayscale + Contrast + Invert)
  _processCropArea();

  // 4. Vẽ overlay tối bên ngoài vùng ngắm đỏ trên màn hình chính
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  // Top
  ctx.fillRect(0, 0, canvas.width, CROP_Y);
  // Bottom
  ctx.fillRect(0, CROP_Y + CROP_H, canvas.width, CROP_Y);
  // Left
  ctx.fillRect(0, CROP_Y, CROP_X, CROP_H);
  // Right
  ctx.fillRect(CROP_X + CROP_W, CROP_Y, CROP_X, CROP_H);

  // 5. Vẽ viền đỏ cho khung ngắm
  ctx.strokeStyle = '#ff3b3b';
  ctx.lineWidth = 4;
  ctx.strokeRect(CROP_X, CROP_Y, CROP_W, CROP_H);
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

// Loop vẽ camera
function _cameraLoop() {
  if (!_cameraActive) return;
  _drawCanvas();
  _cameraLoopId = requestAnimationFrame(_cameraLoop);
}

// ============================================================
//  OCR MODAL FLOWS
// ============================================================
function openOcrModal(roomId, targetField, onConfirm) {
  if (typeof checkPremiumFeature === 'function') {
    checkPremiumFeature('Quét chỉ số bằng Camera (OCR)', () => {
      _openOcrModalActual(roomId, targetField, onConfirm);
    });
  } else {
    _openOcrModalActual(roomId, targetField, onConfirm);
  }
}

function _openOcrModalActual(roomId, targetField, onConfirm) {
  _ocrCallback = onConfirm;
  const modal = document.getElementById('ocr-modal');
  const titleEl = document.getElementById('ocr-modal-title');
  const resultInput = document.getElementById('ocr-result-input');
  const statusEl = document.getElementById('ocr-status');
  const zoomSlider = document.getElementById('ocr-zoom-slider');
  const invertCheck = document.getElementById('ocr-invert-check');

  titleEl.textContent = targetField === 'elec' ? '📷 Chụp chỉ số Điện' : '📷 Chụp chỉ số Nước';
  resultInput.value = '';
  statusEl.textContent = 'Đang khởi động camera...';
  document.getElementById('ocr-confirm-btn').disabled = true;
  invertCheck.checked = false;
  zoomSlider.value = 1.0;

  _ocrImage = null;
  _cameraActive = true;

  // Cập nhật trạng thái nút
  _updateButtonUI();

  modal.hidden = false;
  _startCamera();
}

function closeOcrModal() {
  _stopCamera();
  document.getElementById('ocr-modal').hidden = true;
  _ocrCallback = null;
  _ocrImage = null;
}

async function _startCamera() {
  const video = document.getElementById('ocr-video');
  const statusEl = document.getElementById('ocr-status');
  try {
    _ocrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = _ocrStream;
    video.play();
    _cameraActive = true;
    statusEl.textContent = 'Đặt chỉ số công tơ vào khung đỏ và bấm "Chụp ảnh".';
    _cameraLoopId = requestAnimationFrame(_cameraLoop);
  } catch (err) {
    _cameraActive = false;
    statusEl.textContent = '⚠️ Không truy cập được camera. Hãy chọn ảnh từ thiết bị.';
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
  const confirmBtn = document.getElementById('ocr-confirm-btn');

  if (_cameraActive) {
    captureBtn.textContent = '📸 Chụp ảnh';
    captureBtn.className = 'btn btn--primary';
    libraryBtn.textContent = '🖼️ Chọn ảnh';
  } else {
    captureBtn.textContent = '🔍 Nhận diện';
    captureBtn.className = 'btn btn--success';
    libraryBtn.textContent = '📸 Chụp lại';
  }
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
  const statusEl = document.getElementById('ocr-status');
  const resultInput = document.getElementById('ocr-result-input');
  const confirmBtn = document.getElementById('ocr-confirm-btn');
  const cropCanvas = document.getElementById('ocr-crop-canvas');

  statusEl.textContent = '⏳ Đang phân tích chữ số...';
  resultInput.value = '';
  confirmBtn.disabled = true;

  try {
    // Quét trực tiếp trên ảnh đã tiền xử lý ở crop canvas
    const digits = await recognizeDigits(cropCanvas);

    if (digits && digits.length > 0) {
      resultInput.value = digits;
      statusEl.textContent = `✅ Quét xong: ${digits}. Hãy kiểm tra lại và sửa nếu cần.`;
      confirmBtn.disabled = false;
    } else {
      statusEl.textContent = '❌ Không nhận dạng được số. Hãy căn chỉnh gần/rõ hơn hoặc đổi màu chữ (Invert).';
    }
  } catch (err) {
    statusEl.textContent = `⚠️ Lỗi: ${err.message}`;
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

      _ocrImage = new Image();
      _ocrImage.onload = () => {
        _panX = 0;
        _panY = 0;
        // Zoom mặc định cho vừa màn hình
        _zoom = 1.0;
        document.getElementById('ocr-zoom-slider').value = 1.0;
        _drawCanvas();
        _updateButtonUI();
        document.getElementById('ocr-status').textContent = 'Kéo để căn chỉnh chỉ số công tơ vào khung đỏ.';
      };
      _ocrImage.src = tempCanvas.toDataURL('image/jpeg');
    } else {
      // 2. Chạy OCR nhận diện
      _runOcr();
    }
  });

  // Chọn ảnh từ thư viện / Chụp lại camera
  const fileInput = document.getElementById('ocr-file-input');
  document.getElementById('ocr-library-btn').addEventListener('click', () => {
    if (_cameraActive) {
      // Mở thư viện chọn ảnh
      fileInput.click();
    } else {
      // Chụp lại: Khởi động lại camera
      _ocrImage = null;
      _updateButtonUI();
      _startCamera();
    }
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    _stopCamera();
    const reader = new FileReader();
    reader.onload = (event) => {
      _ocrImage = new Image();
      _ocrImage.onload = () => {
        _panX = 0;
        _panY = 0;
        // Tính toán tỷ lệ zoom để ảnh vừa khít khung nhìn
        const fitScale = Math.min(canvas.width / _ocrImage.width, canvas.height / _ocrImage.height);
        _zoom = Math.max(0.2, Math.min(6.0, fitScale * 1.2)); // Phóng lớn hơn tí cho dễ nhìn
        document.getElementById('ocr-zoom-slider').value = _zoom.toFixed(2);
        
        _drawCanvas();
        _updateButtonUI();
        document.getElementById('ocr-status').textContent = 'Kéo và zoom để đưa dãy số công tơ vào khung ngắm đỏ.';
      };
      _ocrImage.src = event.target.result;
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  // Thay đổi thanh Zoom
  document.getElementById('ocr-zoom-slider').addEventListener('input', (e) => {
    if (_ocrImage) {
      _zoom = parseFloat(e.target.value);
      _drawCanvas();
    }
  });

  // Thay đổi Checkbox Invert
  document.getElementById('ocr-invert-check').addEventListener('change', () => {
    _drawCanvas();
  });

  // Xác nhận kết quả điền vào form
  document.getElementById('ocr-confirm-btn').addEventListener('click', () => {
    const val = parseInt(document.getElementById('ocr-result-input').value, 10);
    if (!isNaN(val) && _ocrCallback) {
      _ocrCallback(val);
    }
    closeOcrModal();
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
    const zoomSlider = document.getElementById('ocr-zoom-slider');
    const zoomStep = 0.1;
    let newZoom = _zoom + (e.deltaY < 0 ? zoomStep : -zoomStep);
    newZoom = Math.max(0.2, Math.min(6.0, newZoom));
    _zoom = newZoom;
    if (zoomSlider) zoomSlider.value = newZoom;
    _drawCanvas();
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
      let newZoom = Math.max(0.2, Math.min(6.0, _initialTouchZoom * scale));
      _zoom = newZoom;
      const zoomSlider = document.getElementById('ocr-zoom-slider');
      if (zoomSlider) zoomSlider.value = newZoom;
      _drawCanvas();
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
