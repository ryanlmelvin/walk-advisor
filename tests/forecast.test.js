import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchForecast, searchLocations } from '../src/forecast.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const seconds = (iso) => Date.parse(iso) / 1000;
const location = { name: 'Chicago', latitude: 41.88, longitude: -87.63 };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function weatherFixture() {
  return {
    timezone: 'America/Chicago', utc_offset_seconds: -18000,
    latitude: 41.9, longitude: -87.6, elevation: 180,
    daily: {
      // Open-Meteo keeps the request-time offset for daily labels across DST.
      time: [seconds('2026-11-01T05:00:00Z'), seconds('2026-11-02T05:00:00Z')],
      sunrise: [seconds('2026-11-01T12:20:00Z'), seconds('2026-11-02T12:21:00Z')],
      sunset: [seconds('2026-11-01T22:40:00Z'), seconds('2026-11-02T22:39:00Z')],
    },
    hourly: {
      time: [seconds('2026-11-01T06:00:00Z'), seconds('2026-11-01T07:00:00Z'),
        seconds('2026-11-02T05:00:00Z'), seconds('2026-11-02T06:00:00Z')],
      temperature_2m: [40, 39, 32, null],
      precipitation_probability: [10, 0, 5, 10],
      precipitation: [0.2, 0, 0.1, 0], uv_index: [1, 0, 0, null],
    },
  };
}

test('joins AQI by absolute timestamp and groups days in location time zone across DST', async () => {
  const weather = weatherFixture();
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return response(url.hostname.startsWith('air-quality') ? {
      latitude: 42, longitude: -87.5,
      hourly: { time: [weather.hourly.time[2], weather.hourly.time[0]], us_aqi: [34, 0] },
    } : weather);
  };
  const data = await fetchForecast(location);
  assert.equal(data.location.timezone, 'America/Chicago');
  assert.deepEqual(data.days.map((day) => day.date), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(data.hours.map((hour) => hour.date), ['2026-11-01', '2026-11-01', '2026-11-01', '2026-11-02']);
  assert.deepEqual(data.hours.map((hour) => hour.aqi), [0, null, 34, null]);
  assert.equal(data.hours[0].precipitationProbability, 0);
  assert.equal(data.hours[1].precipitationProbability, null);
  assert.equal(data.hours[3].temperature, null);
  assert.equal(data.hours[3].uv, null);
  assert.match(data.warnings[0], /does not cover every hour/);
  assert.ok(requests.every((url) => url.searchParams.get('forecast_days') === (url.hostname.startsWith('air-quality') ? '7' : '8')));
  assert.ok(requests.every((url) => url.searchParams.get('timeformat') === 'unixtime'));
});

test('walk-start precipitation and mean UV use the following hour while temperature and AQI stay at the start', async () => {
  const weather = weatherFixture();
  const start = seconds('2026-11-02T18:00:00Z');
  // Deliberately unordered so an index shift would give the wrong aggregates.
  weather.hourly = {
    time: [start, start + 7200, start + 3600],
    temperature_2m: [60, 70, 65],
    precipitation_probability: [0, 90, 40], precipitation: [0, 5, 1], uv_index: [1, 8, 4],
  };
  globalThis.fetch = async (url) => response(url.hostname.startsWith('air-quality')
    ? { hourly: { time: [start, start + 3600, start + 7200], us_aqi: [25, 35, 45] } } : weather);
  const data = await fetchForecast(location);
  assert.equal(data.hours[0].temperature, 60);
  assert.equal(data.hours[0].aqi, 25);
  assert.equal(data.hours[0].precipitationProbability, 40);
  assert.equal(data.hours[0].precipitation, 1);
  assert.equal(data.hours[0].uv, 4);
  assert.equal(data.hours[1].precipitationProbability, 90);
  assert.equal(data.hours[1].precipitation, 5);
  assert.equal(data.hours[1].uv, 8);
  // No later aggregate means unknown, not a reused last value or zero.
  assert.equal(data.hours[2].precipitationProbability, null);
  assert.equal(data.hours[2].precipitation, null);
  assert.equal(data.hours[2].uv, null);
});

