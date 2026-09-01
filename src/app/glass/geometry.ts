/**
 * Shard geometry for the shattered-glass surface.
 *
 * Every number in this file is verbatim from "Broken by Design — Shattered
 * Glass Hero" by Guglielmo Giannattasio (@gughigug on 21st.dev,
 * https://21st.dev/@gughigug/components/broken-by-design), retrieved
 * 2026-08-31 via the 21st.dev registry. The operator asked for that
 * component's exact assets so the glass reads as real glass, so the piece
 * rects, atlas rects, crack polylines and resting poses are reproduced
 * unchanged rather than re-derived — they were traced from a photograph of
 * an actual fracture, and any "tidying" of them stops the pane looking
 * like broken glass and starts it looking like a CSS polygon.
 *
 * The atlas PNGs themselves are vendored into public/shards/ rather than
 * loaded from the author's jsdelivr CDN: this app must not depend on a
 * third-party host at runtime, and the files are ~285KB each, served from
 * our own Worker's static assets.
 */

/** One fragment: position and size as a % of the pane, plus its centre (for the entrance) and depth ring (for parallax). */
export interface Piece {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  ring: number;
}

export const DESKTOP: Piece[] = [
  { id: "desktop-01a", x: 80.214, y: 5.299, w: 15.445, h: 72.943, cx: 87.96, cy: 41.83, ring: 2 },
  { id: "desktop-01b", x: 92.39, y: 31.004, w: 6.144, h: 52.762, cx: 95.32, cy: 58.4, ring: 2 },
  { id: "desktop-02a", x: 31.285, y: 7.44, w: 15.614, h: 40.023, cx: 38.98, cy: 27.34, ring: 1 },
  { id: "desktop-02b", x: 5.073, y: 6.313, w: 31.567, h: 39.572, cx: 20.94, cy: 26.04, ring: 1 },
  { id: "desktop-02c", x: 4.791, y: 9.808, w: 19.786, h: 25.93, cx: 14.63, cy: 22.6, ring: 1 },
  { id: "desktop-03a", x: 18.771, y: 38.444, w: 28.636, h: 52.649, cx: 32.92, cy: 64.66, ring: 1 },
  { id: "desktop-03b", x: 4.735, y: 35.964, w: 15.558, h: 11.612, cx: 12.63, cy: 41.88, ring: 1 },
  { id: "desktop-03c", x: 3.044, y: 46.111, w: 26.719, h: 45.547, cx: 16.52, cy: 68.43, ring: 1 },
  { id: "desktop-04a", x: 42.785, y: 7.892, w: 25.536, h: 36.077, cx: 55.55, cy: 25.82, ring: 0 },
  { id: "desktop-04b", x: 50.057, y: 7.554, w: 34.16, h: 29.876, cx: 67.08, cy: 22.55, ring: 0 },
  { id: "desktop-05a", x: 37.655, y: 46.786, w: 14.149, h: 18.489, cx: 44.79, cy: 55.86, ring: 0 },
  { id: "desktop-05b", x: 46.11, y: 37.88, w: 34.611, h: 26.945, cx: 63.28, cy: 51.24, ring: 0 },
  { id: "desktop-06a", x: 44.645, y: 68.659, w: 32.694, h: 24.464, cx: 60.94, cy: 80.5, ring: 0 },
  { id: "desktop-06b", x: 47.238, y: 66.404, w: 26.945, h: 12.852, cx: 60.85, cy: 72.55, ring: 0 },
  { id: "desktop-07a", x: 74.972, y: 57.61, w: 12.12, h: 34.498, cx: 81.14, cy: 74.69, ring: 2 },
  { id: "desktop-07b", x: 84.273, y: 66.855, w: 10.654, h: 25.028, cx: 89.54, cy: 79.65, ring: 2 },
];

