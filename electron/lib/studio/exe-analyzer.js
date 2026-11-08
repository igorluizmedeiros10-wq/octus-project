'use strict';

/**
 * Analisador de executáveis: interpreta PE (Windows) e ELF (Linux) reais,
 * extraindo cabeçalhos, seções, bibliotecas importadas, exportações, hashes,
 * entropia e strings. Uso restrito a arquivos próprios ou autorizados.
 */

const crypto = require('node:crypto');

class AnalysisError extends Error {
  constructor(message, code = 'analysis_error') {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
  }
}

const MACHINE_NAMES = {
  0x014c: 'x86 (32-bit)',
  0x8664: 'x64 (AMD64)',
  0x01c0: 'ARM',
  0xaa64: 'ARM64',
  0x0200: 'IA64',
};

const SUBSYSTEM_NAMES = {
  1: 'Native',
  2: 'Windows GUI',
  3: 'Windows Console',
  5: 'OS/2 Console',
  7: 'POSIX Console',
  9: 'Windows CE',
  10: 'EFI Application',
  16: 'Windows Boot Application',
};

const ELF_MACHINE_NAMES = {
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  40: 'ARM',
  62: 'x86-64',
  183: 'ARM64',
  243: 'RISC-V',
};

const ELF_TYPE_NAMES = { 1: 'Relocatable', 2: 'Executable', 3: 'Shared object', 4: 'Core' };

function readUInt(buffer, offset, size, littleEndian = true) {
  if (offset < 0 || offset + size > buffer.length) return null;
  try {
    if (size === 8) {
      const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
      return Number(value);
    }
    if (size === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (size === 2) return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    return buffer[offset];
  } catch {
    return null;
  }
}

function cString(buffer, offset, max = 512) {
  if (offset < 0 || offset >= buffer.length) return '';
  const end = Math.min(buffer.length, offset + max);
  let value = '';
  for (let i = offset; i < end; i += 1) {
    const byte = buffer[i];
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) return value;
    value += String.fromCharCode(byte);
  }
  return value;
}

function sectionCharacteristics(flags) {
  const list = [];
  if (flags & 0x20000000) list.push('Executável');
  if (flags & 0x40000000) list.push('Leitura');
  if (flags & 0x80000000) list.push('Escrita');
  if (flags & 0x00000020) list.push('Código');
  if (flags & 0x00000040) list.push('Dados inicializados');
  if (flags & 0x00000080) list.push('Dados não inicializados');
  if (flags & 0x02000000) list.push('Descartável');
  return list;
}

function entropy(buffer) {
  if (!buffer.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte] += 1;
  let value = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / buffer.length;
    value -= probability * Math.log2(probability);
  }
  return Math.round(value * 1000) / 1000;
}

function hashes(buffer) {
  return {
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sha1: crypto.createHash('sha1').update(buffer).digest('hex'),
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
    entropy: entropy(buffer),
  };
}

function detectFormat(buffer) {
  if (buffer.length < 4) return 'desconhecido';
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'PE (Windows)';
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return 'ELF (Linux/Unix)';
  if (buffer.readUInt32BE(0) === 0xfeedface || buffer.readUInt32BE(0) === 0xfeedfacf) return 'Mach-O (macOS)';
  if (buffer.readUInt32LE(0) === 0xfeedface || buffer.readUInt32LE(0) === 0xfeedfacf) return 'Mach-O (macOS)';
  if (buffer[0] === 0x23 && buffer[1] === 0x21) return 'Script (shebang)';
  return 'desconhecido';
}

/* ------------------------------------------------------------------ PE ---- */

