// Pictures for the game board (public/game.js): the inventory item pictures (Factorio-style little items, one per kind of component and its look,
// drawn a little longer or shorter with the component's length so a 0.7 m ledger and a 3 m ledger look different), the category tab pictures, and
// the pictures on the big buttons. Colours say what a part is at a glance, as on a real yard: standards carry yellow cups or rosettes, ledgers
// orange ends, transoms blue, braces red, timber is timber and aluminium is bright. Each picture is one small SVG document behind a blob URL (the
// CSP allows img-src blob:), made once and shared by every slot, so a grid of hundreds of slots is hundreds of <img> tags pointing at a few dozen
// pictures. Pure string builders: they run in Node tests too.
import { componentIcon, ovImg, sgSheet, siSheet, hcSheet, hrSheet } from './art.js';
const f = (n) => +(+n).toFixed(1);
const C = {
  ol: '#23302f',
  steel: '#c6d0d4',
  hi: '#f5f9fa',
  shade: '#8a979d',
  orange: '#f08a24',
  oranged: '#a3550f',
  yellow: '#f2c230',
  yellowd: '#9b7a12',
  blue: '#3f86c9',
  blued: '#1f4d7a',
  red: '#d9493b',
  redd: '#7e2219',
  timber: '#c98d52',
  timberd: '#7a4a22',
  timberh: '#e7b27a',
  lvl: '#e2b877',
  lvld: '#9a6b2c',
  alu: '#e8eef1',
  alud: '#9fb0b8',
  dark: '#4a5559',
  lime: '#b9ef4b',
  gold: '#e3b21c',
};
// A tube from a to b: an outline, the body and a highlight, with round ends.
const tube = (x1, y1, x2, y2, w = 5.2, body = C.steel) =>
  '<path d="M' +
  f(x1) +
  ' ' +
  f(y1) +
  'L' +
  f(x2) +
  ' ' +
  f(y2) +
  '" stroke="' +
  C.ol +
  '" stroke-width="' +
  f(w + 2) +
  '" stroke-linecap="round"/><path d="M' +
  f(x1) +
  ' ' +
  f(y1) +
  'L' +
  f(x2) +
  ' ' +
  f(y2) +
  '" stroke="' +
  body +
  '" stroke-width="' +
  f(w) +
  '" stroke-linecap="round"/><path d="M' +
  f(x1) +
  ' ' +
  f(y1 - w * 0.22) +
  'L' +
  f(x2) +
  ' ' +
  f(y2 - w * 0.22) +
  '" stroke="' +
  C.hi +
  '" stroke-width="' +
  f(w * 0.3) +
  '" stroke-linecap="round" opacity=".9"/>';
const poly = (pts, fill, stroke = C.ol, sw = 1.2) =>
  '<path d="M' +
  pts.map((p) => f(p[0]) + ' ' + f(p[1])).join('L') +
  'Z" fill="' +
  fill +
  '" stroke="' +
  stroke +
  '" stroke-width="' +
  sw +
  '" stroke-linejoin="round"/>';
const dot = (x, y, r, fill, stroke = C.ol, sw = 1.2) =>
  '<circle cx="' +
  f(x) +
  '" cy="' +
  f(y) +
  '" r="' +
  f(r) +
  '" fill="' +
  fill +
  '" stroke="' +
  stroke +
  '" stroke-width="' +
  sw +
  '"/>';
const line = (x1, y1, x2, y2, col, w) =>
  '<path d="M' +
  f(x1) +
  ' ' +
  f(y1) +
  'L' +
  f(x2) +
  ' ' +
  f(y2) +
  '" stroke="' +
  col +
  '" stroke-width="' +
  w +
  '" stroke-linecap="round"/>';
const shadow = (cx, cy, rx, ry = rx * 0.28) =>
  '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(rx) + '" ry="' + f(ry) + '" fill="#000" opacity=".28"/>';
