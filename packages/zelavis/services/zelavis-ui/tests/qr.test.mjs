import assert from "node:assert/strict";
import test from "node:test";
import { qrMatrix, qrMaxBytes } from "../app/qr.ts";

const setupUri = "otpauth://totp/Zelavis:alice?secret=JBSWY3DPEHPK3PXP&issuer=Zelavis";

// Reference reader for the version 5-M fixture. Its two data blocks are
// 43 bytes each, followed by interleaved Reed-Solomon correction words.
function readVersion5(matrix) {
  const size = 37;
  assert.equal(matrix.length, size);
  const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  for (const [left, top] of [[0, 0], [30, 0], [0, 30]]) {
    assert.deepEqual(matrix.slice(top, top + 7).map(row => [...row.slice(left, left + 7)].join("")), finder);
  }
  const formatCells = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const format = formatCells.reduce((value, [x, y], index) => value + (matrix[y][x] << index), 0);
  assert.equal(format, 0x5412, "correction level M, mask 0");
  assert.equal(matrix[29][8], 1, "fixed dark module");

  const functional = (x, y) => (x < 9 && (y < 9 || y >= 29)) ||
    (x >= 29 && y < 9) || x === 6 || y === 6 ||
    (x >= 28 && x <= 32 && y >= 28 && y <= 32);
  const bits = [];
  const columns = [36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 5, 3, 1];
  for (const [index, column] of columns.entries()) {
    const rowOrder = Array.from({ length: size }, (_, y) => index % 2 ? y : size - 1 - y);
    for (const y of rowOrder) for (const x of [column, column - 1]) {
      if (!functional(x, y)) bits.push(matrix[y][x] ^ ((x + y + 1) % 2));
    }
  }
  assert.equal(bits.length, 134 * 8 + 7);
  const interleaved = Array.from({ length: 86 }, (_, i) => Number.parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));
  const data = [0, 1].flatMap(block => interleaved.filter((_, i) => i % 2 === block));
  const payload = data.map(byte => byte.toString(2).padStart(8, "0")).join("");
  assert.equal(payload.slice(0, 4), "0100");
  const length = Number.parseInt(payload.slice(4, 12), 2);
  return new TextDecoder().decode(Uint8Array.from({ length }, (_, i) =>
    Number.parseInt(payload.slice(12 + i * 8, 20 + i * 8), 2)));
}

test("encodes an authenticator URI with readable format, finder patterns and payload", () => {
  assert.equal(readVersion5(qrMatrix(setupUri)), setupUri);
});

test("chooses the smallest version that fits the encoded byte count through version 10", () => {
  const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  capacities.forEach((max, index) => {
    assert.equal(qrMatrix("x".repeat(max)).length, 21 + index * 4);
    if (index + 1 < capacities.length) assert.equal(qrMatrix("x".repeat(max + 1)).length, 25 + index * 4);
  });
  assert.equal(qrMatrix("é".repeat(8)).length, 25);
  assert.throws(() => qrMatrix("x".repeat(qrMaxBytes + 1)), RangeError);
});
