import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSensorId, sensorWidgetDocument } from '../src/purpleair.js';

test('a missing optional sensor or an older saved location has no sensor ID', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(normalizeSensorId(value), '');
});

test('a sensor ID is stored as a positive decimal string', () => {
  for (const value of [42, '42', ' 00042 ']) assert.equal(normalizeSensorId(value), '42');
});

test('invalid IDs cannot change the widget markup or resolve to a different sensor', () => {
  for (const value of ['0', '-1', '1.1', '1e2', '+1', '1?key=2', '1"><script>', '9007199254740993', {}]) {
    assert.equal(normalizeSensorId(value), null);
    assert.equal(sensorWidgetDocument(value), '');
  }
});

test('the official widget uses EPA-corrected PM2.5 and the same sensor and correction on its fallback map', () => {
  const html = sensorWidgetDocument('0042');
  const url = new URL(html.match(/<script src="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(url.origin + url.pathname, 'https://www.purpleair.com/pa.widget.js');
  assert.equal(url.searchParams.get('conversion'), 'C5');
  assert.equal(url.searchParams.get('module'), 'US_EPA_AQI');
  assert.equal(url.searchParams.get('average'), '10');
  assert.ok(html.includes(`id="${url.searchParams.get('container')}"`));
  assert.match(html, /cC5\?select=42"/);
});
