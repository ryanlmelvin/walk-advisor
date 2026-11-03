import test from 'node:test';
import assert from 'node:assert/strict';
import { completeForecastRange, analyzeForecast } from '../src/ranking.js';

const now = Date.parse('2026-11-02T00:00:00Z');
function fixture() {
  const days = Array.from({ length: 3 }, (_, index) => ({
    date: `2026-11-0${index + 2}`, sunrise: now + index * 86400000 + 6 * 3600000,
    sunset: now + index * 86400000 + 18 * 3600000,
  }));
  const hours = Array.from({ length: 72 }, (_, index) => ({
    time: now + index * 3600000, date: days[Math.floor(index / 24)].date,
    temperature: 60, precipitationProbability: 20, uv: 2, aqi: 40,
  }));
  return { location: { timezone: 'UTC' }, days, hours };
}

test('a partial last day is excluded from the shared range and its recommendations', () => {
  const forecast = fixture();
  forecast.hours.filter((hour) => hour.time >= now + 2 * 86400000 + 15 * 3600000)
    .forEach((hour) => { hour.aqi = null; });
  const available = completeForecastRange(forecast, now);
  assert.deepEqual(available.days.map((day) => day.date), ['2026-11-02', '2026-11-03']);
  assert.equal(available.hours.length, 48);
  assert.ok(available.hours.every((hour) => hour.date !== '2026-11-04'));
  assert.deepEqual(analyzeForecast(available, now).days.map((day) => day.date), ['2026-11-02', '2026-11-03']);
  assert.equal(forecast.days.length, 3, 'source forecast remains intact for future preference changes');
});

test('complete-data days remain offered even when all hours fail the user cutoffs', () => {
  const available = completeForecastRange(fixture(), now);
  const analysis = analyzeForecast(available, now, undefined, { minTemperature: null, maxTemperature: 0 });
  assert.equal(available.days.length, 3);
  assert.equal(analysis.days.length, 3);
  assert.ok(analysis.days.every((day) => day.daylight.best === null && day.afterDark.best === null));
  assert.equal(analysis.days[0].daylight.reason, 'No matching hours.');
});

test('coverage ignores past and out-of-window readings but responds to wider walking hours', () => {
  const forecast = fixture();
  forecast.hours[9].aqi = null; // Past at the checked current time.
  forecast.hours[22].uv = null; // Outside the default walking window.
  const laterNow = now + 10 * 3600000;
  assert.equal(completeForecastRange(forecast, laterNow).days.length, 3);
  assert.equal(completeForecastRange(forecast, laterNow, { earliest: '08:00', latest: '23:00' }).days.length, 0);
});

test('a missing entire hourly row ends the contiguous range', () => {
  const forecast = fixture();
  forecast.hours = forecast.hours.filter((hour) => hour.time !== now + 86400000 + 12 * 3600000);
  const available = completeForecastRange(forecast, now);
  assert.deepEqual(available.days.map((day) => day.date), ['2026-11-02']);
});

test('all missing AQI produces no complete-data days and no weather-only date choices', () => {
  const forecast = fixture();
  forecast.hours.forEach((hour) => { hour.aqi = null; });
  const available = completeForecastRange(forecast, now);
  assert.deepEqual(available.days, []);
  assert.deepEqual(available.hours, []);
  const analysis = analyzeForecast(available, now);
  assert.equal(analysis.bestDaylight, null);
  assert.equal(analysis.bestAfterDark, null);
});

test('availability requires each of the four metrics, but no precipitation amount', () => {
  for (const metric of ['temperature', 'precipitationProbability', 'uv', 'aqi']) {
    const forecast = fixture();
    forecast.hours[12][metric] = null;
    assert.equal(completeForecastRange(forecast, now).days.length, 0, metric);
  }
  assert.equal(completeForecastRange(fixture(), now).days.length, 3);
});

test('local date and last walking hour remain correct across the fall DST transition', () => {
  const start = Date.parse('2026-11-01T05:00:00Z');
  const forecast = {
    location: { timezone: 'America/Chicago' },
    days: [{ date: '2026-11-01', sunrise: Date.parse('2026-11-01T12:20:00Z'), sunset: Date.parse('2026-11-01T22:40:00Z') }],
    hours: Array.from({ length: 25 }, (_, index) => ({
      time: start + index * 3600000, date: '2026-11-01', temperature: 60,
      precipitationProbability: 20, uv: 2, aqi: 40,
    })),
  };
  assert.equal(completeForecastRange(forecast, start).days.length, 1);
  const lastWalkingHour = forecast.hours.find((hour) => hour.time === Date.parse('2026-11-02T03:00:00Z'));
  lastWalkingHour.aqi = null; // 9 PM after the clock change.
  assert.equal(completeForecastRange(forecast, start).days.length, 0);
  assert.equal(completeForecastRange(forecast, start, { earliest: '08:00', latest: '20:00' }).days.length, 1);
});
