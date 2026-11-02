import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForecast, isWithinWalkingHours, isWithinCutoffs } from '../src/ranking.js';

const time = (value) => Date.parse(value);
const day = (date = '2026-11-02') => ({
  date, sunrise: time(`${date}T06:00:00Z`), sunset: time(`${date}T17:30:00Z`),
});
function hour(date, clock, values = {}) {
  return {
    time: time(`${date}T${clock}:00Z`), date,
    temperature: 60, precipitationProbability: 20, precipitation: 0.1, uv: 2, aqi: 40,
    ...values,
  };
}
const now = time('2026-11-02T00:00:00Z');
const allHours = { earliest: '00:00', latest: '23:59' };
const unlimited = { minTemperature: null, maxTemperature: null, maxPrecipitationProbability: null, maxAqi: null, maxUv: null };

test('chooses lower values and earliest exact ties separately before and after sunset', () => {
  const hours = [hour('2026-11-02', '12:00'), hour('2026-11-02', '10:00'),
    hour('2026-11-02', '18:00', { temperature: 50, uv: 0 }),
    hour('2026-11-02', '22:00', { temperature: 50, uv: 0 }),
    hour('2026-11-02', '19:00', { temperature: 55, uv: 0 })];
  const result = analyzeForecast({ days: [day()], hours }, now, allHours);
  assert.equal(result.days[0].daylight.best.time, hours[1].time);
  assert.equal(result.days[0].afterDark.best.time, hours[2].time);
  assert.equal(result.bestDaylight.time, hours[1].time);
  assert.equal(result.bestAfterDark.time, hours[2].time);
  assert.equal(result.minima.temperature.value, 50);
  assert.deepEqual(result.minima.temperature.times.map((candidate) => candidate.time), [hours[2].time, hours[3].time]);
});

test('past, pre-dawn, and unknown-date hours are excluded; sunset belongs to evening', () => {
  const hours = [hour('2026-11-02', '05:00', { temperature: -40 }),
    hour('2026-11-02', '08:00', { temperature: 0 }), hour('2026-11-02', '09:00'),
    hour('2026-11-02', '17:30'), hour('2026-11-03', '19:00', { temperature: -60 })];
  const result = analyzeForecast({ days: [day()], hours }, time('2026-11-02T08:30:00Z'), allHours);
  assert.equal(result.days[0].daylight.best.time, hours[2].time);
  assert.equal(result.days[0].afterDark.best.time, hours[3].time);
  assert.equal(result.minima.temperature.value, 60);
});

test('missing AQI never beats a complete hour and cannot become a weekly best', () => {
  const hours = [hour('2026-11-02', '10:00'),
    hour('2026-11-02', '11:00', { aqi: null, temperature: 0, uv: 0, precipitation: 0, precipitationProbability: 0 }),
    hour('2026-11-03', '09:00', { aqi: null, temperature: 20 }),
    hour('2026-11-03', '18:00', { aqi: null })];
  const result = analyzeForecast({ days: [day(), day('2026-11-03')], hours }, now, undefined, unlimited);
  assert.equal(result.days[0].daylight.best.time, hours[0].time);
  assert.equal(result.days[0].daylight.complete, true);
  assert.equal(result.days[1].daylight.best.time, hours[2].time);
  assert.equal(result.days[1].daylight.complete, false);
  assert.match(result.days[1].daylight.reason, /weather-only/);
  assert.equal(result.bestDaylight.time, hours[0].time);
  assert.equal(result.bestAfterDark, null);
  assert.equal(result.minima.aqi.value, 40);
});

test('unknown UV and temperature are not zero; all-null AQI minima is null', () => {
  const hours = [hour('2026-11-02', '10:00', { aqi: null, temperature: null }),
    hour('2026-11-02', '11:00', { aqi: null, uv: null }),
    hour('2026-11-02', '12:00', { aqi: null, temperature: 0, uv: 0 })];
  const result = analyzeForecast({ days: [day()], hours }, now, undefined, unlimited);
  assert.equal(result.days[0].daylight.best.time, hours[2].time);
  assert.equal(result.minima.aqi, null);
  assert.equal(result.minima.temperature.value, 0);
  assert.equal(result.bestDaylight, null);
});

test('precipitation chance and amount together have the same weight as each other factor', () => {
  const hours = [hour('2026-11-02', '10:00', {
    temperature: 70, aqi: 20, uv: 0, precipitation: 0, precipitationProbability: 0,
  }), hour('2026-11-02', '11:00', {
    temperature: 60, aqi: 10, uv: 0, precipitation: 10, precipitationProbability: 100,
  })];
  const result = analyzeForecast({ days: [day()], hours }, now, undefined, unlimited);
  // The later hour wins temperature + AQI; precipitation counts only once.
  assert.equal(result.bestDaylight.time, hours[1].time);
});

