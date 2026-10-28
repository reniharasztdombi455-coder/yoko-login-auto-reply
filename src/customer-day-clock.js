'use strict';

const DAY_MS = 86400000;
const BOUNDARY_HOUR_JST = 5;
const MAX_DAY = 10;

function timestampMs(value) {
  let n = Number(value || 0) || 0;
  if (n > 0 && n < 1e12) n *= 1000;
  return n;
}

const TOKYO_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function businessDayOrdinalJst(value = Date.now()) {
  const ms = timestampMs(value) || Date.now();
  // Shift the instant backwards by the 05:00 operational boundary, then read
  // the calendar date in Asia/Tokyo.  Thus 00:00-04:59 JST still belongs to
  // the previous operational day.
  const shifted = ms - BOUNDARY_HOUR_JST * 60 * 60 * 1000;
  const parts = TOKYO_DAY_FORMATTER.formatToParts(new Date(shifted));
  const pick = type => Number(parts.find(part => part.type === type)?.value || 0) || 0;
  const year = pick('year'), month = pick('month'), day = pick('day');
  if (!year || !month || !day) return NaN;
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function labelForRawDay(rawDay = 0) {
  const raw = Math.max(0, Number(rawDay || 0) || 0);
  if (!raw) return '未归类';
  return raw > MAX_DAY ? '第10天+' : `第${Math.min(MAX_DAY, raw)}天`;
}

function stateFromCalibration(calibration = null, now = Date.now()) {
  const row = calibration && typeof calibration === 'object' ? calibration : {};
  const selectedDay = Math.max(0, Math.min(MAX_DAY, Number(row.selectedDay || 0) || 0));
  const anchorOrdinal = Number(row.anchorOrdinal);
  if (!selectedDay || !Number.isFinite(anchorOrdinal)) return null;
  const currentOrdinal = businessDayOrdinalJst(now);
  if (!Number.isFinite(currentOrdinal)) return null;
  const rawDay = Math.max(1, selectedDay + (currentOrdinal - anchorOrdinal));
  const day = Math.min(MAX_DAY, rawDay);
  return {
    selectedDay,
    anchorOrdinal,
    currentOrdinal,
    rawDay,
    day,
    group: `day${day}`,
    label: labelForRawDay(rawDay),
    calibrated: true,
    calibratedAt: Math.max(0, timestampMs(row.calibratedAt) || 0)
  };
}

module.exports = {
  BOUNDARY_HOUR_JST,
  MAX_DAY,
  timestampMs,
  businessDayOrdinalJst,
  labelForRawDay,
  stateFromCalibration
};
