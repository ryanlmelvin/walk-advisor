import test from 'node:test';
import assert from 'node:assert/strict';
import { focusTappedLocationInput } from '../src/location-input.js';

test('a first tap on a location field or its label focuses without scrolling', () => {
  const calls = [];
  const input = { tagName: 'INPUT', ownerDocument: {}, closest: () => null, focus: (options) => calls.push(options) };
  const label = { closest: () => ({ control: input }) };
  const tap = (target, options = {}) => focusTappedLocationInput({ target, pointerType: 'touch', isPrimary: true, ...options });

  tap(input);
  tap(label);
  tap(input, { pointerType: 'mouse' });
  tap(input, { isPrimary: false });
  tap({ tagName: 'BUTTON', closest: () => null });
  input.ownerDocument.activeElement = input;
  tap(input);
  assert.deepEqual(calls, [{ preventScroll: true }, { preventScroll: true }]);
});
