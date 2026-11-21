import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSensorId, sensorWidgetDocument, watchSensorInputViewport } from '../src/purpleair.js';

test('a missing optional sensor or an older saved location has no sensor ID', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(normalizeSensorId(value), '');
});

test('a sensor ID is stored as a positive decimal string', () => {
  for (const value of [42, '42', ' 00042 ']) assert.equal(normalizeSensorId(value), '42');
});

test('typing only scrolls a focused sensor field when it leaves the visible part of the page', () => {
  const input = new EventTarget();
  const viewport = Object.assign(new EventTarget(), { pageTop: 200, height: 300 });
  const frames = [];
  input.ownerDocument = {
    activeElement: input,
    documentElement: { getBoundingClientRect: () => ({ top: -120 }) },
    defaultView: { visualViewport: viewport, requestAnimationFrame: (callback) => frames.push(callback) },
  };
  input.getBoundingClientRect = () => ({ top: 150, height: 44 }); // Page coordinates 270–314.
  const scrolls = [];
  input.scrollIntoView = (options) => scrolls.push(options.block);
  watchSensorInputViewport(input);

  input.dispatchEvent(new Event('focus'));
  input.dispatchEvent(new Event('input'));
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(scrolls, []);

  viewport.height = 100; // Keyboard now covers the bottom of the field.
  viewport.dispatchEvent(new Event('resize'));
  frames.shift()();
  assert.deepEqual(scrolls, ['nearest']);

  viewport.pageTop = 320; // Safari panned past the top of the field.
  input.dispatchEvent(new Event('input'));
  frames.shift()();
  assert.deepEqual(scrolls, ['nearest', 'nearest']);

  viewport.dispatchEvent(new Event('resize'));
  input.ownerDocument.activeElement = null;
  frames.shift()();
  assert.equal(scrolls.length, 2);
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
