'use strict';

const { localDateKey, diffLocalCalendarDays } = require('./daily-flow-clock');

const NEW_START_MINUTE = 5 * 60;
const DAY_CUTOVER_MINUTE = 23 * 60;
const DAY_COUNT = 10;

function timestampMs(value) {
  let n = Number(value || 0) || 0;
  if (n > 0 && n < 1e12) n *= 1000;
  return n;
}

function businessDateKey(value = Date.now()) {
  const ms = timestampMs(value) || Date.now();
  const d = new Date(ms);
  if ((d.getHours() * 60 + d.getMinutes()) < NEW_START_MINUTE) d.setDate(d.getDate() - 1);
  return localDateKey(d.getTime());
}

function businessStartAt(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  if ((d.getHours() * 60 + d.getMinutes()) < NEW_START_MINUTE) d.setDate(d.getDate() - 1);
  d.setHours(5, 0, 0, 0);
  return d.getTime();
}

function stateFromArrival(arrivalAt = 0, now = Date.now()) {
  const arrived = timestampMs(arrivalAt);
  if (!arrived) return { arrivalAt:0, businessDateKey:'', day:0, rawDay:0, group:'unknown', label:'未归类' };
  const cohortKey = businessDateKey(arrived);
  const todayKey = localDateKey(now);
  const d = new Date(Number(now) || Date.now());
  const minute = d.getHours() * 60 + d.getMinutes();
  let day = diffLocalCalendarDays(cohortKey, todayKey) + (minute >= DAY_CUTOVER_MINUTE ? 1 : 0);
  if (Number(now) < arrived) day = 0;
  day = Math.max(0, day);
  if (day <= 0) return { arrivalAt:arrived, businessDateKey:cohortKey, day:0, rawDay:0, group:'new', label:'新客户' };
  const capped = Math.min(DAY_COUNT, day);
  return {
    arrivalAt:arrived,
    businessDateKey:cohortKey,
    day:capped,
    rawDay:day,
    group:`day${capped}`,
    label:capped >= DAY_COUNT && day > DAY_COUNT ? '第10天+' : `第${capped}天`
  };
}

module.exports = {
  NEW_START_MINUTE,
  DAY_CUTOVER_MINUTE,
  DAY_COUNT,
  timestampMs,
  businessDateKey,
  businessStartAt,
  stateFromArrival
};