// along a diagonal (up to the right) centred on (cx,cy): the ends of a bar s long at angle a (degrees up from the horizontal)
const ends = (s, a = 28, cx = 24, cy = 26) => {
  const t = (a * Math.PI) / 180,
    dx = (Math.cos(t) * s) / 2,
    dy = (Math.sin(t) * s) / 2;
  return [cx - dx, cy + dy, cx + dx, cy - dy];
};
const at = (x1, y1, x2, y2, k) => [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k];
// A flat deck seen from above at the board angle: its top face corners, thickness drawn under it.
function deck(L, w, top, side, { holes = null, ribs = null, caps = null, lip = null, cx = 24, cy = 26 } = {}) {
  const s = 26 + 14 * L,
    [x1, y1, x2, y2] = ends(s, 26, cx, cy),
    a = (26 * Math.PI) / 180,
    nx = (-Math.sin(a) * w) / 2,
    ny = (-Math.cos(a) * w) / 2;
  const T = [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ];
  let d =
    shadow(cx + 1, cy + 10, 13 + 6 * L) +
    poly(
      [
        [x1 - nx, y1 - ny],
        [x2 - nx, y2 - ny],
        [x2 - nx, y2 - ny + 3.2],
        [x1 - nx, y1 - ny + 3.2],
      ],
      side,
    ) +
    poly(T, top);
  if (holes)
    for (let k = 0.1; k < 0.93; k += 0.1) {
      const [x, y] = at(x1, y1, x2, y2, k);
      d +=
        '<circle cx="' +
        f(x + nx * 0.4) +
        '" cy="' +
        f(y + ny * 0.4) +
        '" r="1" fill="' +
        holes +
        '"/><circle cx="' +
        f(x - nx * 0.4) +
        '" cy="' +
        f(y - ny * 0.4) +
        '" r="1" fill="' +
        holes +
        '"/>';
    }
  if (ribs)
    for (const k of [-0.45, 0, 0.45])
      d += line(x1 + nx * k + 1.5, y1 + ny * k - 0.7, x2 + nx * k - 1.5, y2 + ny * k + 0.7, ribs, 1);
  if (caps)
    for (const k of [0.04, 0.96]) {
      const [x, y] = at(x1, y1, x2, y2, k);
      d += line(x + nx, y + ny, x - nx, y - ny, caps, 2.6);
    }
  if (lip) d += line(T[0][0], T[0][1], T[1][0], T[1][1], lip, 1.4);
  return d;
}
const ART = {
  // ---- tubes
  'tube:galv': (L) => {
    const [x1, y1, x2, y2] = ends(26 + 16 * L);
    return (
      shadow(24, 34, 13 + 5 * L) +
      tube(x1, y1, x2, y2, 8) +
      '<ellipse cx="' +
      f(x1) +
      '" cy="' +
      f(y1) +
      '" rx="3" ry="4.1" transform="rotate(-28 ' +
      f(x1) +
      ' ' +
      f(y1) +
      ')" fill="#55636a" stroke="' +
      C.ol +
      '" stroke-width="1.2"/>'
    );
  },
  'tube:alu': (L) => {
    const [x1, y1, x2, y2] = ends(26 + 16 * L);
    return (
      shadow(24, 34, 13 + 5 * L) +
      tube(x1, y1, x2, y2, 7.4, C.alu) +
      '<ellipse cx="' +
      f(x1) +
      '" cy="' +
      f(y1) +
      '" rx="2.8" ry="3.8" transform="rotate(-28 ' +
      f(x1) +
      ' ' +
      f(y1) +
      ')" fill="#8fb4c8" stroke="' +
      C.ol +
      '" stroke-width="1.2"/>'
    );
  },
  // ---- standards: yellow cups (Kwikstage), orange rosettes (ringlock), a short base collar, a spigot
  'standard:cup': (L) => {
    const h = 26 + 14 * L,
      y0 = 25 + h / 2,
      y1 = 25 - h / 2;
    let s = shadow(24, y0 + 2, 8) + tube(24, y0, 24, y1 + 4, 7) + tube(24, y1 + 4, 24, y1, 4.4, C.shade);
    for (let y = y0 - 5; y > y1 + 6; y -= Math.max(6, (h - 10) / 4))
      s += poly(
        [
          [17.5, y - 2.8],
          [30.5, y - 2.8],
          [28.5, y + 1.8],
          [19.5, y + 1.8],
        ],
        C.yellow,
        C.yellowd,
        1.2,
      );
    return s;
  },
  'standard:ring': (L) => {
    const h = 26 + 14 * L,
      y0 = 25 + h / 2,
      y1 = 25 - h / 2;
    let s = shadow(24, y0 + 2, 8) + tube(24, y0, 24, y1 + 4, 6.4) + tube(24, y1 + 4, 24, y1, 4, C.shade);
    for (let y = y0 - 5; y > y1 + 6; y -= Math.max(6, (h - 10) / 4))
      s +=
        '<ellipse cx="24" cy="' +
        f(y) +
        '" rx="8.4" ry="3" fill="' +
        C.orange +
        '" stroke="' +
        C.oranged +
        '" stroke-width="1.2"/><ellipse cx="24" cy="' +
        f(y - 0.4) +
        '" rx="3.6" ry="1.3" fill="' +
        C.oranged +
        '"/>';
    return s;
  },
  'standard:collar': () =>
    shadow(24, 40, 11) +
    tube(24, 38, 24, 12, 7.6) +
    '<ellipse cx="24" cy="30" rx="10" ry="3.6" fill="' +
    C.orange +
    '" stroke="' +
    C.oranged +
    '" stroke-width="1.3"/><ellipse cx="24" cy="29.6" rx="4" ry="1.4" fill="' +
    C.oranged +
    '"/>' +
    poly(
      [
        [18, 38],
        [30, 38],
        [30, 41],
        [18, 41],
      ],
      C.yellow,
      C.yellowd,
      1.1,
    ),
  'standard:spigot': () =>
    shadow(24, 40, 8) +
    tube(24, 38, 24, 10, 5.4) +
    poly(
      [
        [19, 24],
        [29, 24],
        [29, 28],
        [19, 28],
      ],
      C.yellow,
      C.yellowd,
      1.2,
    ) +
    line(21, 33, 27, 33, C.ol, 1),
  // ---- ledgers: orange blades (Kwikstage), wedge heads (ringlock), a raised ledger, a tie bar, a heavy-duty double
  'ledger:blade': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 16 * L, 26);
    return (
      shadow(24, 33, 12 + 6 * L) +
      tube(x1, y1, x2, y2, 6) +
      poly(
        [
          [x1 - 4, y1 - 5],
          [x1 + 2.5, y1 - 7],
          [x1 + 2.5, y1 + 4],
          [x1 - 4, y1 + 6],
        ],
        C.orange,
        C.oranged,
      ) +
      poly(
        [
          [x2 - 2.5, y2 - 6],
          [x2 + 4, y2 - 8],
          [x2 + 4, y2 + 3],
          [x2 - 2.5, y2 + 5],
        ],
        C.orange,
        C.oranged,
      )
    );
  },
  'ledger:ring': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 16 * L, 26);
    const head = (x, y) =>
      poly(
        [
          [x - 3.6, y - 3],
          [x + 3.6, y - 4.6],
          [x + 3.6, y + 2.4],
          [x - 3.6, y + 4],
        ],
        '#7c878c',
      ) + line(x, y - 8, x, y + 6, C.orange, 2.6);
    return shadow(24, 33, 12 + 6 * L) + tube(x1, y1, x2, y2, 5.6) + head(x1, y1) + head(x2, y2);
  },
  'ledger:raised': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 16 * L, 26);
    return (
      shadow(24, 34, 12 + 6 * L) +
      tube(x1, y1 - 3, x2, y2 - 3, 5.4) +
      tube(x1, y1 + 4, x1, y1 - 4, 4.2, C.orange) +
      tube(x2, y2 + 4, x2, y2 - 4, 4.2, C.orange) +
      poly(
        [
          [x1 - 3, y1 + 3],
          [x1 + 3, y1 + 1.6],
          [x1 + 3, y1 + 6],
          [x1 - 3, y1 + 7.4],
        ],
        C.orange,
        C.oranged,
      ) +
      poly(
        [
          [x2 - 3, y2 + 3],
          [x2 + 3, y2 + 1.6],
          [x2 + 3, y2 + 6],
          [x2 - 3, y2 + 7.4],
        ],
        C.orange,
        C.oranged,
      )
    );
  },
  'ledger:tie': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 16 * L, 26);
    return (
      shadow(24, 33, 12 + 6 * L) +
      line(x1, y1, x2, y2, C.ol, 5) +
      line(x1, y1, x2, y2, '#aab6bb', 3) +
      poly(
        [
          [x1 - 3, y1 - 5],
          [x1 + 2, y1 - 6.4],
          [x1 + 2, y1 + 3],
          [x1 - 3, y1 + 4.4],
        ],
        C.orange,
        C.oranged,
      ) +
      poly(
        [
          [x2 - 2, y2 - 6],
          [x2 + 3, y2 - 7.4],
          [x2 + 3, y2 + 2],
          [x2 - 2, y2 + 3.4],
        ],
        C.orange,
        C.oranged,
      )
    );
  },
  'ledger:heavy': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 16 * L, 26);
    let s = shadow(24, 35, 13 + 6 * L) + tube(x1, y1 + 4, x2, y2 + 4, 5) + tube(x1, y1 - 4, x2, y2 - 4, 5);
    for (let k = 0.2; k < 0.9; k += 0.2) {
      const [x, y] = at(x1, y1, x2, y2, k);
      s += line(x, y - 3, x + 2.6, y + 3, '#7c878c', 1.8);
    }
    return (
      s +
      poly(
        [
          [x1 - 3.4, y1 - 7],
          [x1 + 2.8, y1 - 8.4],
          [x1 + 2.8, y1 + 6],
          [x1 - 3.4, y1 + 7.4],
        ],
        C.orange,
        C.oranged,
      ) +
      poly(
        [
          [x2 - 2.8, y2 - 8],
          [x2 + 3.4, y2 - 9.4],
          [x2 + 3.4, y2 + 5],
          [x2 - 2.8, y2 + 6.4],
        ],
        C.orange,
        C.oranged,
      )
    );
  },
  // ---- transoms: blue; a mid transom with its hook, a plank transom (a channel), a ladder access transom
  'transom:normal': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 14 * L, 26);
    return (
      shadow(24, 35, 12 + 6 * L) +
      tube(x1, y1 + 8, x1, y1, 4.4, C.blue) +
      tube(x2, y2 + 8, x2, y2, 4.4, C.blue) +
      tube(x1, y1, x2, y2, 6) +
      poly(
        [
          [x1 - 3.4, y1 - 4],
          [x1 + 3.4, y1 - 5.4],
          [x1 + 3.4, y1 + 2.6],
          [x1 - 3.4, y1 + 4],
        ],
        C.blue,
        C.blued,
      ) +
      poly(
        [
          [x2 - 3.4, y2 - 4],
          [x2 + 3.4, y2 - 5.4],
          [x2 + 3.4, y2 + 2.6],
          [x2 - 3.4, y2 + 4],
        ],
        C.blue,
        C.blued,
      )
    );
  },
  'transom:mid': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 14 * L, 26),
      [mx, my] = at(x1, y1, x2, y2, 0.5);
    return (
      shadow(24, 35, 12 + 6 * L) +
      tube(x1, y1, x2, y2, 5.6) +
      poly(
        [
          [x1 - 3, y1 - 4],
          [x1 + 3, y1 - 5.2],
          [x1 + 3, y1 + 3],
          [x1 - 3, y1 + 4.2],
        ],
        C.blue,
        C.blued,
      ) +
      poly(
        [
          [x2 - 3, y2 - 4],
          [x2 + 3, y2 - 5.2],
          [x2 + 3, y2 + 3],
          [x2 - 3, y2 + 4.2],
        ],
        C.blue,
        C.blued,
      ) +
      tube(mx, my, mx, my + 9, 3.6, C.blue)
    );
  },
  'transom:plank': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 14 * L, 26);
    return (
      shadow(24, 35, 12 + 6 * L) +
      poly(
        [
          [x1 - 2, y1 - 3],
          [x2 - 2, y2 - 3],
          [x2 + 2, y2 + 2],
          [x1 + 2, y1 + 2],
        ],
        '#9eaab0',
      ) +
      line(x1 - 2, y1 - 3, x2 - 2, y2 - 3, C.blue, 2.4) +
      line(x1 + 2, y1 + 2, x2 + 2, y2 + 2, C.blue, 2.4) +
      poly(
        [
          [x1 - 4, y1 - 4],
          [x1 + 2, y1 - 5.6],
          [x1 + 2, y1 + 4],
          [x1 - 4, y1 + 5.6],
        ],
        C.blue,
        C.blued,
      ) +
      poly(
        [
          [x2 - 2, y2 - 5.6],
          [x2 + 4, y2 - 7.2],
          [x2 + 4, y2 + 2.4],
          [x2 - 2, y2 + 4],
        ],
        C.blue,
        C.blued,
      )
    );
  },
  'transom:ladder': (L) => {
    const [x1, y1, x2, y2] = ends(24 + 14 * L, 26);
    let s = shadow(24, 36, 12 + 6 * L) + tube(x1, y1 - 3, x2, y2 - 3, 4.6) + tube(x1, y1 + 4, x2, y2 + 4, 4.6);
    for (let k = 0.2; k < 0.9; k += 0.2) {
      const [x, y] = at(x1, y1, x2, y2, k);
      s += line(x, y - 3, x, y + 4, C.blue, 2.2);
    }
    return (
      s +
      poly(
        [
          [x1 - 3, y1 - 6],
          [x1 + 3, y1 - 7.4],
          [x1 + 3, y1 + 6],
          [x1 - 3, y1 + 7.4],
        ],
        C.blue,
        C.blued,
      )
    );
  },
  // ---- braces: red ends; a plan brace lies flatter with a sleeve; heavy duty is thicker
  'brace:diag': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 56);
    return (
      shadow(24, 41, 10) +
      tube(x1, y1, x2, y2, 5.6) +
      dot(x1, y1, 4.4, C.red, C.redd, 1.4) +
      dot(x2, y2, 4.4, C.red, C.redd, 1.4)
    );
  },
  'brace:plan': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 14),
      [mx, my] = at(x1, y1, x2, y2, 0.55);
    return (
      shadow(24, 33, 14) +
      tube(x1, y1, x2, y2, 4.6) +
      tube(mx - 5, my + 1.2, mx + 5, my - 1.2, 7.4, C.shade) +
      dot(x1, y1, 4, C.red, C.redd, 1.4) +
      dot(x2, y2, 4, C.red, C.redd, 1.4)
    );
  },
  'brace:heavy': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 56);
    return (
      shadow(24, 41, 11) +
      tube(x1, y1, x2, y2, 7.6) +
      poly(
        [
          [x1 - 5, y1 - 2],
          [x1 + 2, y1 - 5],
          [x1 + 5, y1 + 2],
          [x1 - 2, y1 + 5],
        ],
        C.red,
        C.redd,
        1.4,
      ) +
      poly(
        [
          [x2 - 5, y2 - 2],
          [x2 + 2, y2 - 5],
          [x2 + 5, y2 + 2],
          [x2 - 2, y2 + 5],
        ],
        C.red,
        C.redd,
        1.4,
      )
    );
  },
  // ---- guardrails and toeboards
  'rail:rail': (L) => {
    const [x1, y1, x2, y2] = ends(26 + 14 * L, 26);
    return (
      shadow(24, 37, 13) +
      tube(x1, y1 + 7, x2, y2 + 7, 5) +
      tube(x1, y1 - 3, x2, y2 - 3, 5) +
      tube(x1, y1 - 3, x1, y1 + 7, 4, C.yellow) +
      tube(x2, y2 - 3, x2, y2 + 7, 4, C.yellow)
    );
  },
  'rail:post': () =>
    shadow(24, 41, 9) +
    tube(24, 40, 24, 8, 6, C.yellow) +
    tube(24, 15, 35, 11, 3.6) +
    tube(24, 27, 35, 23, 3.6) +
    poly(
      [
        [17, 38],
        [31, 38],
        [31, 42],
        [17, 42],
      ],
      '#7c878c',
    ),
  'toeboard:toe': (L) => {
    const [x1, y1, x2, y2] = ends(26 + 14 * L, 26);
    return (
      shadow(25, 38, 14) +
      poly(
        [
          [x1, y1 - 7],
          [x2, y2 - 7],
          [x2, y2 + 5],
          [x1, y1 + 5],
        ],
        C.timber,
        C.timberd,
        1.4,
      ) +
      poly(
        [
          [x2 - 5, y2 - 4.6],
          [x2, y2 - 7],
          [x2, y2 + 5],
          [x2 - 5, y2 + 7.4],
        ],
        C.yellow,
        C.yellowd,
        1.2,
      ) +
      '<path d="M' +
      f(x1 + 1) +
      ' ' +
      f(y1 - 1.4) +
      'L' +
      f(x2 - 6) +
      ' ' +
      f(y2 - 1.4) +
      '" stroke="' +
      C.timberh +
      '" stroke-width="1.1"/>'
    );
  },
  'toeboard:steel': (L) => {
    const [x1, y1, x2, y2] = ends(26 + 14 * L, 26);
    return (
      shadow(25, 38, 14) +
      poly(
        [
          [x1, y1 - 6],
          [x2, y2 - 6],
          [x2, y2 + 5],
          [x1, y1 + 5],
        ],
        '#b9c4c8',
        C.ol,
        1.3,
      ) +
      line(x1 + 2, y1 - 2, x2 - 2, y2 - 2, '#8a979d', 1.2) +
      line(x1 + 2, y1 + 1.6, x2 - 2, y2 + 1.6, '#8a979d', 1.2) +
      poly(
        [
          [x1 - 2, y1 - 7],
          [x1 + 2, y1 - 8],
          [x1 + 2, y1 + 6],
          [x1 - 2, y1 + 7],
        ],
        C.yellow,
        C.yellowd,
        1.1,
      )
    );
  },
  'toeboard:gate': () => {
    let s =
      shadow(24, 41, 15) +
      poly(
        [
          [7, 14],
          [38, 6],
          [38, 34],
          [7, 42],
        ],
        'none',
        C.ol,
        0,
      ) +
      tube(8, 14, 8, 40, 3.6, C.yellow) +
      tube(38, 6, 38, 32, 3.6, C.yellow) +
      tube(8, 14, 38, 6, 3.6, C.yellow) +
      tube(8, 27, 38, 19, 3, C.yellow) +
      tube(8, 40, 38, 32, 3.6, C.yellow);
    return s;
  },
  // ---- decks and boards
  'plank:steel': (L) => deck(L, 11, '#c3cdd1', '#7d8a90', { holes: '#6b787e', lip: C.hi }),
  'plank:alu': (L) => deck(L, 12, C.alu, C.alud, { ribs: '#aebcc3', lip: '#fff' }),
  'plank:infill': (L) => deck(L, 6.4, '#c3cdd1', '#7d8a90', { holes: '#6b787e', lip: C.hi }),
  'plank:boiler': (L) =>
    deck(L, 4.2, '#b9c4c8', '#6b787e', { lip: C.hi }) +
    deck(L, 4.2, '#b9c4c8', '#6b787e', { lip: C.hi, cx: 22, cy: 33 }),
  'plank:lvl': (L) => deck(L, 10, C.lvl, C.lvld, { ribs: '#c99a52', lip: '#f6dca6' }),
  'plank:diwood': (L) => deck(L, 10, C.timber, C.timberd, { caps: '#7c878c', lip: C.timberh }),
  'plank:hatch': (L) => {
    const s = deck(L, 14, C.alu, C.alud, { lip: '#fff' });
    return (
      s +
      poly(
        [
          [19, 23.5],
          [26, 20],
          [30, 22.4],
          [23, 25.9],
        ],
        '#c98d52',
        C.ol,
        1,
      ) +
      line(21, 24.5, 28, 21, C.ol, 0.8)
    );
  },
  'plank:corner': () =>
    shadow(24, 38, 15) +
    poly(
      [
        [6, 34],
        [40, 18],
        [40, 22],
        [6, 38],
      ],
      '#7d8a90',
    ) +
    poly(
      [
        [6, 34],
        [40, 18],
        [28, 10],
      ],
      '#c3cdd1',
      C.ol,
      1.2,
    ) +
    '<circle cx="26" cy="19" r="1" fill="#6b787e"/><circle cx="31" cy="17" r="1" fill="#6b787e"/><circle cx="21" cy="23" r="1" fill="#6b787e"/>',
  'plank:panel': (L) => deck(L, 15, C.alu, C.alud, { ribs: '#aebcc3', lip: '#fff' }),
  'board:timber': (L) => {
    const s = 26 + 14 * L,
      [x1, y1, x2, y2] = ends(s, 26);
    const top = [
      [x1 - 3, y1 - 4],
      [x2 - 3, y2 - 4],
      [x2 + 3, y2 + 2],
      [x1 + 3, y1 + 2],
    ];
    return (
      shadow(25, 36, 13 + 6 * L) +
      poly(
        top.map((p) => [p[0], p[1] + 4]),
        C.timberd,
      ) +
      poly(top, C.timber) +
      '<path d="M' +
      f(x1 + 1) +
      ' ' +
      f(y1 - 1.6) +
      'L' +
      f(x2 - 4) +
      ' ' +
      f(y2 - 0.8) +
      'M' +
      f(x1 + 4) +
      ' ' +
      f(y1 + 0.2) +
      'L' +
      f(x2 - 7) +
      ' ' +
      f(y2 + 0.9) +
      '" stroke="' +
      C.timberh +
      '" stroke-width="1" opacity=".9"/><path d="M' +
      f(x2 - 4) +
      ' ' +
      f(y2 - 3) +
      'L' +
      f(x2 + 2) +
      ' ' +
      f(y2 + 1.4) +
      '" stroke="' +
      C.ol +
      '" stroke-width="2.4" opacity=".45"/>'
    );
  },
  // ---- fittings
  'coupler:double': () =>
    shadow(24, 40, 15) +
    '<rect x="5" y="14" width="18" height="22" rx="6" fill="' +
    C.yellow +
    '" stroke="' +
    C.yellowd +
    '" stroke-width="1.6"/><rect x="25" y="11" width="18" height="22" rx="6" fill="#dfe6e9" stroke="' +
    C.ol +
    '" stroke-width="1.6"/><circle cx="14" cy="25" r="5" fill="#5b676d"/><circle cx="34" cy="22" r="5" fill="#5b676d"/>' +
    tube(14, 14, 14, 5, 3.4, C.dark) +
    tube(34, 11, 34, 3, 3.4, C.dark) +
    '<path d="M8 18h11" stroke="#fff3c4" stroke-width="1.4" opacity=".8"/>',
  'coupler:swivel': () =>
    shadow(24, 40, 15) +
    dot(16, 26, 10, '#dfe6e9', C.ol, 1.6) +
    dot(16, 26, 4.6, '#5b676d', C.ol, 1) +
    dot(31, 19, 10, C.yellow, C.yellowd, 1.6) +
    dot(31, 19, 4.6, '#5b676d', C.ol, 1) +
    dot(23.5, 22.5, 2.6, C.gold, C.ol, 1) +
    tube(9, 19, 4, 14, 3, C.dark),
  'coupler:putlog': () =>
    shadow(24, 40, 14) +
    poly(
      [
        [6, 30],
        [30, 18],
        [36, 23],
        [12, 35],
      ],
      '#aab6bb',
      C.ol,
      1.4,
    ) +
    dot(32, 19, 9, '#dfe6e9', C.ol, 1.6) +
    dot(32, 19, 4.2, '#5b676d', C.ol, 1) +
    dot(11, 31, 2, C.gold, C.ol, 1) +
    tube(38, 12, 43, 6, 3, C.dark),
  'coupler:pin': () =>
    shadow(24, 40, 15) +
    tube(8, 32, 40, 16, 10, '#b6c1c6') +
    line(19, 26.6, 21, 30.6, C.ol, 1.6) +
    line(27, 22.6, 29, 26.6, C.ol, 1.6) +
    dot(24, 25, 2.4, C.gold, C.ol, 1),
  'coupler:clamp': () =>
    shadow(24, 40, 15) +
    '<path d="M10 30a10 10 0 0 1 20 -6" fill="none" stroke="' +
    C.ol +
    '" stroke-width="7.4" stroke-linecap="round"/><path d="M10 30a10 10 0 0 1 20 -6" fill="none" stroke="#c9d3d8" stroke-width="5" stroke-linecap="round"/>' +
    poly(
      [
        [28, 18],
        [40, 14],
        [42, 20],
        [30, 25],
      ],
      '#aab6bb',
      C.ol,
      1.3,
    ) +
    poly(
      [
        [34, 8],
        [38, 7],
        [37, 24],
        [33, 25],
      ],
      C.orange,
      C.oranged,
      1.2,
    ),
  'coupler:beam': () =>
    shadow(24, 40, 16) +
    poly(
      [
        [4, 30],
        [36, 16],
        [44, 20],
        [12, 34],
      ],
      '#6d7a80',
      C.ol,
      1.2,
    ) +
    poly(
      [
        [14, 18],
        [26, 13],
        [26, 26],
        [14, 31],
      ],
      '#c9d3d8',
      C.ol,
      1.4,
    ) +
    tube(20, 14, 20, 5, 3.4, C.dark) +
    dot(20, 22, 3, C.gold, C.ol, 1),
  'jack:base': () =>
    shadow(24, 41, 13) +
    poly(
      [
        [9, 35],
        [24, 29],
        [39, 35],
        [24, 41],
      ],
      '#6d7a80',
    ) +
    '<path d="M24 34V4" stroke="' +
    C.ol +
    '" stroke-width="7" stroke-linecap="round"/><path d="M24 34V4" stroke="#8c979c" stroke-width="5"/><path d="M21 8h6M21 11.5h6M21 15h6M21 18.5h6M21 26h6M21 29.5h6" stroke="' +
    C.ol +
    '" stroke-width="1.1"/>' +
    poly(
      [
        [12, 24],
        [36, 24],
        [32, 19],
        [16, 19],
      ],
      C.orange,
      C.oranged,
      1.4,
    ),
  'jack:uhead': () =>
    shadow(24, 42, 9) +
    '<path d="M24 40V14" stroke="' +
    C.ol +
    '" stroke-width="7" stroke-linecap="round"/><path d="M24 40V14" stroke="#8c979c" stroke-width="5"/><path d="M21 22h6M21 26h6M21 30h6M21 34h6" stroke="' +
    C.ol +
    '" stroke-width="1.1"/>' +
    poly(
      [
        [12, 6],
        [16, 6],
        [16, 12],
        [32, 12],
        [32, 6],
        [36, 6],
        [36, 16],
        [12, 16],
      ],
      '#aab6bb',
      C.ol,
      1.4,
    ) +
    poly(
      [
        [15, 28],
        [33, 28],
        [30, 24],
        [18, 24],
      ],
      C.orange,
      C.oranged,
      1.3,
    ),
  'jack:swivel': () =>
    shadow(24, 41, 13) +
    poly(
      [
        [6, 38],
        [22, 30],
        [38, 36],
        [22, 44],
      ],
      '#6d7a80',
    ) +
    dot(22, 34, 3, C.gold, C.ol, 1) +
    '<path d="M22 33L28 5" stroke="' +
    C.ol +
    '" stroke-width="7" stroke-linecap="round"/><path d="M22 33L28 5" stroke="#8c979c" stroke-width="5"/>' +
    poly(
      [
        [14, 22],
        [36, 22],
        [33, 17],
        [17, 17],
      ],
      C.orange,
      C.oranged,
      1.3,
    ),
  'plate:steel': () =>
    shadow(24, 38, 18) +
    poly(
      [
        [4, 31],
        [24, 22],
        [44, 31],
        [24, 40],
      ],
      '#6d7a80',
    ) +
    poly(
      [
        [4, 31],
        [24, 40],
        [24, 43],
        [4, 34],
      ],
      '#4c575c',
    ) +
    poly(
      [
        [24, 40],
        [44, 31],
        [44, 34],
        [24, 43],
      ],
      '#3b4448',
    ) +
    tube(24, 31, 24, 6, 6.4),
  'plate:sole': () =>
    shadow(24, 40, 19) +
    poly(
      [
        [3, 28],
        [26, 17],
        [45, 26],
        [22, 37],
      ],
      C.timber,
      C.timberd,
      1.3,
    ) +
    poly(
      [
        [3, 28],
        [22, 37],
        [22, 42],
        [3, 33],
      ],
      C.timberd,
    ) +
    poly(
      [
        [22, 37],
        [45, 26],
        [45, 31],
        [22, 42],
      ],
      '#6a3d19',
    ) +
    line(9, 27, 28, 18, C.timberh, 1) +
    line(14, 30, 33, 21, C.timberh, 1),
  'beam:girder': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 26);
    let s = shadow(24, 39, 15) + tube(x1, y1 + 6, x2, y2 + 6, 4) + tube(x1, y1 - 7, x2, y2 - 7, 4),
      n = 6;
    for (let k = 0; k < n; k++) {
      const P = (u) => at(x1, y1, x2, y2, u),
        [ax, ay] = P(k / n),
        [bx, by] = P((k + 0.5) / n),
        [cx, cy] = P((k + 1) / n);
      s +=
        '<path d="M' +
        f(ax) +
        ' ' +
        f(ay + 6) +
        'L' +
        f(bx) +
        ' ' +
        f(by - 7) +
        'L' +
        f(cx) +
        ' ' +
        f(cy + 6) +
        '" stroke="#8d9aa0" stroke-width="2.2" fill="none"/>';
    }
    return s;
  },
  'beam:alu': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 26);
    let s = shadow(24, 39, 15) + tube(x1, y1 + 6, x2, y2 + 6, 4.4, C.alu) + tube(x1, y1 - 7, x2, y2 - 7, 4.4, C.alu),
      n = 6;
    for (let k = 0; k < n; k++) {
      const P = (u) => at(x1, y1, x2, y2, u),
        [ax, ay] = P(k / n),
        [bx, by] = P((k + 0.5) / n),
        [cx, cy] = P((k + 1) / n);
      s +=
        '<path d="M' +
        f(ax) +
        ' ' +
        f(ay + 6) +
        'L' +
        f(bx) +
        ' ' +
        f(by - 7) +
        'L' +
        f(cx) +
        ' ' +
        f(cy + 6) +
        '" stroke="#b9c7ce" stroke-width="2" fill="none"/>';
    }
    return s;
  },
  'beam:truss': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 26);
    let s = shadow(24, 39, 15) + tube(x1, y1 + 5, x2, y2 + 5, 4) + tube(x1, y1 - 6, x2, y2 - 6, 4);
    for (let k = 0; k < 5; k++) {
      const P = (u) => at(x1, y1, x2, y2, u),
        [ax, ay] = P(k / 5),
        [bx, by] = P((k + 1) / 5);
      s += line(ax, ay + 5, bx, by - 6, '#8d9aa0', 2);
    }
    return (
      s +
      poly(
        [
          [x1 - 3.4, y1 - 9],
          [x1 + 2.6, y1 - 10.4],
          [x1 + 2.6, y1 + 8],
          [x1 - 3.4, y1 + 9.4],
        ],
        C.orange,
        C.oranged,
      ) +
      poly(
        [
          [x2 - 2.6, y2 - 10],
          [x2 + 3.4, y2 - 11.4],
          [x2 + 3.4, y2 + 7],
          [x2 - 2.6, y2 + 8.4],
        ],
        C.orange,
        C.oranged,
      )
    );
  },
  'beam:unit': (L) => {
    const [x1, y1, x2, y2] = ends(28 + 12 * L, 26);
    return (
      shadow(24, 38, 15) +
      poly(
        [
          [x1, y1 - 6],
          [x2, y2 - 6],
          [x2, y2 + 5],
          [x1, y1 + 5],
        ],
        '#c9d3d8',
        C.ol,
        1.3,
      ) +
      line(x1, y1 - 4, x2, y2 - 4, C.alud, 1.4) +
      line(x1, y1 + 3, x2, y2 + 3, C.alud, 1.4)
    );
  },
  'stairs:stair': () => {
    let s = shadow(24, 42, 16) + tube(6, 40, 38, 8, 4, C.alu) + tube(11, 43, 43, 11, 4, C.alu);
    for (let k = 0; k < 5; k++) {
      const x = 10 + k * 7,
        y = 37 - k * 7;
      s += poly(
        [
          [x - 4, y],
          [x + 3, y - 1.6],
          [x + 7, y + 1.4],
          [x, y + 3],
        ],
        C.dark,
        C.ol,
        0.9,
      );
    }
    return s;
  },
  'stairs:stringer': () => {
    let s =
      shadow(24, 42, 16) +
      poly(
        [
          [5, 40],
          [37, 8],
          [42, 11],
          [10, 43],
        ],
        '#b9c4c8',
        C.ol,
        1.3,
      );
    for (let k = 0; k < 5; k++) {
      const x = 11 + k * 6.4,
        y = 35 - k * 6.4;
      s += line(x, y, x + 5, y + 2.6, C.dark, 1.6);
    }
    return s;
  },
  'stairs:tread': () =>
    shadow(24, 38, 17) +
    poly(
      [
        [5, 26],
        [27, 15],
        [43, 22],
        [21, 33],
      ],
      '#9aa6ab',
      C.ol,
      1.3,
    ) +
    poly(
      [
        [5, 26],
        [21, 33],
        [21, 37],
        [5, 30],
      ],
      '#6b787e',
    ) +
    poly(
      [
        [21, 33],
        [43, 22],
        [43, 26],
        [21, 37],
      ],
      '#56626a',
    ) +
    line(10, 26, 30, 16.6, '#c9d3d8', 1) +
    line(14, 28, 34, 18.6, '#c9d3d8', 1) +
    line(18, 30, 38, 20.6, '#c9d3d8', 1),
  'stairs:handrail': () =>
    shadow(24, 42, 15) +
    tube(6, 30, 38, 6, 4, C.yellow) +
    tube(10, 40, 10, 27, 3.4) +
    tube(34, 18, 34, 8, 3.4) +
    tube(22, 29, 22, 17, 3.4),
  'ladder:ladder': (L) => {
    const h = 30 + 10 * L,
      y0 = 25 + h / 2,
      y1 = 25 - h / 2;
    let s = shadow(24, y0 + 2, 12) + tube(14, y0, 15, y1, 4.2, C.alu) + tube(33, y0, 34, y1, 4.2, C.alu);
    for (let y = y0 - 5; y > y1 + 2; y -= 6.5) s += tube(14.6, y, 33.4, y, 3, C.alu);
    return s;
  },
  'bracket:hopup': () =>
    shadow(24, 42, 13) + tube(12, 42, 12, 6, 5.4) + tube(12, 9, 40, 9, 5.4) + tube(12, 36, 38, 10, 4, C.orange),
  'bracket:wall': () =>
    shadow(24, 42, 13) +
    poly(
      [
        [6, 10],
        [14, 6],
        [14, 40],
        [6, 44],
      ],
      '#7c878c',
      C.ol,
      1.3,
    ) +
    tube(14, 24, 42, 14, 5) +
    dot(10, 16, 1.6, C.gold, C.ol, 0.8) +
    dot(10, 34, 1.6, C.gold, C.ol, 0.8),
  'small:pin': () =>
    shadow(24, 40, 14) +
    tube(10, 36, 36, 12, 4.4, C.steel) +
    '<circle cx="38" cy="10" r="5" fill="none" stroke="' +
    C.ol +
    '" stroke-width="3"/><circle cx="38" cy="10" r="5" fill="none" stroke="' +
    C.gold +
    '" stroke-width="1.4"/>',
  'small:wedge': () =>
    shadow(24, 40, 14) +
    poly(
      [
        [12, 8],
        [26, 6],
        [22, 40],
        [16, 41],
      ],
      C.orange,
      C.oranged,
      1.4,
    ) +
    line(18, 12, 21, 12, '#ffd9a8', 1.4),
  'wheel:wheel': () =>
    shadow(24, 44, 13) +
    '<path d="M13 5h22v5H13Z" fill="' +
    C.steel +
    '" stroke="' +
    C.ol +
    '" stroke-width="1.4"/>' +
    tube(18, 10, 20, 24, 3.4) +
    tube(30, 10, 28, 24, 3.4) +
    '<circle cx="24" cy="30" r="12" fill="#2d3538" stroke="' +
    C.ol +
    '" stroke-width="1.6"/><circle cx="24" cy="30" r="5" fill="' +
    C.steel +
    '"/>',
  'tool:tool': () =>
    shadow(24, 42, 15) +
    tube(7, 40, 28, 17, 6, C.red) +
    '<circle cx="33" cy="12" r="8.5" fill="' +
    C.steel +
    '" stroke="' +
    C.ol +
    '" stroke-width="1.6"/><path d="M29.5 8.5l7 7" stroke="' +
    C.ol +
    '" stroke-width="3.6"/>',
  'box:cage': () => {
    let s =
      shadow(24, 43, 18) +
      poly(
        [
          [5, 20],
          [24, 12],
          [43, 20],
          [24, 28],
        ],
        '#3e6b52',
      ) +
      poly(
        [
          [5, 20],
          [24, 28],
          [24, 44],
          [5, 36],
        ],
        'none',
        C.ol,
        0,
      ) +
      poly(
        [
          [24, 28],
          [43, 20],
          [43, 36],
          [24, 44],
        ],
        'none',
        C.ol,
        0,
      );
    for (const x of [5, 12, 18, 24]) s += line(x, 20 + (x - 5) * 0.42, x, 36 + (x - 5) * 0.42, '#2f7d4f', 2);
    for (const x of [30, 36, 43]) s += line(x, 28 - (x - 24) * 0.42, x, 44 - (x - 24) * 0.42, '#2f7d4f', 2);
    return (
      s +
      line(5, 36, 24, 44, '#1f5a38', 3) +
      line(24, 44, 43, 36, '#1f5a38', 3) +
      line(5, 20, 24, 28, '#2f7d4f', 2) +
      line(24, 28, 43, 20, '#2f7d4f', 2)
    );
  },
  'box:box': () =>
    shadow(24, 42, 17) +
    poly(
      [
        [5, 17],
        [24, 9],
        [43, 17],
        [24, 25],
      ],
      '#e3be83',
    ) +
    poly(
      [
        [5, 17],
        [24, 25],
        [24, 44],
        [5, 36],
      ],
      '#c99a5c',
    ) +
    poly(
      [
        [24, 25],
        [43, 17],
        [43, 36],
        [24, 44],
      ],
      '#b0824a',
    ) +
    '<path d="M14.5 13l19 8" stroke="#8a6232" stroke-width="2.4"/>',
};
const LOOK_DEFAULT = {
  tube: 'galv',
  standard: 'cup',
  ledger: 'blade',
  transom: 'normal',
  brace: 'diag',
  rail: 'rail',
  toeboard: 'toe',
  plank: 'steel',
  board: 'timber',
  coupler: 'double',
  jack: 'base',
  plate: 'steel',
  beam: 'girder',
  stairs: 'stair',
  ladder: 'ladder',
  bracket: 'hopup',
  small: 'pin',
  wheel: 'wheel',
  tool: 'tool',
  box: 'box',
};
// Which picture a component gets. The name decides first ("Ledger to plank transom" is a transom, "Aluminium ladder" a ladder even in the
// "Stairs & ladders" category); the category only when the name says nothing.
function kindOfName(n) {
  if (/caster|castor|ginny wheel|gin wheel/.test(n)) return 'wheel';
  if (/spanner|hammer|ratchet|\btools?\b|podger|\bbelt\b/.test(n)) return 'tool';
  if (/jack|u-? ?head|saddle|universal screw/.test(n) && !/retainer/.test(n)) return 'jack';
  if (/base plate|sole ?board|mudsill|sole ?plate/.test(n)) return 'plate';
  if (/hop ?-?up|bracket|davit/.test(n) && !/ladder bracket wedge/.test(n)) return 'bracket';
  if (/stair|stringer|tread/.test(n)) return 'stairs';
  if (/ladder/.test(n)) {
    if (/transom/.test(n)) return 'transom';
    if (/beam/.test(n)) return 'beam';
    if (/clamp/.test(n)) return 'coupler';
    if (/hatch|plank|deck/.test(n)) return 'plank';
    if (/wedge/.test(n)) return 'small';
    return 'ladder';
  }
  if (/brace/.test(n) && !/brace ends/.test(n)) return 'brace';
  if (/coupler|clamp|joiner|joint pin|adapt|clevis|beam clip|sleeve|t bolt/.test(n)) return 'coupler';
  if (/toe ?board|swing gate/.test(n)) return 'toeboard';
  if (/guardrail|handrail|top rail|\brail\b|edge protection|post/.test(n)) return 'rail';
  if (/beam|girder|truss|lattice/.test(n)) return 'beam';
  if (/transom|putlog/.test(n)) return 'transom';
  if (/timber plank|scaffold board|timber board/.test(n)) return 'board';
  if (/plank|deck|panel|batten|platform|\bboard\b/.test(n)) return 'plank';
  if (/brace/.test(n)) return 'brace';
  if (/ledger|horizontal|tie bar|capping/.test(n)) return 'ledger';
  if (/standard|vertical|spigot|collar|starter/.test(n)) return 'standard';
  if (/tube|pipe/.test(n)) return 'tube';
  if (/wedge|pin|clip|pressing|retainer|restraint|bolt|\bnut\b|banana|topper/.test(n)) return 'small';
  if (/cage|pallet|stillage|rack/.test(n)) return 'box';
  return null;
}
const CAT = {
  tube: 'tube',
  'standards / verticals': 'standard',
  'ledgers / horizontals': 'ledger',
  transoms: 'transom',
  braces: 'brace',
  'decking / planks': 'plank',
  'guardrails & toeboards': 'rail',
  'base plates & jacks': 'jack',
  'couplers & fittings': 'coupler',
  'stairs & ladders': 'stairs',
  beams: 'beam',
  tools: 'tool',
};
export function gaKind(p) {
  const n = String(p?.name ?? '').toLowerCase();
  return (
    kindOfName(n) ??
    CAT[String(p?.category ?? '').toLowerCase()] ??
    kindOfName(String(p?.category ?? '').toLowerCase()) ??
    'box'
  );
}
// Its look within the kind (galvanised or aluminium tube, cups or rosettes, a steel or timber deck ...).
export function gaLook(p) {
  const k = gaKind(p),
    n = String(p?.name ?? '').toLowerCase(),
    sys = p?.system;
  switch (k) {
    case 'tube':
      return /alumin/.test(n) ? 'alu' : 'galv';
    case 'standard':
      return /collar|starter/.test(n)
        ? 'collar'
        : /spigot/.test(n) && !/standard/.test(n)
          ? 'spigot'
          : /ringlock|rosette|o-type/.test(n) || sys === 'at-pac'
            ? 'ring'
            : 'cup';
    case 'ledger':
      return /tie bar/.test(n)
        ? 'tie'
        : /heavy|bfs/.test(n)
          ? 'heavy'
          : /raised|capping/.test(n)
            ? 'raised'
            : /o-type|ringlock/.test(n) || sys === 'at-pac'
              ? 'ring'
              : 'blade';
    case 'transom':
      return /ladder/.test(n) ? 'ladder' : /plank/.test(n) ? 'plank' : /mid|intermediate/.test(n) ? 'mid' : 'normal';
    case 'brace':
      return /heavy|bfs/.test(n) ? 'heavy' : /plan|telescop|ledger brace|horizontal/.test(n) ? 'plan' : 'diag';
    case 'rail':
      return /post|standard|edge protection/.test(n) ? 'post' : 'rail';
    case 'toeboard':
      return /gate/.test(n) ? 'gate' : /interlocking|steel/.test(n) ? 'steel' : 'toe';
    case 'plank':
      return /hatch/.test(n)
        ? 'hatch'
        : /corner plank|corner filler/.test(n) && !/with ledger/.test(n)
          ? 'corner'
          : /boiler/.test(n)
            ? 'boiler'
            : /infill/.test(n)
              ? 'infill'
              : /lvl|laminated/.test(n)
                ? 'lvl'
                : /di-|wood/.test(n)
                  ? 'diwood'
                  : /panel/.test(n)
                    ? 'panel'
                    : /alumin|lap/.test(n)
                      ? 'alu'
                      : 'steel';
    case 'coupler':
      return /beam|girder|gravelock/.test(n)
        ? 'beam'
        : /swivel/.test(n)
          ? 'swivel'
          : /putlog|half|single|hook|hoarding|tee/.test(n)
            ? 'putlog'
            : /joint pin|joiner|sleeve/.test(n)
              ? 'pin'
              : /double|right angle|cc coupler/.test(n) && !/clamp/.test(n)
                ? 'double'
                : 'clamp';
    case 'jack':
      return /u-? ?head|saddle/.test(n) ? 'uhead' : /swivel/.test(n) ? 'swivel' : 'base';
    case 'plate':
      return /sole|mudsill/.test(n) && !/steel sole/.test(n) ? 'sole' : 'steel';
    case 'beam':
      return /unit beam/.test(n) ? 'unit' : /truss/.test(n) ? 'truss' : /alumin/.test(n) ? 'alu' : 'girder';
    case 'stairs':
      return /stringer/.test(n)
        ? 'stringer'
        : /tread/.test(n)
          ? 'tread'
          : /handrail|guardrail|top rail/.test(n)
            ? 'handrail'
            : 'stair';
    case 'bracket':
      return /wall tie/.test(n) ? 'wall' : 'hopup';
    case 'small':
      return /wedge|pressing/.test(n) ? 'wedge' : 'pin';
    case 'box':
      return /cage|pallet|stillage|rack/.test(n) ? 'cage' : 'box';
    default:
      return LOOK_DEFAULT[k] ?? 'box';
  }
}
// Length in metres from the catalogue (length in mm) or the name ("3.0 m", "2400 mm", "10'", "7ft"); null when unknown.
export function gaLength(p) {
  if (p?.length > 0) return p.length / 1000;
  const s = String(p?.name ?? '') + ' ' + String(p?.nominalSize ?? '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*m(?![m\w])/i);
  if (m) return +m[1];
  m = s.match(/(\d{3,5})\s*mm/i);
  if (m) return +m[1] / 1000;
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet)/i);
  if (m) return +m[1] * 0.3048;
  return null;
}
// 0..1 across the usual scaffold lengths (0.5 m .. 6.4 m); unknown lengths draw in the middle.
const lenScale = (m) => (m == null ? 0.55 : Math.max(0, Math.min(1, (m - 0.5) / 5.9)));
const LONG = new Set([
  'tube',
  'standard',
  'ledger',
  'transom',
  'brace',
  'rail',
  'plank',
  'board',
  'toeboard',
  'beam',
  'ladder',
]);
// Short length words for the slot's corner while picking: 3m, 2.4m.
export function gaLenTag(p) {
  const m = gaLength(p);
  if (m == null || !LONG.has(gaKind(p))) return '';
  return Math.round(m * 10) / 10 + 'm';
}
// The family a part belongs to (its name without sizes), so a row of the grid runs short to long within one family.
export const gaFamily = (p) =>
  String(p?.name ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\d+(?:[.,]\d+)?\s*(?:mm|m|ft|kg|'|")?(?![a-z])/g, '')
    .replace(/\s+x\s+/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();
const urls = new Map();
function svgURL(key, body, vb = '2 2 44 44') {
  let u = urls.get(key);
  if (u) return u;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" fill="none">' + body + '</svg>';
  try {
    u =
      typeof Blob === 'function' && typeof URL?.createObjectURL === 'function'
        ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        : '';
  } catch {
    u = '';
  }
  urls.set(key, u);
  return u;
}
const draw = (kind, look, L) =>
  (ART[kind + ':' + look] ?? ART[kind + ':' + (LOOK_DEFAULT[kind] ?? 'box')] ?? ART['box:box'])(L);
// The item picture of a component as an <img> (or, where there is no Blob, the Materials list's line icon).
export function gaItemURL(p) {
  const kind = gaKind(p),
    look = gaLook(p),
    L = lenScale(gaLength(p)),
    step = Math.round(L * 4) / 4;
  return svgURL('it-' + kind + '-' + look + '-' + step, draw(kind, look, step));
}
export function gaItem(p, cls = 'gm-pic') {
  const u = gaItemURL(p);
  return u ? '<img class="' + cls + '" src="' + u + '" alt="" draggable="false">' : componentIcon(p);
}
export const gaKindPic = (kind, L = 0.6, cls = 'gm-pic', look = LOOK_DEFAULT[kind]) => {
  const u = svgURL('it-' + kind + '-' + look + '-' + L, draw(kind, look, L));
  return u ? '<img class="' + cls + '" src="' + u + '" alt="" draggable="false">' : '';
};
// The inventory's category tabs: what each tab holds, its picture and name (a tab with nothing in it is left out).
export const GA_TABS = [
  { id: 'all', name: 'All', pic: () => gaImg(GA_BUTTONS.stock(), 'gm-tab-pic gm-tab-all') },
  { id: 'tubes', name: 'Tubes', pic: () => gaKindPic('tube', 0.8, 'gm-tab-pic') },
  { id: 'frame', name: 'Frame', pic: () => gaKindPic('ledger', 0.7, 'gm-tab-pic') },
  { id: 'boards', name: 'Boards', pic: () => gaKindPic('plank', 0.7, 'gm-tab-pic') },
  { id: 'fittings', name: 'Fittings', pic: () => gaKindPic('coupler', 0.5, 'gm-tab-pic') },
  { id: 'access', name: 'Access', pic: () => gaKindPic('ladder', 0.6, 'gm-tab-pic') },
  { id: 'beams', name: 'Beams', pic: () => gaKindPic('beam', 0.7, 'gm-tab-pic') },
];
const TAB_OF = {
  tube: 'tubes',
  standard: 'frame',
  ledger: 'frame',
  transom: 'frame',
  brace: 'frame',
  rail: 'boards',
  plank: 'boards',
  board: 'boards',
  toeboard: 'boards',
  coupler: 'fittings',
  plate: 'fittings',
  jack: 'fittings',
  small: 'fittings',
  tool: 'fittings',
  wheel: 'fittings',
  box: 'fittings',
  bracket: 'fittings',
  stairs: 'access',
  ladder: 'access',
  beam: 'beams',
};
// Rows inside a tab, top to bottom (a new row starts for each).
export const GA_ROW_ORDER = [
  'tube',
  'standard',
  'ledger',
  'transom',
  'brace',
  'plank',
  'board',
  'toeboard',
  'rail',
  'coupler',
  'small',
  'plate',
  'jack',
  'bracket',
  'wheel',
  'tool',
  'box',
  'ladder',
  'stairs',
  'beam',
];
export const gaTab = (p) => TAB_OF[gaKind(p)] ?? 'fittings';
// The big buttons' pictures and the office door, drawn at 0 0 96 72.
const truck = (flip = false) =>
  '<g' +
  (flip ? ' transform="translate(96 0) scale(-1 1)"' : '') +
  '>' +
  shadow(46, 60, 34, 5) +
  poly(
    [
      [10, 30],
      [58, 30],
      [58, 52],
      [10, 52],
    ],
    '#e7ecee',
  ) +
  poly(
    [
      [10, 30],
      [58, 30],
      [58, 34],
      [10, 34],
    ],
    '#cfd8dc',
  ) +
  poly(
    [
      [58, 36],
      [76, 36],
      [84, 46],
      [84, 56],
      [58, 56],
    ],
    '#2f7d4f',
  ) +
  poly(
    [
      [62, 39],
      [74, 39],
      [80, 46],
      [62, 46],
    ],
    '#bfe3f2',
  ) +
  poly(
    [
      [8, 52],
      [86, 52],
      [86, 57],
      [8, 57],
    ],
    '#3a4548',
  ) +
  '<circle cx="22" cy="58" r="6" fill="#23302f"/><circle cx="22" cy="58" r="2.4" fill="#c6d0d4"/><circle cx="70" cy="58" r="6" fill="#23302f"/><circle cx="70" cy="58" r="2.4" fill="#c6d0d4"/>' +
  tube(14, 44, 54, 40, 4.2) +
  tube(14, 38, 54, 34, 4.2) +
  '</g>';
const arrow = (x, y, dir = 1, col = '#b9ef4b') =>
  '<g transform="translate(' +
  x +
  ' ' +
  y +
  ') scale(' +
  dir +
  ' 1)"><path d="M-12 -5h12v-7l13 12-13 12v-7h-12Z" fill="' +
  col +
  '" stroke="#1b3a2a" stroke-width="2" stroke-linejoin="round"/></g>';
export const GA_BUTTONS = {
  send: () => svgURL('btn-send', truck() + arrow(80, 18), '0 0 96 72'),
  back: () => svgURL('btn-back', truck(true) + arrow(18, 18, -1, '#ffd25a'), '0 0 96 72'),
  add: () =>
    svgURL(
      'btn-add',
      shadow(44, 62, 32, 5) +
        poly(
          [
            [14, 34],
            [44, 22],
            [74, 34],
            [44, 46],
          ],
          '#d9e0e3',
        ) +
        poly(
          [
            [14, 34],
            [44, 46],
            [44, 62],
            [14, 50],
          ],
          '#aab6bb',
        ) +
        poly(
          [
            [44, 46],
            [74, 34],
            [74, 50],
            [44, 62],
          ],
          '#8f9ca2',
        ) +
        tube(20, 34, 46, 23, 3.4) +
        tube(24, 37, 50, 26, 3.4) +
        tube(28, 40, 54, 29, 3.4) +
        '<path d="M14 34v16M44 46v16M74 34v16" stroke="#2f7d4f" stroke-width="3"/><circle cx="76" cy="18" r="13" fill="#b9ef4b" stroke="#1b3a2a" stroke-width="2.4"/><path d="M76 11v14M69 18h14" stroke="#1b3a2a" stroke-width="3.6" stroke-linecap="round"/>',
      '0 0 96 72',
    ),
  office: () =>
    svgURL(
      'btn-office',
      poly(
        [
          [14, 30],
          [48, 14],
          [82, 30],
          [82, 34],
          [14, 34],
        ],
        '#4e6b58',
      ) +
        poly(
          [
            [18, 34],
            [78, 34],
            [78, 64],
            [18, 64],
          ],
          '#f1ecdc',
        ) +
        poly(
          [
            [40, 44],
            [56, 44],
            [56, 64],
            [40, 64],
          ],
          '#2f5d45',
        ) +
        '<circle cx="52" cy="54" r="1.6" fill="#e3bd2c"/>' +
        poly(
          [
            [24, 40],
            [34, 40],
            [34, 50],
            [24, 50],
          ],
          '#6fa2c0',
          C.ol,
          1,
        ) +
        poly(
          [
            [62, 40],
            [72, 40],
            [72, 50],
            [62, 50],
          ],
          '#6fa2c0',
          C.ol,
          1,
        ),
      '0 0 96 72',
    ),
  stock: () =>
    svgURL(
      'btn-stock',
      shadow(48, 62, 32, 5) +
        poly(
          [
            [18, 24],
            [48, 12],
            [78, 24],
            [48, 36],
          ],
          '#d9e0e3',
        ) +
        poly(
          [
            [18, 24],
            [48, 36],
            [48, 62],
            [18, 50],
          ],
          '#aab6bb',
        ) +
        poly(
          [
            [48, 36],
            [78, 24],
            [78, 50],
            [48, 62],
          ],
          '#8f9ca2',
        ) +
        tube(24, 24, 50, 14, 3.4) +
        tube(28, 27, 54, 17, 3.4) +
        tube(32, 30, 58, 20, 3.4),
      '0 0 96 72',
    ),
};
export const gaImg = (url, cls = '') =>
  url ? '<img class="' + cls + '" src="' + url + '" alt="" draggable="false">' : '';
// The three scaffold systems for "Which scaffold do you use?": each shown by its own typical parts (cups, rosettes, tube and fittings).
export function gaSystemPic(id, cls = '') {
  const body =
    id === 'quickstage'
      ? '<g transform="translate(4 4) scale(.8)">' +
        ART['standard:cup'](0.7) +
        '</g><g transform="translate(34 18) scale(.7)">' +
        ART['ledger:blade'](0.5) +
        '</g><g transform="translate(20 34) scale(.6)">' +
        ART['transom:normal'](0.4) +
        '</g>'
      : id === 'at-pac'
        ? '<g transform="translate(4 4) scale(.8)">' +
          ART['standard:ring'](0.7) +
          '</g><g transform="translate(34 18) scale(.7)">' +
          ART['ledger:ring'](0.5) +
          '</g><g transform="translate(20 34) scale(.6)">' +
          ART['brace:diag'](0.5) +
          '</g>'
        : '<g transform="translate(4 8) scale(.9)">' +
          ART['tube:galv'](0.8) +
          '</g><g transform="translate(40 30) scale(.6)">' +
          ART['coupler:double']() +
          '</g><g transform="translate(6 38) scale(.5)">' +
          ART['coupler:swivel']() +
          '</g>';
  return gaImg(svgURL('sys-' + id, body, '0 0 80 72'), cls);
}
// Any sprite of the app as a cached picture: spr-* and ov-site through ovImg, the page sheets' symbols (sg-yard, sg-list, si-site, si-crane, hc-board,
// hr-board, hr-tag) through their own sheets.
let symbols = null;
export function gaSprite(id, cls = '') {
  if (id.startsWith('spr-') || id === 'ov-site') return ovImg(id, cls);
  symbols ??= new Map(
    [
      ...(sgSheet() + siSheet() + hcSheet() + hrSheet()).matchAll(
        /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g,
      ),
    ].map((m) => [m[1], [m[2], m[3]]]),
  );
  const d = symbols.get(id);
  if (!d) return '';
  return ovImg('gm-sym-' + id, cls, d[0], d[1]);
} // with every main sprite in its defs (sg-yard stands the main sheet's stillages on its pad)
// The first-run yard size pictures: a fenced pad in the plan's colours, sized S / M / L, with a few of the plan's own stillages and a forklift on it;
// centred in its picture so the largest one is never cut off.
export function gaYardPad(size, cls = '') {
  const k = { S: 0.62, M: 0.8, L: 1 }[size] ?? 0.8,
    W = 118 * k,
    D = 78 * k,
    ox = 100 - (W - D) * 0.433,
    oy = 74 - (W + D) * 0.25,
    P = (x, y) => [f(ox + (x - y) * 0.866), f(oy + (x + y) * 0.5)];
  const pad = (a, b, c, d, fill) =>
    '<path d="M' +
    P(...a).join(' ') +
    'L' +
    P(...b).join(' ') +
    'L' +
    P(...c).join(' ') +
    'L' +
    P(...d).join(' ') +
    'Z" fill="' +
    fill +
    '"/>';
  let s =
    '<ellipse cx="100" cy="' +
    f(oy + (W + D) * 0.5 + 10) +
    '" rx="' +
    f(70 * k + 14) +
    '" ry="' +
    f(12 * k + 4) +
    '" fill="#000" opacity=".12"/>' +
    pad([-8, -8], [W + 8, -8], [W + 8, D + 8], [-8, D + 8], '#8fa866') +
    pad([0, 0], [W, 0], [W, D], [0, D], '#d8d1c1');
  const [a1, a2] = [P(0, D), P(W, D)],
    [b1] = [P(W, 0)];
  s +=
    '<path d="M' +
    a1.join(' ') +
    'L' +
    a2.join(' ') +
    'L' +
    b1.join(' ') +
    '" fill="none" stroke="#a79f8b" stroke-width="3"/>';
  s +=
    '<path d="M' +
    P(0, D).join(' ') +
    'L' +
    P(0, 0).join(' ') +
    'L' +
    P(W, 0).join(' ') +
    '" fill="none" stroke="#9aa6a0" stroke-width="1.6"/><path d="M' +
    P(W * 0.62, D * 0.66).join(' ') +
    'L' +
    P(W * 0.92, D * 0.66).join(' ') +
    'L' +
    P(W * 0.92, D * 0.92).join(' ') +
    'L' +
    P(W * 0.62, D * 0.92).join(' ') +
    'Z" fill="none" stroke="#e3bd2c" stroke-width="1.6" stroke-dasharray="4 3"/>';
  const n = { S: 3, M: 6, L: 10 }[size] ?? 6,
    spots = [];
  for (let i = 0; i < n; i++) spots.push([12 + (i % 4) * 21 * k * 1.2, 12 + Math.floor(i / 4) * 21 * k * 1.1]);
  for (const [x, y] of spots) {
    const [sx, sy] = P(x, y);
    s += '<use href="#spr-stillage" x="' + f(sx - 15) + '" y="' + f(sy - 14) + '" width="30" height="20"/>';
  }
  const [fx, fy] = P(W * 0.5, D * 0.62);
  s += '<use href="#spr-forklift-load" x="' + f(fx - 16) + '" y="' + f(fy - 23) + '" width="32" height="26"/>';
  return ovImg('gm-pad2-' + size, cls, '0 0 200 150', s);
}
