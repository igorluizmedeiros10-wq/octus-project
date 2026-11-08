'use strict';

/**
 * Escritor ZIP mínimo (sem dependências) para exportação de projetos.
 * Suporta deflate e store, com CRC-32 correto e diretório central completo.
 */

const zlib = require('node:zlib');

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buffer) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time: time & 0xffff, date: day & 0xffff };
}

function localHeader({ name, crc, compressedSize, size, method, time, date, flags }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(Buffer.byteLength(name, 'utf8'), 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader({ name, crc, compressedSize, size, method, time, date, flags, offset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(Buffer.byteLength(name, 'utf8'), 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

/**
 * @param {Array<{path: string, data: Buffer|string}>} entries
 * @param {{compress?: boolean, date?: Date}} options
 * @returns {Buffer}
 */
function createZip(entries, { compress = true, date = new Date() } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Nenhum arquivo para exportar.');
  const { time, date: dosDate } = dosDateTime(date);
  const flags = 0x0800; // nomes em UTF-8
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.path || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Caminho inválido no pacote: ${name}`);
    }
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const deflated = compress ? zlib.deflateRawSync(raw) : raw;
    const useDeflate = compress && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuffer = Buffer.from(name, 'utf8');

    const local = localHeader({
      name,
      crc,
      compressedSize: payload.length,
      size: raw.length,
      method,
      time,
      date: dosDate,
      flags,
    });
    locals.push(local, nameBuffer, payload);

    centrals.push(
      centralHeader({
        name,
        crc,
        compressedSize: payload.length,
        size: raw.length,
        method,
        time,
        date: dosDate,
        flags,
        offset,
      }),
      nameBuffer,
    );

    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

module.exports = { createZip, crc32 };