test('the eighth weather day supplies the last walk hour without appearing as an eighth forecast day', async () => {
  const first = seconds('2026-11-02T06:00:00Z');
  const hourlyTimes = Array.from({ length: 192 }, (_, index) => first + index * 3600);
  const weather = {
    timezone: 'America/Chicago', utc_offset_seconds: -21600,
    daily: {
      time: Array.from({ length: 8 }, (_, index) => first + index * 86400),
      sunrise: Array.from({ length: 8 }, (_, index) => first + index * 86400 + 7 * 3600),
      sunset: Array.from({ length: 8 }, (_, index) => first + index * 86400 + 17 * 3600),
    },
    hourly: {
      time: hourlyTimes, temperature_2m: hourlyTimes.map(() => 60),
      precipitation_probability: hourlyTimes.map((_, index) => index === 168 ? 80 : 0),
      precipitation: hourlyTimes.map((_, index) => index === 168 ? 2 : 0),
      uv_index: hourlyTimes.map((_, index) => index === 168 ? 1 : 0),
    },
  };
  globalThis.fetch = async (url) => response(url.hostname.startsWith('air-quality')
    ? { hourly: { time: hourlyTimes, us_aqi: hourlyTimes.map(() => 20) } } : weather);
  const data = await fetchForecast(location);
  assert.equal(data.days.length, 7);
  assert.equal(data.days.at(-1).date, '2026-11-08');
  assert.equal(data.hours.length, 168);
  assert.equal(data.hours.at(-1).date, '2026-11-08');
  assert.equal(data.hours.at(-1).time, hourlyTimes[167] * 1000);
  assert.equal(data.hours.at(-1).precipitationProbability, 80);
  assert.equal(data.hours.at(-1).precipitation, 2);
  assert.equal(data.hours.at(-1).uv, 1);
});

test('following-hour aggregation follows elapsed time across repeated DST clock hours', async () => {
  const weather = weatherFixture();
  // 06Z and 07Z are both 1 AM locally, on opposite sides of fall-back.
  weather.hourly.precipitation_probability = [10, 70, 5, 10];
  weather.hourly.precipitation = [0.2, 2, 0.1, 0];
  weather.hourly.uv_index = [0, 1, 0, null];
  globalThis.fetch = async (url) => response(url.hostname.startsWith('air-quality')
    ? { hourly: { time: weather.hourly.time, us_aqi: [20, 30, 40, 50] } } : weather);
  const data = await fetchForecast(location);
  assert.equal(data.hours[0].date, '2026-11-01');
  assert.equal(data.hours[1].date, '2026-11-01');
  assert.equal(data.hours[0].precipitationProbability, 70);
  assert.equal(data.hours[0].precipitation, 2);
  assert.equal(data.hours[0].uv, 1);
  assert.equal(data.hours[0].aqi, 20);
  // A later day is not treated as the next hour when an hourly entry is absent.
  assert.equal(data.hours[1].precipitationProbability, null);
});

test('AQI failure retains weather but marks every AQI missing', async () => {
  globalThis.fetch = async (url) => url.hostname.startsWith('air-quality')
    ? response({}, 503) : response(weatherFixture());
  const data = await fetchForecast(location);
  assert.equal(data.hours.length, 4);
  assert.ok(data.hours.every((hour) => hour.aqi === null));
  assert.match(data.warnings[0], /unavailable/);
  assert.equal(data.sources.airQualityGrid, null);
});

test('malformed AQI is treated as partial failure, never silently aligned by index', async () => {
  globalThis.fetch = async (url) => response(url.hostname.startsWith('air-quality')
    ? { hourly: { time: [1, 2], us_aqi: [12] } } : weatherFixture());
  const data = await fetchForecast(location);
  assert.ok(data.hours.every((hour) => hour.aqi === null));
  assert.match(data.warnings[0], /unavailable/);
});

test('weather errors and malformed arrays fail with useful feedback', async () => {
  globalThis.fetch = async () => response({}, 429);
  await assert.rejects(fetchForecast(location), /busy/);
  const malformed = weatherFixture();
  malformed.hourly.uv_index = [0];
  globalThis.fetch = async () => response(malformed);
  await assert.rejects(fetchForecast(location), /incomplete data/);
});

test('invalid coordinates fail before making a request', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(fetchForecast({ latitude: 95, longitude: 0 }), /valid latitude/);
  await assert.rejects(fetchForecast({ latitude: '41', longitude: 0 }), /valid latitude/);
  assert.equal(called, false);
});

test('caller cancellation is preserved rather than converted to an AQI warning', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchForecast(location, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(searchLocations('Chicago', { signal: controller.signal }), { name: 'AbortError' });
});

test('search encodes input, deduplicates labels, and handles no matches', async () => {
  let request;
  globalThis.fetch = async (url) => {
    request = url;
    return response({ results: [{ name: 'Paris', admin1: 'Paris', country: 'France', latitude: 48.85, longitude: 2.35 }] });
  };
  const results = await searchLocations('  Paris & Lyon  ');
  assert.equal(request.searchParams.get('name'), 'Paris & Lyon');
  assert.equal(results[0].label, 'Paris, France');
  globalThis.fetch = async () => response({ generationtime_ms: 1 });
  assert.deepEqual(await searchLocations('No such place'), []);
  assert.deepEqual(await searchLocations('a'), []);
});
