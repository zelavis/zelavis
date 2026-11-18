// QR Model 2, byte mode, error correction M. The table lists total words,
// correction words per block, block count, and alignment centers per version.
const versions = [
  [26, 10, 1, []],
  [44, 16, 1, [6, 18]],
  [70, 26, 1, [6, 22]],
  [100, 18, 2, [6, 26]],
  [134, 24, 2, [6, 30]],
  [172, 16, 4, [6, 34]],
  [196, 18, 4, [6, 22, 38]],
  [242, 22, 4, [6, 24, 42]],
  [292, 22, 5, [6, 26, 46]],
  [346, 26, 5, [6, 28, 50]],
] as const;

export const qrMaxBytes = 213;
const countBits = (version: number) => version < 10 ? 8 : 16;
const bit = (value: number, index: number) => (value >>> index) & 1;

function multiply(x: number, y: number): number {
  let product = 0;
  for (let i = 7; i >= 0; i--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= bit(y, i) * x;
  }
  return product;
}

function generator(degree: number): Uint8Array {
  const polynomial = new Uint8Array(degree);
  polynomial[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      polynomial[j] = multiply(polynomial[j], root) ^ (polynomial[j + 1] ?? 0);
    }
    root = multiply(root, 2);
  }
  return polynomial;
}

function correction(data: Uint8Array, polynomial: Uint8Array): Uint8Array {
  const remainder = new Uint8Array(polynomial.length);
  for (const word of data) {
    const factor = word ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[remainder.length - 1] = 0;
    for (let i = 0; i < polynomial.length; i++) remainder[i] ^= multiply(polynomial[i], factor);
  }
  return remainder;
}

function codewords(bytes: Uint8Array, version: number): number[] {
  const [total, degree, blocks] = versions[version - 1];
  const capacity = total - degree * blocks;
  const data = new Uint8Array(capacity);
  let offset = 0;
  const write = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--, offset++) data[offset >>> 3] |= bit(value, i) << (7 - (offset % 8));
  };
  write(4, 4);
  write(bytes.length, countBits(version));
  for (const byte of bytes) write(byte, 8);
  // The array's zeroes supply the terminator and fill to a byte boundary.
  const padded = Math.ceil((offset + Math.min(4, capacity * 8 - offset)) / 8);
  for (let i = padded; i < capacity; i++) data[i] = (i - padded) % 2 === 0 ? 0xec : 0x11;

  const shortLength = Math.floor(capacity / blocks);
  const shortCount = blocks - capacity % blocks;
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < blocks; i++) {
    const end = start + shortLength + Number(i >= shortCount);
    chunks.push(data.subarray(start, end));
    start = end;
  }
  const polynomial = generator(degree);
  const normal: number[] = [];
  const interleave = (words: readonly Uint8Array[], length: number) => {
    for (let i = 0; i < length; i++) for (const block of words) {
      if (i < block.length) normal.push(block[i]);
    }
  };
  interleave(chunks, chunks.at(-1)!.length);
  interleave(chunks.map(chunk => correction(chunk, polynomial)), degree);
  return normal;
}

function bch(value: number, length: number, polynomial: number): number {
  let remainder = value << length;
  for (let i = 31 - Math.clz32(remainder); i >= length; i--) {
    if (bit(remainder, i)) remainder ^= polynomial << (i - length);
  }
  return (value << length) | remainder;
}

export function qrMatrix(text: string): ReadonlyArray<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const index = versions.findIndex(([total, ecc, blocks], i) =>
    (total - ecc * blocks) * 8 >= 4 + countBits(i + 1) + bytes.length * 8);
  if (index === -1) throw new RangeError("This text is too long for a QR code.");
  const version = index + 1;
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const fixed = (x: number, y: number, dark: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    matrix[y][x] = dark;
    reserved[y][x] = 1;
  };
  for (let i = 0; i < size; i++) {
    fixed(6, i, 1 - i % 2);
    fixed(i, 6, 1 - i % 2);
  }
  for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      fixed(x + dx, y + dy, Number(distance !== 2 && distance !== 4));
    }
  }
  const centers: readonly number[] = versions[index][3];
  const last = centers.at(-1);
  for (const y of centers) for (const x of centers) {
    if ((x === 6 && (y === 6 || y === last)) || (x === last && y === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      fixed(x + dx, y + dy, Number(Math.max(Math.abs(dx), Math.abs(dy)) !== 1));
    }
  }

  // Format information for error correction M and mask 0, in both copies.
  const format = bch(0, 10, 0x537) ^ 0x5412;
  for (let i = 0; i < 6; i++) fixed(8, i, bit(format, i));
  fixed(8, 7, bit(format, 6));
  fixed(8, 8, bit(format, 7));
  fixed(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) fixed(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) fixed(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) fixed(8, size - 15 + i, bit(format, i));
  fixed(8, size - 8, 1);

  if (version >= 7) {
    const bits = bch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const x = size - 11 + i % 3;
      const y = Math.floor(i / 3);
      fixed(x, y, bit(bits, i));
      fixed(y, x, bit(bits, i));
    }
  }

  const words = codewords(bytes, version);
  let cursor = 0;
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const y = up ? size - 1 - i : i;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        const value = bit(words[cursor >>> 3] ?? 0, 7 - cursor % 8);
        matrix[y][x] = value ^ Number((x + y) % 2 === 0);
        cursor++;
      }
    }
  }
  return matrix;
}

export function qrSvg(text: string): SVGElement {
  const matrix = qrMatrix(text);
  const quietZone = 4;
  const size = matrix.length + quietZone * 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "account-qr");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "224");
  svg.setAttribute("height", "224");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Authenticator setup QR code");
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#fff");
  const modules = document.createElementNS(ns, "path");
  const path: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`);
  }));
  modules.setAttribute("d", path.join(""));
  modules.setAttribute("fill", "#000");
  svg.append(background, modules);
  return svg;
}