test('daily scores share a reference population with weekly picks', () => {
  const hours = [hour('2026-11-02', '10:00', { temperature: 80, aqi: 50, uv: 6 }),
    hour('2026-11-02', '11:00', { temperature: 75, aqi: 45, uv: 5 }),
    hour('2026-11-03', '10:00', { temperature: 50, aqi: 15, uv: 1 }),
    hour('2026-11-03', '11:00', { temperature: 55, aqi: 20, uv: 2 })];
  const result = analyzeForecast({ days: [day(), day('2026-11-03')], hours }, now, undefined, unlimited);
  assert.equal(result.bestDaylight.time, hours[2].time);
  assert.ok(result.days[1].daylight.best.rank < result.days[0].daylight.best.rank);
});

test('missing sun times and empty forecasts produce explicit absence, not invented suggestions', () => {
  const result = analyzeForecast({
    days: [{ ...day(), sunrise: null, sunset: null }], hours: [hour('2026-11-02', '10:00')],
  }, now);
  assert.equal(result.days[0].daylight.best, null);
  assert.match(result.days[0].daylight.reason, /unavailable/);
  assert.equal(result.days[0].afterDark.best, null);
  assert.equal(result.minima.aqi, null);
  assert.deepEqual(analyzeForecast({ days: [], hours: [] }, now).days, []);
});

test('default 8 AM–9 PM bounds use the forecast location, even with a different system zone', () => {
  const priorZone = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    const hours = [
      hour('2026-11-02', '15:00', { temperature: 0 }), // 7 AM Los Angeles
      hour('2026-11-02', '16:00', { temperature: 60 }), // 8 AM
      { ...hour('2026-11-02', '21:00', { temperature: 50 }), time: time('2026-11-03T05:00:00Z') }, // 9 PM
      { ...hour('2026-11-02', '22:00', { temperature: -10 }), time: time('2026-11-03T06:00:00Z') }, // 10 PM
    ];
    const result = analyzeForecast({
      location: { timezone: 'America/Los_Angeles' },
      days: [{ date: '2026-11-02', sunrise: time('2026-11-02T14:00:00Z'), sunset: time('2026-11-03T01:30:00Z') }],
      hours,
    }, now);
    assert.equal(result.bestDaylight.time, hours[1].time);
    assert.equal(result.bestAfterDark.time, hours[2].time);
    assert.equal(result.minima.temperature.value, 50);
    assert.deepEqual(result.minima.aqi.times.map((point) => point.time), [hours[1].time, hours[2].time]);
    assert.equal(isWithinWalkingHours(hours[0], 'America/Los_Angeles'), false);
    assert.equal(isWithinWalkingHours(hours[1], 'America/Los_Angeles'), true);
    assert.equal(isWithinWalkingHours(hours[2], 'America/Los_Angeles'), true);
    assert.equal(isWithinWalkingHours(hours[3], 'America/Los_Angeles'), false);
  } finally {
    if (priorZone === undefined) delete process.env.TZ;
    else process.env.TZ = priorZone;
  }
});

test('custom minute bounds exclude 8 AM and 9 PM from every recommendation and minimum', () => {
  const hours = [hour('2026-11-02', '08:00', { temperature: 0 }),
    hour('2026-11-02', '09:00', { temperature: 30 }),
    hour('2026-11-02', '20:00', { temperature: 40 }),
    hour('2026-11-02', '21:00', { temperature: -10 })];
  const bounds = { earliest: '08:30', latest: '20:30' };
  const result = analyzeForecast({ location: { timezone: 'UTC' }, days: [day()], hours }, now, bounds, unlimited);
  assert.equal(result.bestDaylight.time, hours[1].time);
  assert.equal(result.bestAfterDark.time, hours[2].time);
  assert.equal(result.minima.temperature.value, 30);
  assert.deepEqual(result.minima.aqi.times.map((point) => point.time), [hours[1].time, hours[2].time]);
  assert.equal(isWithinWalkingHours(hour('2026-11-02', '08:30'), 'UTC', bounds), true);
  assert.equal(isWithinWalkingHours(hour('2026-11-02', '20:30'), 'UTC', bounds), true);
  assert.equal(isWithinWalkingHours(hour('2026-11-02', '20:31'), 'UTC', bounds), false);
});

