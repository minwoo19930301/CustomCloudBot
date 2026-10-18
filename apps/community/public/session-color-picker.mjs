const PRESETS = [
  ['#9064c2', '라벤더'], ['#df6b9c', '로즈'], ['#e3a34a', '앰버'],
  ['#36a69a', '민트'], ['#5b8deb', '블루'],
];

export function normalizeHex(value) {
  const match = typeof value === 'string' && value.trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? '#' + match[1].toLowerCase() : null;
}
export function hexToRgb(value) {
  const hex = normalizeHex(value);
  return hex ? [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) : null;
}
export function rgbToHex(values) {
  if (!Array.isArray(values) || values.length !== 3 || values.some(value =>
    !['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
    !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 255)) return null;
  return '#' + values.map(value => Number(value).toString(16).padStart(2, '0')).join('');
}
export function shuffleColor(current, random = Math.random) {
  const previous = hexToRgb(current) || [144, 100, 194];
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, random())) * 0x1000000);
    const next = '#' + value.toString(16).padStart(6, '0');
    if (hexToRgb(next).reduce((distance, channel, index) => distance + (channel - previous[index]) ** 2, 0) >= 120 ** 2) return next;
  }
  return rgbToHex(previous.map(channel => channel ^ 128));
}

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const channels = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]][Math.floor(sector)];
  return rgbToHex(channels.map(channel => Math.round((channel + lightness - chroma / 2) * 255)));
}

/** Even hue spacing keeps five choices distinct; shared saturation and lightness
 * make them a palette. Rotate on collisions so a repeated random value still
 * replaces every previous swatch rather than merely reordering the same colors. */
export function shufflePalette(current = [], random = Math.random) {
  const previous = new Set(current.slice(0, 6).map(normalizeHex).filter(Boolean));
  const unit = () => { const value = Number(random()); return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; };
  const hue = unit() * 360, saturation = .52 + unit() * .20, lightness = .52 + unit() * .12;
  for (let attempt = 0; attempt <= previous.size; attempt++) {
    const colors = Array.from({length: 5}, (_, index) => hslToHex(hue + attempt * 31 + index * 72, saturation, lightness));
    if (colors.every(color => !previous.has(color))) return colors;
  }
  // The five old swatches plus the selected color cannot block every rotation.
}

/** The draft stays local until the enclosing dialog saves it. Opening the native
 * picker never converts an automatic (null) color into a saved override. */