function parsePE(buffer) {
  const e_lfanew = readUInt(buffer, 0x3c, 4, true);
  if (e_lfanew === null || e_lfanew <= 0 || e_lfanew + 24 > buffer.length) {
    throw new AnalysisError('Cabeçalho PE inválido (e_lfanew fora dos limites).', 'invalid_pe');
  }
  if (buffer.toString('latin1', e_lfanew, e_lfanew + 4) !== 'PE\u0000\u0000') {
    throw new AnalysisError('Assinatura PE ausente.', 'invalid_pe');
  }

  const coffOffset = e_lfanew + 4;
  const machine = readUInt(buffer, coffOffset, 2);
  const numberOfSections = readUInt(buffer, coffOffset + 2, 2);
  const timeDateStamp = readUInt(buffer, coffOffset + 4, 4);
  const sizeOfOptionalHeader = readUInt(buffer, coffOffset + 16, 2);
  const characteristics = readUInt(buffer, coffOffset + 18, 2);

  const optionalOffset = coffOffset + 20;
  const magic = readUInt(buffer, optionalOffset, 2);
  const is64 = magic === 0x20b;
  const entryPoint = readUInt(buffer, optionalOffset + 16, 4);
  const imageBase = is64 ? readUInt(buffer, optionalOffset + 24, 8) : readUInt(buffer, optionalOffset + 28, 4);
  const sectionAlignment = readUInt(buffer, optionalOffset + 32, 4);
  const fileAlignment = readUInt(buffer, optionalOffset + 36, 4);
  const sizeOfImage = readUInt(buffer, optionalOffset + 56, 4);
  const checksum = readUInt(buffer, optionalOffset + 64, 4);
  const subsystem = readUInt(buffer, optionalOffset + 68, 2);
  const dllCharacteristics = readUInt(buffer, optionalOffset + 70, 2);
  const numberOfRvaAndSizes = readUInt(buffer, optionalOffset + (is64 ? 108 : 92), 4);
  const directoriesOffset = optionalOffset + (is64 ? 112 : 96);

  const directories = [];
  const directoryCount = Math.min(numberOfRvaAndSizes || 0, 16);
  for (let index = 0; index < directoryCount; index += 1) {
    const rva = readUInt(buffer, directoriesOffset + index * 8, 4);
    const size = readUInt(buffer, directoriesOffset + index * 8 + 4, 4);
    directories.push({ index, rva, size });
  }

  const sections = [];
  const sectionsOffset = optionalOffset + sizeOfOptionalHeader;
  for (let index = 0; index < (numberOfSections || 0); index += 1) {
    const base = sectionsOffset + index * 40;
    if (base + 40 > buffer.length) break;
    const name = buffer.toString('latin1', base, base + 8).replace(/\u0000+$/, '');
    const virtualSize = readUInt(buffer, base + 8, 4);
    const virtualAddress = readUInt(buffer, base + 12, 4);
    const sizeOfRawData = readUInt(buffer, base + 16, 4);
    const pointerToRawData = readUInt(buffer, base + 20, 4);
    const flags = readUInt(buffer, base + 36, 4);
    const raw = sizeOfRawData > 0 ? buffer.subarray(pointerToRawData, Math.min(buffer.length, pointerToRawData + sizeOfRawData)) : Buffer.alloc(0);
    sections.push({
      name,
      virtualAddress,
      virtualSize,
      rawSize: sizeOfRawData,
      rawPointer: pointerToRawData,
      characteristics: `0x${(flags || 0).toString(16).padStart(8, '0')}`,
      permissions: sectionCharacteristics(flags || 0),
      entropy: entropy(raw),
    });
  }

  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return section.rawPointer + (rva - section.virtualAddress);
      }
    }
    return null;
  };

  const directory = (index) => directories.find((entry) => entry.index === index) || { rva: 0, size: 0 };

  // Importações reais (DLLs + funções).
  const imports = [];
  const importDir = directory(1);
  if (importDir.rva) {
    let descriptorOffset = rvaToOffset(importDir.rva);
    for (let guard = 0; guard < 512 && descriptorOffset !== null; guard += 1) {
      const base = descriptorOffset + guard * 20;
      if (base + 20 > buffer.length) break;
      const originalFirstThunk = readUInt(buffer, base, 4);
      const nameRva = readUInt(buffer, base + 12, 4);
      const firstThunk = readUInt(buffer, base + 16, 4);
      if (!nameRva) break;
      const nameOffset = rvaToOffset(nameRva);
      const dll = nameOffset === null ? '' : cString(buffer, nameOffset, 128);
      const functions = [];
      const thunkRva = originalFirstThunk || firstThunk;
      let thunkOffset = thunkRva ? rvaToOffset(thunkRva) : null;
      for (let index = 0; thunkOffset !== null && index < 4096; index += 1) {
        const value = readUInt(buffer, thunkOffset + index * (is64 ? 8 : 4), is64 ? 8 : 4);
        if (value === null || value === 0) break;
        const ordinalFlag = is64 ? 0x8000000000000000 : 0x80000000;
        if (value & ordinalFlag) {
          functions.push(`#${value & 0xffff}`);
          continue;
        }
        const hintOffset = rvaToOffset(value);
        if (hintOffset === null) break;
        const functionName = cString(buffer, hintOffset + 2, 128);
        if (functionName) functions.push(functionName);
      }
      if (dll) imports.push({ dll, functions: functions.slice(0, 200), functionCount: functions.length });
    }
  }

  // Exportações.
  const exports = [];
  const exportDir = directory(0);
  if (exportDir.rva) {
    const offset = rvaToOffset(exportDir.rva);
    if (offset !== null) {
      const numberOfNames = readUInt(buffer, offset + 24, 4);
      const namesRva = readUInt(buffer, offset + 32, 4);
      const namesOffset = namesRva ? rvaToOffset(namesRva) : null;
      for (let index = 0; namesOffset !== null && index < Math.min(numberOfNames || 0, 512); index += 1) {
        const nameRva = readUInt(buffer, namesOffset + index * 4, 4);
        const nameOffset = nameRva ? rvaToOffset(nameRva) : null;
        const name = nameOffset === null ? '' : cString(buffer, nameOffset, 200);
        if (name) exports.push(name);
      }
    }
  }

  const securityDir = directory(4);
  const debugDir = directory(6);
  const relocDir = directory(5);
  const comDescriptor = directory(14);

  const dosStub = buffer.subarray(0, Math.max(0, e_lfanew));
  const richHeader = dosStub.includes(Buffer.from('Rich'));

  // Overlay: dados após a última seção.
  const lastSectionEnd = sections.reduce((max, section) => Math.max(max, section.rawPointer + section.rawSize), 0);
  const overlaySize = Math.max(0, buffer.length - lastSectionEnd);

  const timestamp = timeDateStamp ? new Date(timeDateStamp * 1000) : null;

  return {
    format: 'PE',
    architecture: MACHINE_NAMES[machine] || `desconhecida (0x${(machine || 0).toString(16)})`,
    bitness: is64 ? '64-bit' : '32-bit',
    subsystem: SUBSYSTEM_NAMES[subsystem] || `desconhecido (${subsystem})`,
    entryPoint: `0x${(entryPoint || 0).toString(16)}`,
    imageBase: `0x${(imageBase || 0).toString(16)}`,
    sizeOfImage,
    sectionAlignment,
    fileAlignment,
    checksum: `0x${(checksum || 0).toString(16)}`,
    characteristics: {
      dll: Boolean(characteristics & 0x2000),
      executable: Boolean(characteristics & 0x0002),
      largeAddressAware: Boolean(characteristics & 0x0020),
      aslr: Boolean(dllCharacteristics & 0x0040),
      dep: Boolean(dllCharacteristics & 0x0100),
      controlFlowGuard: Boolean(dllCharacteristics & 0x4000),
      highEntropyVA: Boolean(dllCharacteristics & 0x0020),
    },
    compiledAt: timestamp ? timestamp.toISOString() : null,
    sections,
    imports,
    exports,
    security: {
      signed: securityDir.size > 0,
      certificateSize: securityDir.size || 0,
      hasDebugInfo: Boolean(debugDir.size),
      relocations: Boolean(relocDir.size),
      dotnet: Boolean(comDescriptor.size),
      richHeader,
      overlaySize,
    },
  };
}

