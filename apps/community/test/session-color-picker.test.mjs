import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHex, hexToRgb, rgbToHex, shuffleColor, shufflePalette, createSessionColorPicker} from '../public/session-color-picker.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = new Map(); this.dataset = {};
    this.value = ''; this.validationMessage = ''; this.nativeOpens = 0; this.focuses = 0;
    this.style = {values: new Map(), setProperty(name, value) { this.values.set(name, value); }, getPropertyValue(name) { return this.values.get(name); }};
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() {
    if (this.validationMessage || (this.required && !this.value)) return false;
    if (this.pattern && !new RegExp(`^(?:${this.pattern})$`).test(this.value)) return false;
    if (this.type === 'number') {
      const value = Number(this.value);
      if (!Number.isFinite(value) || value < Number(this.min) || value > Number(this.max) || !Number.isInteger(value)) return false;
    }
    return true;
  }
  showPicker() { this.nativeOpens++; }
  click() { this.nativeOpens++; this.onclick?.(); }
  focus() { this.focuses++; }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
function fixture(options = {}) {
  const changes = [], document = {createElement: tag => new Element(tag)};
  const picker = createSessionColorPicker({...options, document, onChange: color => changes.push(color)});
  const all = descendants(picker.element), byClass = name => all.find(node => node.className?.split(' ').includes(name));
  const fields = all.filter(node => node.tagName === 'input');
  return {
    picker, changes, all,
    palette: byClass('session-color-palette'),
    presets: all.filter(node => node.className === 'session-color-swatch'),
    rainbow: byClass('session-color-spectrum'), shuffle: byClass('session-color-shuffle'), reset: byClass('session-color-reset'),
    details: byClass('session-color-details'), caption: byClass('session-color-value'),
    native: fields.find(node => node.type === 'color'), hex: fields.find(node => node.type === 'text'),
    rgb: fields.filter(node => node.type === 'number'),
  };
}
function input(field, value) { field.value = String(value); field.oninput(); }
function assertFields(app, hex, rgb) {
  assert.equal(app.picker.value, hex);
  assert.equal(app.native.value, hex);
  assert.equal(app.hex.value, hex.toUpperCase());
  assert.deepEqual(app.rgb.map(field => Number(field.value)), rgb);
  assert.equal(app.picker.reportValidity(), true);
}

test('HEX conversion normalizes six-digit colors and rejects malformed or non-color data', () => {
  for (const value of ['#12AbEf', '12abef', ' #12ABEF ']) {
    assert.equal(normalizeHex(value), '#12abef');
    assert.deepEqual(hexToRgb(value), [18, 171, 239]);
  }
  for (const value of [null, undefined, '', '#abc', '#12345678', '#gg0000', 'red', 'rgb(1,2,3)', 'var(--color)', '<svg>', 123456, {}]) {
    assert.equal(normalizeHex(value), null, String(value));
    assert.equal(hexToRgb(value), null, String(value));
  }
});

test('RGB conversion supports the full byte range without rounding invalid input', () => {
  assert.equal(rgbToHex([0, 0, 0]), '#000000');
  assert.equal(rgbToHex([255, 255, 255]), '#ffffff');
  assert.equal(rgbToHex(['18', '171', '239']), '#12abef');
  for (let channel = 0; channel <= 255; channel++) {
    const rgb = [channel, 255 - channel, channel];
    assert.deepEqual(hexToRgb(rgbToHex(rgb)), rgb);
  }
  for (const value of [null, {}, [], [0, 0], [0, 0, 0, 0], ['', 0, 0], [' ', 0, 0], ['12x', 0, 0], [null, 0, 0], [true, 0, 0], [-1, 0, 0], [256, 0, 0], [1.5, 0, 0], [NaN, 0, 0], [Infinity, 0, 0]]) {
    assert.equal(rgbToHex(value), null, String(value));
  }
});