export function createSessionColorPicker({value = null, automaticColor = '#9064c2', onChange = () => {}, document: doc = globalThis.document, random = Math.random} = {}) {
  let choice = normalizeHex(value), shown = choice || normalizeHex(automaticColor) || '#9064c2';
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className) => {
    const node = make('button', className); node.type = 'button';
    node.title = label; node.setAttribute('aria-label', label); return node;
  };
  const element = make('div', 'session-color-picker'), palette = make('div', 'session-color-palette');
  palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', '대화 색상 선택');
  const presets = PRESETS.map(([color, label]) => {
    const node = button(label, 'session-color-swatch'); node.dataset.color = color;
    node.style.setProperty('--swatch-color', color); node.onclick = () => select(node.dataset.color); return node;
  });
  const spectrum = button('모든 색상 직접 선택', 'session-color-spectrum');
  spectrum.setAttribute('aria-expanded', 'false');
  const shuffle = button('색상 조합 셔플', 'session-color-shuffle');
  shuffle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h2c5 0 9 12 14 12h2m-4-4 4 4-4 4M3 18h2c2 0 4-2 5-4m4-4c2-3 3-4 5-4h2m-4-4 4 4-4 4"/></svg>';
  palette.append(shuffle, ...presets, spectrum);
  const summary = make('div', 'session-color-summary'), sample = make('span', 'session-color-sample');
  sample.setAttribute('aria-hidden', 'true');
  const caption = make('output', 'session-color-value'); caption.setAttribute('aria-live', 'polite');
  const reset = button('자동 색상으로 되돌리기', 'session-color-reset'); reset.textContent = '자동 색상';
  summary.append(sample, caption, reset);
  const details = make('div', 'session-color-details'); details.hidden = true;
  const exact = make('div', 'session-color-exact'), native = make('input', 'session-color-native');
  native.type = 'color'; native.setAttribute('aria-label', '색상 팔레트');
  const hexLabel = make('label', 'session-color-field', 'HEX'), hex = make('input');
  hex.type = 'text'; hex.required = true; hex.maxLength = 7; hex.pattern = '#?[0-9a-fA-F]{6}';
  hex.autocomplete = 'off'; hex.spellcheck = false; hex.setAttribute('aria-label', 'HEX 색상'); hexLabel.append(hex);
  exact.append(native, hexLabel);
  const rgbRow = make('div', 'session-color-rgb');
  const rgb = ['R', 'G', 'B'].map(channel => {
    const label = make('label', 'session-color-field', channel), input = make('input');
    input.type = 'number'; input.min = '0'; input.max = '255'; input.step = '1'; input.required = true;
    input.inputMode = 'numeric'; input.setAttribute('aria-label', channel + ' 값'); label.append(input); rgbRow.append(label); return input;
  });
  details.append(exact, rgbRow, make('p', 'session-color-hint', 'RGB 0–255 · 원하는 색을 직접 입력할 수 있어요.'));
  element.append(palette, summary, details);
  function sync() {
    native.value = shown; hex.value = shown.toUpperCase(); hex.setCustomValidity(''); hex.removeAttribute('aria-invalid');
    const channels = hexToRgb(shown);
    rgb.forEach((input, index) => { input.value = String(channels[index]); input.setCustomValidity(''); input.removeAttribute('aria-invalid'); });
    sample.style.backgroundColor = shown;
    caption.textContent = choice ? shown.toUpperCase() : '자동 · ' + shown.toUpperCase();
    presets.forEach(node => node.setAttribute('aria-pressed', String(node.dataset.color === choice)));
    spectrum.setAttribute('aria-pressed', String(!!choice && !presets.some(node => node.dataset.color === choice)));
    reset.setAttribute('aria-pressed', String(choice === null));
  }
  function select(color) {
    choice = normalizeHex(color); shown = choice || normalizeHex(automaticColor) || '#9064c2';
    sync(); onChange(choice);
  }
  spectrum.onclick = () => {
    details.hidden = false; spectrum.setAttribute('aria-expanded', 'true');
    // Both paths run inside the user's click, including on iOS.
    try { if (typeof native.showPicker === 'function') native.showPicker(); else native.click(); }
    catch { native.focus(); }
  };
  native.oninput = () => { const next = normalizeHex(native.value); if (next) select(next); };
  hex.oninput = () => {
    const next = normalizeHex(hex.value); hex.setCustomValidity(next ? '' : '6자리 HEX 색상을 입력해주세요.');
    hex.setAttribute('aria-invalid', String(!next));
    if (next) select(next);
  };
  rgb.forEach(input => { input.oninput = () => {
    const next = rgbToHex(rgb.map(field => field.value));
    rgb.forEach(field => {
      const valid = !!rgbToHex([field.value, 0, 0]);
      field.setCustomValidity(valid ? '' : '0부터 255 사이의 정수를 입력해주세요.'); field.setAttribute('aria-invalid', String(!valid));
    });
    if (next) select(next);
  }; });
  shuffle.onclick = () => {
    const colors = shufflePalette([...presets.map(node => node.dataset.color), shown], random);
    presets.forEach((node, index) => {
      const color = colors[index], label = '색상 ' + (index + 1) + ' · ' + color.toUpperCase();
      node.dataset.color = color; node.style.setProperty('--swatch-color', color);
      node.title = label; node.setAttribute('aria-label', label);
    });
    select(colors[0]);
  };
  reset.onclick = () => select(null);
  sync();
  return {element, get value() { return choice; }, reportValidity() {
    return [hex, ...rgb].every(input => input.reportValidity());
  }};
}
