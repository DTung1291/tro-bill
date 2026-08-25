'use strict';

const crypto = require('crypto');
const db = require('./db');

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const METER_TYPES = new Set(['electricity', 'water']);
const MAX_PHOTO_BYTES = 96 * 1024;
const DATA_URL_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

class RentMeterPhotoError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendPhotoError(res, error) {
  if (!(error instanceof RentMeterPhotoError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function photoInput(body = {}) {
  const roomId = String(body.roomId || '').trim();
  const period = String(body.period || '').trim();
  const meterType = String(body.meterType || '').trim();
  const dataUrl = String(body.dataUrl || '').trim();
  if (!roomId || roomId.length > 200 || !PERIOD_PATTERN.test(period) || !METER_TYPES.has(meterType)) {
    throw new RentMeterPhotoError(400, 'INVALID_METER_PHOTO', 'Thông tin ảnh đồng hồ không hợp lệ');
  }
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) {
    throw new RentMeterPhotoError(400, 'INVALID_METER_PHOTO', 'Ảnh đồng hồ phải là JPEG hợp lệ');
  }
  const imageData = Buffer.from(match[1], 'base64');
  if (imageData.toString('base64') !== match[1]
      || imageData.length < 100
      || imageData.length > MAX_PHOTO_BYTES
      || imageData[0] !== 0xff
      || imageData[1] !== 0xd8
      || imageData[2] !== 0xff
      || imageData[imageData.length - 2] !== 0xff
      || imageData[imageData.length - 1] !== 0xd9) {
    throw new RentMeterPhotoError(400, 'INVALID_METER_PHOTO', 'Ảnh đồng hồ không hợp lệ hoặc vượt quá 96 KB');
  }
  return {
    roomId,
    period,
    meterType,
    imageData,
    sha256: crypto.createHash('sha256').update(imageData).digest('hex')
  };
}

function photoJson(row) {
  return {
    roomId: row.room_id,
    period: row.period,
    meterType: row.meter_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    updatedAt: row.updated_at
  };
}

async function upsertMeterPhoto(req, res) {
  let input;
  try {
    input = photoInput(req.body);
  } catch (error) {
    if (sendPhotoError(res, error)) return res;
    throw error;
  }
  const room = await db.query(
    'SELECT 1 FROM rooms WHERE user_id=$1 AND id=$2',
    [req.userId, input.roomId]
  );
  if (!room.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy phòng', code: 'ROOM_NOT_FOUND' });
  }
  const { rows } = await db.query(
    `INSERT INTO rent_meter_photos
       (user_id, room_id, period, meter_type, mime_type, image_data, byte_size, sha256)
     VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7)
     ON CONFLICT (user_id, room_id, period, meter_type) DO UPDATE SET
       mime_type='image/jpeg', image_data=EXCLUDED.image_data,
       byte_size=EXCLUDED.byte_size, sha256=EXCLUDED.sha256, updated_at=now()
     RETURNING room_id, period, meter_type, byte_size, sha256, updated_at`,
    [
      req.userId,
      input.roomId,
      input.period,
      input.meterType,
      input.imageData,
      input.imageData.length,
      input.sha256
    ]
  );
  res.set('Cache-Control', 'no-store');
  return res.status(201).json({ photo: photoJson(rows[0]) });
}

module.exports = {
  DATA_URL_PATTERN,
  MAX_PHOTO_BYTES,
  METER_TYPES,
  RentMeterPhotoError,
  photoInput,
  photoJson,
  upsertMeterPhoto
};