export const MOBILE: Piece[] = [
  { id: "mobile-01a", x: 51.817, y: 3.633, w: 39.625, h: 22.343, cx: 71.45, cy: 14.78, ring: 2 },
  { id: "mobile-01b", x: 7.972, y: 4.338, w: 60.258, h: 19.469, cx: 38.39, cy: 14.13, ring: 2 },
  { id: "mobile-01c", x: 59.789, y: 3.958, w: 13.013, h: 5.369, cx: 66.3, cy: 6.81, ring: 2 },
  { id: "mobile-02a", x: 7.034, y: 19.36, w: 36.811, h: 34.111, cx: 25.44, cy: 36.36, ring: 0 },
  { id: "mobile-02b", x: 10.082, y: 18.872, w: 48.886, h: 24.024, cx: 34.23, cy: 30.99, ring: 0 },
  { id: "mobile-03a", x: 10.316, y: 69.685, w: 35.287, h: 13.178, cx: 27.84, cy: 76.36, ring: 1 },
  { id: "mobile-03b", x: 9.144, y: 73.59, w: 60.844, h: 22.397, cx: 39.62, cy: 84.6, ring: 1 },
  { id: "mobile-04a", x: 8.91, y: 55.965, w: 67.057, h: 22.56, cx: 42.38, cy: 67.14, ring: 0 },
  { id: "mobile-04b", x: 13.834, y: 52.603, w: 56.389, h: 11.714, cx: 41.79, cy: 58.6, ring: 0 },
  { id: "mobile-04c", x: 42.556, y: 56.508, w: 47.831, h: 13.503, cx: 66.0, cy: 63.31, ring: 0 },
  { id: "mobile-05a", x: 63.54, y: 11.985, w: 29.426, h: 14.479, cx: 78.43, cy: 19.28, ring: 1 },
  { id: "mobile-05b", x: 57.796, y: 16.595, w: 34.584, h: 28.145, cx: 75.03, cy: 30.56, ring: 1 },
  { id: "mobile-06a", x: 61.313, y: 71.529, w: 26.495, h: 24.403, cx: 74.68, cy: 83.73, ring: 2 },
  { id: "mobile-06b", x: 76.905, y: 67.462, w: 14.42, h: 18.113, cx: 83.76, cy: 76.57, ring: 2 },
  { id: "mobile-07a", x: 32.474, y: 46.312, w: 54.396, h: 10.521, cx: 58.97, cy: 51.44, ring: 0 },
  { id: "mobile-07b", x: 43.494, y: 37.961, w: 48.3, h: 18.872, cx: 67.53, cy: 47.37, ring: 0 },
];

export type SetKey = "desktop" | "mobile";

/**
 * One sprite sheet per breakpoint instead of 16 separate PNGs — 1 HTTP
 * request for the whole pane rather than 16, which is what actually made
 * the glass feel slow to arrive. Rects are [x, y, w, h] in atlas pixels.
 */
const ATLAS: Record<SetKey, { url: string; w: number; h: number }> = {
  desktop: { url: "atlas-desktop.png", w: 900, h: 2807 },
  mobile: { url: "atlas-mobile.png", w: 900, h: 3287 },
};

/** Where our copies of those sheets are served from (see the file header). */
const ASSETS_BASE = "/shards";

const ATLAS_RECTS: Record<SetKey, Record<string, [number, number, number, number]>> = {
  desktop: {
    "desktop-01a": [2, 2, 274, 647],
    "desktop-01b": [278, 2, 109, 468],
    "desktop-02a": [478, 651, 277, 355],
    "desktop-02b": [2, 1057, 560, 351],
    "desktop-02c": [2, 2240, 351, 230],
    "desktop-03a": [389, 2, 508, 467],
    "desktop-03b": [482, 2691, 276, 103],
    "desktop-03c": [2, 651, 474, 404],
    "desktop-04a": [2, 1410, 453, 320],
    "desktop-04b": [2, 1732, 606, 265],
    "desktop-05a": [584, 2472, 251, 164],
    "desktop-05b": [2, 1999, 614, 239],
    "desktop-06a": [2, 2472, 580, 217],
    "desktop-06b": [2, 2691, 478, 114],
    "desktop-07a": [457, 1410, 215, 306],
    "desktop-07b": [355, 2240, 189, 222],
  },
  mobile: {
    "mobile-01a": [523, 1496, 338, 412],
    "mobile-01b": [2, 1911, 514, 359],
    "mobile-01c": [468, 3091, 111, 99],
    "mobile-02a": [2, 2, 314, 629],
    "mobile-02b": [2, 633, 417, 443],
    "mobile-03a": [412, 2622, 301, 243],
    "mobile-03b": [2, 1496, 519, 413],
    "mobile-04a": [2, 1078, 572, 416],
    "mobile-04b": [2, 2873, 481, 216],
    "mobile-04c": [2, 2622, 408, 249],
    "mobile-05a": [541, 2272, 251, 267],
    "mobile-05b": [318, 2, 295, 519],
    "mobile-06a": [615, 2, 226, 450],
    "mobile-06b": [416, 2272, 123, 334],
    "mobile-07a": [2, 3091, 464, 194],
    "mobile-07b": [2, 2272, 412, 348],
  },
};