test('invalid or reversed walking bounds fall back together to 8 AM–9 PM', () => {
  for (const bounds of [null, {}, { earliest: '22:00', latest: '08:00' },
    { earliest: '8:00', latest: '20:00' }, { earliest: '07:00', latest: '24:00' },
    { earliest: '08:60', latest: '22:00' }]) {
    assert.equal(isWithinWalkingHours(hour('2026-11-02', '07:00'), 'UTC', bounds), false);
    assert.equal(isWithinWalkingHours(hour('2026-11-02', '08:00'), 'UTC', bounds), true);
    assert.equal(isWithinWalkingHours(hour('2026-11-02', '21:00'), 'UTC', bounds), true);
    assert.equal(isWithinWalkingHours(hour('2026-11-02', '22:00'), 'UTC', bounds), false);
  }
});

test('a window with no hourly starts returns explicit walking-hours reasons and no minima', () => {
  const result = analyzeForecast({
    days: [day()], hours: [hour('2026-11-02', '08:00'), hour('2026-11-02', '09:00')],
  }, now, { earliest: '08:30', latest: '08:45' });
  assert.equal(result.bestDaylight, null);
  assert.equal(result.bestAfterDark, null);
  assert.equal(result.days[0].daylight.best, null);
  assert.equal(result.days[0].afterDark.best, null);
  assert.equal(result.days[0].daylight.reason, 'No matching hours.');
  assert.equal(result.days[0].afterDark.reason, 'No matching hours.');
  assert.ok(Object.values(result.minima).every((minimum) => minimum === null));
});

test('clock filtering follows repeated DST hours and retains the pre-dawn exclusion', () => {
  const beforeFallback = { time: time('2026-11-01T06:00:00Z') };
  const afterFallback = { time: time('2026-11-01T07:00:00Z') };
  const bounds = { earliest: '01:00', latest: '01:00' };
  assert.equal(isWithinWalkingHours(beforeFallback, 'America/Chicago', bounds), true);
  assert.equal(isWithinWalkingHours(afterFallback, 'America/Chicago', bounds), true);
  const result = analyzeForecast({
    location: { timezone: 'America/Chicago' },
    days: [{ date: '2026-11-01', sunrise: time('2026-11-01T12:20:00Z'), sunset: time('2026-11-01T22:40:00Z') }],
    hours: [{ ...hour('2026-11-01', '01:00'), ...beforeFallback }, { ...hour('2026-11-01', '01:00'), ...afterFallback }],
  }, time('2026-11-01T00:00:00Z'), bounds);
  assert.equal(result.bestDaylight, null);
  assert.equal(result.bestAfterDark, null);
});

test('default cutoffs include exact endpoints and reject any factor beyond them', () => {
  const boundary = hour('2026-11-02', '10:00', {
    temperature: 32, precipitationProbability: 33, aqi: 50, uv: 5,
  });
  assert.equal(isWithinCutoffs(boundary), true);
  assert.equal(isWithinCutoffs({ ...boundary, temperature: 80 }), true);
  for (const change of [{ temperature: 31.9 }, { temperature: 80.1 },
    { precipitationProbability: 33.1 }, { aqi: 50.1 }, { uv: 5.1 }]) {
    assert.equal(isWithinCutoffs({ ...boundary, ...change }), false);
  }
});

test('violating hours are removed before ranking, minima, and weekly picks', () => {
  const hours = [hour('2026-11-02', '09:00', { temperature: 31 }),
    hour('2026-11-02', '10:00', { temperature: 33, aqi: 51 }),
    hour('2026-11-02', '11:00', { temperature: 34, precipitationProbability: 34 }),
    hour('2026-11-02', '12:00', { temperature: 35, uv: 5.1 }),
    hour('2026-11-02', '13:00', { temperature: 40 }),
    hour('2026-11-02', '18:00', { temperature: 81 })];
  const result = analyzeForecast({ days: [day()], hours }, now);
  assert.equal(result.bestDaylight.time, hours[4].time);
  assert.equal(result.bestDaylight.rank, 0);
  assert.equal(result.minima.temperature.value, 40);
  assert.deepEqual(result.minima.aqi.times.map((point) => point.time), [hours[4].time]);
  assert.equal(result.bestAfterDark, null);
  assert.equal(result.days[0].afterDark.reason, 'No matching hours.');
});

test('blank or null disables a cutoff without changing omitted defaults', () => {
  const cold = hour('2026-11-02', '10:00', { temperature: -20, precipitationProbability: 100, aqi: 200, uv: 12 });
  const hot = { ...cold, temperature: 110 };
  assert.equal(isWithinCutoffs(cold, unlimited), true);
  assert.equal(isWithinCutoffs(hot, unlimited), true);
  const blanks = { minTemperature: '', maxTemperature: ' ', maxPrecipitationProbability: '', maxAqi: '', maxUv: '' };
  assert.equal(isWithinCutoffs(cold, blanks), true);
  assert.equal(isWithinCutoffs(hot, blanks), true);
  assert.equal(isWithinCutoffs(hour('2026-11-02', '10:00', { aqi: 200 }), { maxAqi: null }), true);
  assert.equal(isWithinCutoffs(hour('2026-11-02', '10:00', { temperature: 81, aqi: 200 }), { maxAqi: null }), false);
});

