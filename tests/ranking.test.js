import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForecast } from '../src/ranking.js';

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

test('chooses lower values and earliest exact ties separately before and after sunset', () => {
  const hours = [hour('2026-11-02', '12:00'), hour('2026-11-02', '10:00'),
    hour('2026-11-02', '18:00', { temperature: 50, uv: 0 }),
    hour('2026-11-02', '22:00', { temperature: 50, uv: 0 }),
    hour('2026-11-02', '19:00', { temperature: 55, uv: 0 })];
  const result = analyzeForecast({ days: [day()], hours }, now);
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
  const result = analyzeForecast({ days: [day()], hours }, time('2026-11-02T08:30:00Z'));
  assert.equal(result.days[0].daylight.best.time, hours[2].time);
  assert.equal(result.days[0].afterDark.best.time, hours[3].time);
  assert.equal(result.minima.temperature.value, 60);
});

test('missing AQI never beats a complete hour and cannot become a weekly best', () => {
  const hours = [hour('2026-11-02', '10:00'),
    hour('2026-11-02', '11:00', { aqi: null, temperature: 0, uv: 0, precipitation: 0, precipitationProbability: 0 }),
    hour('2026-11-03', '09:00', { aqi: null, temperature: 20 }),
    hour('2026-11-03', '18:00', { aqi: null })];
  const result = analyzeForecast({ days: [day(), day('2026-11-03')], hours }, now);
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
  const result = analyzeForecast({ days: [day()], hours }, now);
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
  const result = analyzeForecast({ days: [day()], hours }, now);
  // The later hour wins temperature + AQI; precipitation counts only once.
  assert.equal(result.bestDaylight.time, hours[1].time);
});

test('daily scores share a reference population with weekly picks', () => {
  const hours = [hour('2026-11-02', '10:00', { temperature: 80, aqi: 50, uv: 6 }),
    hour('2026-11-02', '11:00', { temperature: 75, aqi: 45, uv: 5 }),
    hour('2026-11-03', '10:00', { temperature: 50, aqi: 15, uv: 1 }),
    hour('2026-11-03', '11:00', { temperature: 55, aqi: 20, uv: 2 })];
  const result = analyzeForecast({ days: [day(), day('2026-11-03')], hours }, now);
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