/* ----------------------------------------------------------------- ELF ---- */

function parseELF(buffer) {
  const elfClass = buffer[4];
  const dataEncoding = buffer[5];
  const littleEndian = dataEncoding === 1;
  const is64 = elfClass === 2;

  const type = readUInt(buffer, 16, 2, littleEndian);
  const machine = readUInt(buffer, 18, 2, littleEndian);
  const entry = readUInt(buffer, 24, is64 ? 8 : 4, littleEndian);

  const sectionHeaderOffset = is64
    ? readUInt(buffer, 40, 8, littleEndian)
    : readUInt(buffer, 32, 4, littleEndian);
  const sectionEntrySize = readUInt(buffer, is64 ? 58 : 46, 2, littleEndian);
  const sectionCount = readUInt(buffer, is64 ? 60 : 48, 2, littleEndian);
  const stringTableIndex = readUInt(buffer, is64 ? 62 : 50, 2, littleEndian);

  const sections = [];
  const readSection = (index) => {
    const base = sectionHeaderOffset + index * sectionEntrySize;
    return {
      nameOffset: readUInt(buffer, base, 4, littleEndian),
      type: readUInt(buffer, base + 4, 4, littleEndian),
      offset: is64 ? readUInt(buffer, base + 24, 8, littleEndian) : readUInt(buffer, base + 16, 4, littleEndian),
      size: is64 ? readUInt(buffer, base + 32, 8, littleEndian) : readUInt(buffer, base + 20, 4, littleEndian),
      entrySize: is64 ? readUInt(buffer, base + 56, 8, littleEndian) : readUInt(buffer, base + 36, 4, littleEndian),
      link: readUInt(buffer, base + (is64 ? 40 : 24), 4, littleEndian),
    };
  };

  let stringTable = null;
  if (stringTableIndex && stringTableIndex < (sectionCount || 0)) {
    const stringSection = readSection(stringTableIndex);
    if (stringSection.offset !== null && stringSection.size) {
      stringTable = { offset: stringSection.offset };
    }
  }

  const sectionName = (offset) => (stringTable ? cString(buffer, stringTable.offset + offset, 64) : '');

  const libraries = [];
  for (let index = 0; index < Math.min(sectionCount || 0, 96); index += 1) {
    const section = readSection(index);
    const name = sectionName(section.nameOffset) || `section_${index}`;
    const raw = section.offset !== null && section.size ? buffer.subarray(section.offset, Math.min(buffer.length, section.offset + section.size)) : Buffer.alloc(0);
    sections.push({
      name,
      type: section.type,
      offset: section.offset,
      size: section.size,
      entropy: entropy(raw),
      flags: section.type === 1 ? 'PROGBITS' : section.type === 8 ? 'NOBITS' : `tipo ${section.type}`,
    });

    if (name === '.dynamic' && raw.length) {
      const entrySize = is64 ? 16 : 8;
      const dynamicStringSection = readSection(section.link || 0);
      const dynStringOffset = dynamicStringSection.offset || 0;
      for (let cursor = 0; cursor + entrySize <= raw.length; cursor += entrySize) {
        const tag = is64 ? Number(raw.readBigUInt64LE(cursor)) : raw.readUInt32LE(cursor);
        const value = is64 ? Number(raw.readBigUInt64LE(cursor + 8)) : raw.readUInt32LE(cursor + 4);
        if (tag === 0) break;
        if (tag === 1) {
          const library = cString(buffer, dynStringOffset + value, 128);
          if (library) libraries.push(library);
        }
      }
    }
  }

  const interp = sections.find((section) => section.name === '.interp');
  let interpreter = null;
  if (interp && interp.offset !== null) {
    interpreter = cString(buffer, interp.offset, 128);
  }

  return {
    format: 'ELF',
    architecture: ELF_MACHINE_NAMES[machine] || `desconhecida (${machine})`,
    bitness: is64 ? '64-bit' : '32-bit',
    endianness: littleEndian ? 'little-endian' : 'big-endian',
    type: ELF_TYPE_NAMES[type] || `tipo ${type}`,
    entryPoint: `0x${(entry || 0).toString(16)}`,
    interpreter,
    sections,
    libraries,
    security: {
      pie: type === 3,
      nx: sections.some((section) => section.name === '.note.GNU-stack'),
      relocations: sections.some((section) => /rela?\./.test(section.name)),
    },
  };
}