test('zero remains a hard cutoff and missing readings never become zero', () => {
  const zeroLimits = { minTemperature: null, maxTemperature: 0, maxPrecipitationProbability: 0, maxAqi: 0, maxUv: 0 };
  const zero = hour('2026-11-02', '10:00', { temperature: 0, precipitationProbability: 0, aqi: 0, uv: 0 });
  assert.equal(isWithinCutoffs(zero, zeroLimits), true);
  for (const metric of ['temperature', 'precipitationProbability', 'aqi', 'uv']) {
    assert.equal(isWithinCutoffs({ ...zero, [metric]: 0.1 }, zeroLimits), false);
    assert.equal(isWithinCutoffs({ ...zero, [metric]: null }, zeroLimits), false);
  }
  assert.equal(isWithinCutoffs({ ...zero, aqi: null }, zeroLimits, { allowMissingAqi: true }), true);
  assert.equal(isWithinCutoffs({ ...zero, uv: null }, zeroLimits, { allowMissingAqi: true }), false);
  const result = analyzeForecast({ days: [day()], hours: [zero] }, now, undefined, zeroLimits);
  assert.equal(result.bestDaylight.time, zero.time);
  assert.equal(result.minima.temperature.value, 0);
});

test('invalid numeric cutoffs and reversed temperature bounds restore their defaults', () => {
  const normal = hour('2026-11-02', '10:00');
  for (const maxAqi of [undefined, NaN, Infinity, 'not a number', true]) {
    assert.equal(isWithinCutoffs(normal, { maxAqi }), true);
    assert.equal(isWithinCutoffs({ ...normal, aqi: 51 }, { maxAqi }), false);
  }
  const reversed = { minTemperature: 100, maxTemperature: 20 };
  assert.equal(isWithinCutoffs(normal, reversed), true);
  assert.equal(isWithinCutoffs({ ...normal, temperature: 20 }, reversed), false);
  assert.equal(isWithinCutoffs({ ...normal, temperature: 90 }, reversed), false);
});

test('missing AQI permits only a weather-only fallback that passes weather limits', () => {
  const missing = hour('2026-11-02', '09:00', { aqi: null, temperature: 40 });
  const knownBad = hour('2026-11-02', '10:00', { aqi: 55, temperature: 35 });
  const coldMissing = hour('2026-11-02', '11:00', { aqi: null, temperature: 20 });
  assert.equal(isWithinCutoffs(missing), false);
  assert.equal(isWithinCutoffs(missing, undefined, { allowMissingAqi: true }), true);
  assert.equal(isWithinCutoffs(knownBad, undefined, { allowMissingAqi: true }), false);
  assert.equal(isWithinCutoffs(coldMissing, undefined, { allowMissingAqi: true }), false);
  const result = analyzeForecast({ days: [day()], hours: [missing, knownBad, coldMissing] }, now);
  assert.equal(result.days[0].daylight.best.time, missing.time);
  assert.equal(result.days[0].daylight.complete, false);
  assert.match(result.days[0].daylight.reason, /AQI cutoff cannot be checked/);
  assert.equal(result.bestDaylight, null);
  assert.equal(result.minima.aqi, null);
  assert.equal(result.minima.temperature.value, 40);
});

test('all failed cutoffs leave no recommendations or minima', () => {
  const result = analyzeForecast({ days: [day()], hours: [
    hour('2026-11-02', '09:00', { temperature: 20 }),
    hour('2026-11-02', '10:00', { aqi: 51 }),
    hour('2026-11-02', '18:00', { precipitationProbability: 34 }),
    hour('2026-11-02', '19:00', { uv: 6 }),
  ] }, now);
  assert.equal(result.bestDaylight, null);
  assert.equal(result.bestAfterDark, null);
  assert.equal(result.days[0].daylight.reason, 'No matching hours.');
  assert.equal(result.days[0].afterDark.reason, 'No matching hours.');
  assert.ok(Object.values(result.minima).every((minimum) => minimum === null));
});

test('disabled UV bound still cannot turn a missing UV reading into a complete forecast', () => {
  const result = analyzeForecast({ days: [day()], hours: [hour('2026-11-02', '10:00', { uv: null })] },
    now, undefined, { maxUv: null });
  assert.equal(result.bestDaylight, null);
  assert.equal(result.days[0].daylight.reason, 'Forecast unavailable.');
});