/**
 * Classic responsive-sprite math: background-size/position expressed as a %
 * of the ELEMENT, so the crop stays exact at any render size without
 * knowing actual pixel dimensions up front.
 */
export function spriteStyle(setKey: SetKey, id: string): { backgroundSize: string; backgroundPosition: string } {
  const sheet = ATLAS[setKey];
  const rect = ATLAS_RECTS[setKey][id];
  const sx = rect[0];
  const sy = rect[1];
  const fw = rect[2];
  const fh = rect[3];
  const sizeX = (sheet.w / fw) * 100;
  const sizeY = (sheet.h / fh) * 100;
  const posX = sheet.w > fw ? (sx / (sheet.w - fw)) * 100 : 0;
  const posY = sheet.h > fh ? (sy / (sheet.h - fh)) * 100 : 0;
  return {
    backgroundSize: `${sizeX.toFixed(3)}% ${sizeY.toFixed(3)}%`,
    backgroundPosition: `${posX.toFixed(3)}% ${posY.toFixed(3)}%`,
  };
}

export function atlasUrl(setKey: SetKey): string {
  return `${ASSETS_BASE}/${ATLAS[setKey].url}`;
}

/** The full mask/background style set for one shard's sprite — used by every surface that draws a fragment. */
export function shardSpriteStyle(setKey: SetKey, id: string): Record<string, string> {
  const url = atlasUrl(setKey);
  const sprite = spriteStyle(setKey, id);
  return {
    WebkitMaskImage: `url(${url})`,
    maskImage: `url(${url})`,
    WebkitMaskSize: sprite.backgroundSize,
    maskSize: sprite.backgroundSize,
    WebkitMaskPosition: sprite.backgroundPosition,
    maskPosition: sprite.backgroundPosition,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

/**
 * Crack polylines traced from the medial axis of the gaps between the real
 * pieces — main channels plus fine secondary branches. Drawn through the
 * void so the empty space between fragments reads as fracture rather than
 * as margin.
 */
export const CRACKS: Record<SetKey, { w: number; h: number; main: string[]; fine: string[] }> = {
  desktop: {
    w: 1774,
    h: 887,
    main: ["M1616 807L1432 812L1402 805L1397 797L1385 790", "M769 404L812 402L1359 327L1381 321", "M1381 321L1390 300L1443 241L1467 231", "M1381 321L1386 326L1410 329L1435 338", "M695 402L701 391L724 374L747 365", "M656 484L629 473L611 455L604 434", "M1436 339L1436 379L1428 438L1404 489", "M1122 817L1135 817", "M832 590L835 587L854 586L895 587", "M657 484L660 481L664 443L670 430", "M696 403L706 403L708 408", "M75 501L89 329L102 318L124 310L136 298", "M1318 543L1321 583", "M110 765L78 711", "M918 817L1014 817", "M62 661L66 629", "M852 646L846 640L832 591", "M129 61L814 67L842 90", "M173 805L720 807L735 803L756 778L777 770", "M819 816L809 814L789 801L783 775L778 770", "M1174 818L1331 818", "M853 646L870 639L888 615L895 588", "M834 816L877 816", "M1667 796L1681 773L1688 750", "M748 365L762 385L768 403", "M1436 338L1442 331L1467 265L1470 237", "M94 267L87 239L92 100", "M1320 584L1283 582L1274 573", "M1403 490L1358 504L1331 525L1318 542", "M1689 749L1716 741L1729 732", "M1273 572L910 581L896 587", "M1274 571L1293 550L1317 543", "M696 420L763 409L768 404", "M1673 115L1674 131", "M1621 806L1640 806", "M75 503L66 597L66 628", "M1508 127L1500 119L1497 105L1487 86L1480 79L1465 75L1286 69L884 64L867 68L853 84L842 90", "M1508 127L1527 115L1541 80L1556 63L1579 56L1633 54", "M1508 127L1502 152L1468 230", "M778 769L781 757L843 671L852 647", "M1675 133L1736 671", "M1404 490L1434 526L1688 749", "M1384 789L1380 759L1321 585", "M604 433L608 429L664 429", "M1383 790L1370 806L1341 818", "M842 90L835 131L753 337L748 364", "M95 268L112 280L125 284L136 298", "M831 590L819 587L685 518L664 502L657 485", "M688 418L694 403", "M136 298L494 342L510 351L603 433", "M687 419L670 430"],
    fine: ["M82 502L76 502", "M1468 231L1469 236", "M1653 60L1665 71", "M94 268L88 272", "M1671 98L1671 103", "M63 685L66 691", "M1039 817L1029 817", "M664 430L652 442", "M1457 249L1468 237", "M696 418L705 409", "M665 430L670 430", "M93 97L93 93", "M1737 680L1737 675", "M1672 111L1672 106", "M61 666L61 674", "M688 419L695 419", "M1670 89L1670 93", "M117 777L111 767", "M1738 689L1738 684", "M93 85L93 89", "M1739 697L1739 692"],
  },
  mobile: {
    w: 853,
    h: 1844,
    main: ["M579 81L594 81", "M609 1745L596 1754L570 1762", "M610 1744L605 1710L518 1517L505 1465", "M489 691L508 709L684 822L725 835", "M576 82L561 82", "M265 925L272 965", "M751 1230L763 1210L767 1195L769 1121L766 1102L748 1079L742 1059", "M162 106L147 106", "M491 626L501 636L509 634", "M750 1231L725 1236L691 1257L527 1455L505 1465", "M527 84L541 84", "M75 165L72 285L78 313L87 322L93 336", "M528 638L570 492L591 482L605 448L717 314L734 303L748 299", "M164 105L508 86", "M524 85L510 85", "M769 1256L764 1242L751 1231", "M596 80L609 80", "M742 1058L767 1043L778 1008", "M787 251L770 615L755 787L748 812L726 835", "M611 80L625 79", "M748 1547L742 1623", "M513 521L508 562L494 588", "M769 1258L772 1272", "M423 694L428 663L448 610L468 595L493 589", "M773 120L775 177L767 212", "M709 782L714 773L754 306L750 299", "M424 695L488 691", "M218 956L228 937L240 930L264 925", "M544 83L559 83", "M423 696L415 709L363 849L349 862L279 903L270 912L265 924", "M488 490L470 486L459 479L362 389L124 339L94 337", "M130 1273L172 1276L370 1316L471 1446L482 1456L505 1465", "M217 957L184 967L143 994L127 998", "M489 491L499 512L513 520", "M514 520L525 509L527 480", "M490 626L484 648L488 690", "M379 1762L188 1762", "M127 998L121 992L104 990L84 975L80 961L66 401", "M127 998L119 1018L84 1043L78 1082L89 1233L106 1256L122 1263L129 1272", "M527 659L528 639", "M494 589L490 625", "M741 1058L273 966", "M778 988L776 897L768 872", "M708 782L687 777L532 677L527 660", "M527 480L549 450L740 227L749 219L767 212", "M527 480L498 484L490 490", "M767 871L734 851L726 836", "M218 957L228 964L259 968L271 966", "M70 412L70 402L66 401", "M527 638L510 634", "M611 1745L627 1753L654 1760L694 1761", "M84 1703L92 1326L96 1310L106 1297L122 1285L129 1273", "M93 338L76 353L65 386", "M749 298L761 263L759 252L763 242", "M767 212L780 225L787 245"],
    fine: ["M761 1403L761 1411", "M703 74L711 74", "M741 1635L741 1625", "M772 1287L772 1283", "M65 390L66 401", "M695 75L683 75", "M759 1426L759 1434", "M753 1492L753 1501", "M737 1679L737 1673", "M758 1445L758 1437", "M765 1359L765 1367", "M738 1668L738 1661", "M763 1389L763 1381", "M768 1333L768 1329", "M749 1536L749 1545", "M735 1702L735 1696", "M723 1746L719 1750", "M630 78L640 78", "M754 1489L754 1481", "M659 77L648 77", "M769 1322L769 1317", "M760 1422L760 1415", "M752 1503L752 1512", "M766 1355L766 1350", "M389 1762L384 1762", "M733 1715L733 1724", "M755 1471L755 1478", "M771 1299L771 1294", "M665 76L672 76", "M132 107L137 107", "M514 657L526 660", "M751 1515L751 1523", "M509 633L512 622", "M760 96L753 92", "M756 1459L756 1467", "M764 1378L764 1370", "M767 1340L767 1344", "M750 1534L750 1526", "M710 787L709 783", "M736 1690L736 1682", "M762 1400L762 1393", "M91 1738L100 1747", "M734 1704L734 1713", "M770 1306L770 1310", "M740 1637L740 1646", "M739 1648L739 1657", "M757 1456L757 1449"],
  },
};

/** One fragment's live 3D pose. The spring loop interpolates current toward target every frame. */
export interface SpringState {
  rx: number;
  ry: number;
  tz: number;
  px: number;
  py: number;
  sc: number;
}

/** A couple of pieces rest slightly lifted, so the pane reads as 3D even in a static frame. */
const BASE_POSE: Record<string, Partial<SpringState>> = {
  "desktop-05a": { rx: 3.2, ry: -4.6, tz: 22 },
  "desktop-07b": { rx: -2.4, ry: 3.8, tz: 14 },
  "mobile-07a": { rx: 2.8, ry: -3.6, tz: 18 },
  "mobile-01b": { rx: -2, ry: 2.6, tz: 10 },
};

/** Deterministic hash in [0,1) — the same one the source component used, so poses and jitter land identically. */
function rand(seed: number, n: number, a: number, b: number): number {
  const s = Math.sin(seed * a + n * b) * 43758.5453;
  return s - Math.floor(s);
}

/** Deterministic per-shard jitter: the word reads as one line but sits visibly fractured across the pane. */
export function jitter(seed: number): { tx: number; ty: number; rot: number } {
  return {
    tx: (rand(seed, 1, 127.1, 311.7) - 0.5) * 14,
    ty: (rand(seed, 2, 127.1, 311.7) - 0.5) * 10,
    rot: (rand(seed, 3, 127.1, 311.7) - 0.5) * 2.4,
  };
}

/**
 * Every fragment rests at its own slight depth and tilt — the pane reads as
 * truly come apart, not laid flat. Two hero pieces per set get stronger
 * poses on top (BASE_POSE).
 */
export function baseOf(id: string, seed: number): SpringState {
  return {
    rx: (rand(seed, 1, 91.7, 269.5) - 0.5) * 3.4,
    ry: (rand(seed, 2, 91.7, 269.5) - 0.5) * 4.2,
    tz: rand(seed, 3, 91.7, 269.5) * 16,
    px: 0,
    py: 0,
    sc: 1,
    ...BASE_POSE[id],
  };
}

export function toTransform(s: SpringState): string {
  return (
    `translate3d(${s.px.toFixed(2)}px, ${s.py.toFixed(2)}px, ${s.tz.toFixed(2)}px)` +
    ` rotateX(${s.rx.toFixed(2)}deg) rotateY(${s.ry.toFixed(2)}deg)` +
    ` scale(${s.sc.toFixed(4)})`
  );
}

/** Preloads the sheets a surface needs, resolving on decode or on a 2.5s timeout so a slow network still renders something. */
export function preloadAtlas(setKey: SetKey): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_500);
    const img = new Image();
    const done = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    img.src = atlasUrl(setKey);
  });
}