test('shuffle can reach arbitrary RGB endpoints and cannot repeat or hang on the current color', () => {
  assert.equal(shuffleColor('#ffffff', () => 0), '#000000');
  assert.equal(shuffleColor('#000000', () => 1), '#ffffff');
  assert.equal(shuffleColor('#ffffff', () => 0x12abef / 0x1000000), '#12abef');
  for (const current of ['#000000', '#ffffff', '#12abef', '#808080']) {
    let calls = 0;
    const next = shuffleColor(current, () => { calls++; return parseInt(current.slice(1), 16) / 0x1000000; });
    assert.match(next, /^#[0-9a-f]{6}$/);
    assert.notEqual(next, current);
    assert.ok(calls <= 8, 'a repetitive random source has a bounded fallback');
  }
});

test('shuffle precedes five presets and the spectrum, and selecting a preset synchronizes the editor', () => {
  const app = fixture();
  assert.equal(app.presets.length, 5);
  assert.equal(new Set(app.presets.map(button => button.dataset.color)).size, 5);
  const palette = app.picker.element.children[0];
  assert.deepEqual(palette.children, [app.shuffle, ...app.presets, app.rainbow]);
  for (const preset of app.presets) {
    assert.equal(preset.type, 'button');
    assert.ok(preset.getAttribute('aria-label'));
    preset.onclick();
    assertFields(app, preset.dataset.color, hexToRgb(preset.dataset.color));
    assert.equal(preset.getAttribute('aria-pressed'), 'true');
    assert.equal(app.presets.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(app.rainbow.getAttribute('aria-pressed'), 'false');
  }
  assert.deepEqual(app.changes, app.presets.map(button => button.dataset.color));
});

function hueFor(hex) {
  const [r, g, b] = hexToRgb(hex).map(channel => channel / 255);
  const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  let hue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

test('shuffled palettes cover five separated hues with consistent brightness and saturation', () => {
  for (let seed = 0; seed < 24; seed++) {
    const values = [seed / 24, (seed % 7) / 6, (seed % 5) / 4];
    const colors = shufflePalette([], () => values.shift());
    assert.equal(colors.length, 5);
    assert.equal(new Set(colors).size, 5);
    const hues = colors.map(hueFor).sort((a, b) => a - b);
    const lightness = [], saturation = [];
    for (let index = 0; index < 5; index++) {
      assert.match(colors[index], /^#[0-9a-f]{6}$/);
      const gap = (hues[(index + 1) % 5] - hues[index] + 360) % 360;
      assert.ok(gap > 70 && gap < 74, `five distinct hue regions, gap ${gap}`);
      const channels = hexToRgb(colors[index]).map(channel => channel / 255);
      const high = Math.max(...channels), low = Math.min(...channels), light = (high + low) / 2;
      lightness.push(light); saturation.push((high - low) / (1 - Math.abs(2 * light - 1)));
    }
    assert.ok(Math.max(...lightness) - Math.min(...lightness) < .01, 'shared brightness');
    assert.ok(Math.max(...saturation) - Math.min(...saturation) < .01, 'shared saturation');
  }
});

test('every shuffle replaces all five swatches even with a repetitive random source', () => {
  const app = fixture({value: '#12abef', random: () => 0});
  for (let iteration = 0; iteration < 8; iteration++) {
    const previous = new Set([...app.presets.map(node => node.dataset.color), app.picker.value]);
    const changesBefore = app.changes.length;
    app.shuffle.onclick();
    const colors = app.presets.map(node => node.dataset.color);
    assert.equal(colors.length, 5);
    assert.equal(new Set(colors).size, 5);
    assert.ok(colors.every(color => !previous.has(color)), 'no old color is merely reordered');
    assert.equal(app.picker.value, colors[0]);
    assert.equal(app.changes.length, changesBefore + 1, 'one draft selection per shuffle');
    assertFields(app, colors[0], hexToRgb(colors[0]));
    assert.equal(app.rainbow.getAttribute('aria-pressed'), 'false');
    for (const preset of app.presets) {
      assert.ok(preset.getAttribute('aria-label').includes(preset.dataset.color.toUpperCase()));
      assert.equal(preset.style.getPropertyValue('--swatch-color'), preset.dataset.color);
      preset.onclick();
      assertFields(app, preset.dataset.color, hexToRgb(preset.dataset.color));
      assert.equal(preset.getAttribute('aria-pressed'), 'true');
      assert.equal(app.presets.filter(node => node.getAttribute('aria-pressed') === 'true').length, 1);
      assert.equal(app.rainbow.getAttribute('aria-pressed'), 'false');
    }
    assert.deepEqual(app.palette.children, [app.shuffle, ...app.presets, app.rainbow]);
  }
  input(app.hex, '#123456');
  assertFields(app, '#123456', [18, 52, 86]);
  assert.equal(app.rainbow.getAttribute('aria-pressed'), 'true');
});

test('opening the custom editor preserves automatic inheritance and handles native picker fallbacks', () => {
  for (const nativeMode of ['showPicker', 'click', 'throw']) {
    const app = fixture({value: null, automaticColor: '#12abef'});
    if (nativeMode === 'click') app.native.showPicker = undefined;
    if (nativeMode === 'throw') app.native.showPicker = () => { throw new Error('native picker unavailable'); };
    assert.equal(app.details.hidden, true);
    app.rainbow.onclick();
    assert.equal(app.details.hidden, false);
    assert.equal(app.rainbow.getAttribute('aria-expanded'), 'true');
    assert.equal(app.picker.value, null);
    assert.equal(app.native.value, '#12abef');
    assert.deepEqual(app.changes, []);
    assert.equal(app.reset.getAttribute('aria-pressed'), 'true');
    assert.equal(app.picker.reportValidity(), true);
    assert.equal(nativeMode === 'throw' ? app.native.focuses : app.native.nativeOpens, 1);
  }
});

test('native, HEX and RGB edits synchronize exact arbitrary colors, including black and white', () => {
  const app = fixture();
  input(app.native, '#12abef'); assertFields(app, '#12abef', [18, 171, 239]);
  input(app.hex, 'ABCDEF'); assertFields(app, '#abcdef', [171, 205, 239]);
  app.rgb.forEach(field => { field.value = '0'; }); app.rgb[0].oninput();
  assertFields(app, '#000000', [0, 0, 0]);
  app.rgb.forEach(field => { field.value = '255'; }); app.rgb[2].oninput();
  assertFields(app, '#ffffff', [255, 255, 255]);
  assert.equal(app.rainbow.getAttribute('aria-pressed'), 'true');
  assert.equal(app.presets.some(button => button.getAttribute('aria-pressed') === 'true'), false);
  assert.deepEqual(app.changes, ['#12abef', '#abcdef', '#000000', '#ffffff']);
});

test('invalid HEX/RGB drafts block save without replacing the last valid color, and recover cleanly', () => {
  const app = fixture({value: '#12abef'});
  for (const invalid of ['#12', '#zzzzzz', '']) {
    input(app.hex, invalid);
    assert.equal(app.picker.reportValidity(), false);
    assert.equal(app.hex.getAttribute('aria-invalid'), 'true');
    assert.equal(app.picker.value, '#12abef');
    assert.equal(app.changes.length, 0);
  }
  input(app.hex, '#12abef');
  for (const invalid of ['', '-1', '256', '1.5', 'no']) {
    input(app.rgb[0], invalid);
    assert.equal(app.picker.reportValidity(), false);
    assert.equal(app.rgb[0].getAttribute('aria-invalid'), 'true');
    assert.equal(app.picker.value, '#12abef');
  }
  input(app.rgb[0], '18'); assertFields(app, '#12abef', [18, 171, 239]);
  input(app.hex, 'broken');
  app.presets[0].onclick();
  assert.equal(app.picker.reportValidity(), true, 'a fresh valid selection clears invalid editor drafts');
  assert.equal([app.hex, ...app.rgb].some(field => field.getAttribute('aria-invalid') === 'true'), false);
});

test('shuffle is an explicit local draft change, while reset restores null and the automatic preview', () => {
  const app = fixture({value: '#12abef', automaticColor: '#e3a34a'});
  assert.deepEqual(app.changes, []);
  app.shuffle.onclick();
  assert.match(app.picker.value, /^#[0-9a-f]{6}$/);
  assert.notEqual(app.picker.value, '#12abef');
  assertFields(app, app.picker.value, hexToRgb(app.picker.value));
  input(app.hex, 'invalid');
  app.reset.onclick();
  assert.equal(app.picker.value, null);
  assert.equal(app.native.value, '#e3a34a');
  assert.equal(app.picker.reportValidity(), true);
  assert.equal(app.reset.getAttribute('aria-pressed'), 'true');
  assert.ok(app.caption.textContent.startsWith('자동'));
  assert.equal(app.changes.length, 2);
  assert.equal(app.changes[1], null);
});