/* -------------------------------------------------------------- strings --- */

function extractStrings(buffer, { minLength = 5, limit = 400 } = {}) {
  const ascii = [];
  const unicode = [];
  let current = '';

  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) ascii.push(current);
      current = '';
      if (ascii.length >= limit) break;
    }
  }
  if (current.length >= minLength && ascii.length < limit) ascii.push(current);

  for (let index = 0; index + 1 < buffer.length && unicode.length < limit; index += 2) {
    let value = '';
    let cursor = index;
    while (cursor + 1 < buffer.length && buffer[cursor] >= 0x20 && buffer[cursor] <= 0x7e && buffer[cursor + 1] === 0) {
      value += String.fromCharCode(buffer[cursor]);
      cursor += 2;
    }
    if (value.length >= minLength) {
      unicode.push(value);
      index = cursor;
    }
  }

  return { ascii: ascii.slice(0, limit), unicode: unicode.slice(0, limit) };
}

/** Analisa um buffer de executável e devolve um relatório técnico estruturado. */
function analyzeBuffer(buffer, { filename = 'arquivo.bin' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new AnalysisError('Arquivo vazio ou pequeno demais para análise.', 'too_small');
  }
  const format = detectFormat(buffer);
  const report = {
    filename,
    format,
    hashes: hashes(buffer),
    strings: extractStrings(buffer),
    headers: null,
    libraries: [],
    warnings: [],
  };

  if (format === 'PE (Windows)') {
    const pe = parsePE(buffer);
    report.headers = pe;
    report.libraries = pe.imports.map((entry) => entry.dll);
    report.architecture = pe.architecture;
    report.bitness = pe.bitness;
    if (!pe.security.aslr) report.warnings.push('ASLR desativado (DYNAMIC_BASE ausente).');
    if (!pe.security.dep) report.warnings.push('DEP/NX desativado (NX_COMPAT ausente).');
    if (!pe.security.signed) report.warnings.push('Binário sem assinatura digital embutida.');
    if (pe.security.overlaySize > 0) report.warnings.push(`Possui ${pe.security.overlaySize} bytes de dados após as seções (overlay).`);
    const writableExecutable = pe.sections.filter(
      (section) => section.permissions.includes('Escrita') && section.permissions.includes('Executável'),
    );
    if (writableExecutable.length) {
      report.warnings.push(`Seções graváveis e executáveis: ${writableExecutable.map((s) => s.name).join(', ')}.`);
    }
    const packed = pe.sections.filter((section) => section.entropy > 7.2).map((section) => section.name);
    if (packed.length) report.warnings.push(`Alta entropia (possível packing/compressão): ${packed.join(', ')}.`);
  } else if (format === 'ELF (Linux/Unix)') {
    const elf = parseELF(buffer);
    report.headers = elf;
    report.libraries = elf.libraries;
    report.architecture = elf.architecture;
    report.bitness = elf.bitness;
    if (!elf.security.pie) report.warnings.push('Executável não é PIE (sem ASLR completo).');
  } else {
    report.warnings.push(`Formato ${format} não possui leitura estrutural detalhada; apenas hashes e strings foram extraídos.`);
  }

  return report;
}

module.exports = { analyzeBuffer, parsePE, parseELF, detectFormat, extractStrings, hashes, AnalysisError };
