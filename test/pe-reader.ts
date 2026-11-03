import { readFileSync } from 'node:fs';

/** Just enough of the PE format to read what a built .node asks Windows for. */

export interface PeFacts {
  /** DLLs in the import table, lowercase. Delay-loaded ones too. */
  imports: string[];
  /** IMAGE_LOAD_CONFIG_DIRECTORY64.DependentLoadFlags. */
  dependentLoadFlags: number | null;
}

export function readPe(file: string): PeFacts {
  const data = readFileSync(file);
  const pe = data.readUInt32LE(0x3c);
  if (data.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const sectionCount = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (data.readUInt16LE(optional) !== 0x20b) throw new Error('not PE32+');
  const directory = (index: number) => ({ rva: data.readUInt32LE(optional + 112 + index * 8), size: data.readUInt32LE(optional + 116 + index * 8) });

  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return { virtual: data.readUInt32LE(at + 12), size: Math.max(data.readUInt32LE(at + 8), data.readUInt32LE(at + 16)), raw: data.readUInt32LE(at + 20) };
  });
  const offset = (rva: number) => {
    const section = sections.find((candidate) => rva >= candidate.virtual && rva < candidate.virtual + candidate.size);
    if (!section) throw new Error(`rva ${rva} is in no section`);
    return rva - section.virtual + section.raw;
  };
  const text = (rva: number) => {
    const start = offset(rva);
    return data.toString('latin1', start, data.indexOf(0, start)).toLowerCase();
  };

  const imports: string[] = [];
  const table = directory(1);
  if (table.rva) {
    for (let at = offset(table.rva); data.readUInt32LE(at + 12) !== 0; at += 20) imports.push(text(data.readUInt32LE(at + 12)));
  }
  const delayed = directory(13);
  if (delayed.rva) {
    for (let at = offset(delayed.rva); data.readUInt32LE(at + 4) !== 0; at += 32) imports.push(text(data.readUInt32LE(at + 4)));
  }

  const config = directory(10);
  let dependentLoadFlags: number | null = null;
  if (config.rva) {
    const at = offset(config.rva);
    dependentLoadFlags = data.readUInt32LE(at) >= 80 ? data.readUInt16LE(at + 78) : null;
  }
  return { imports: [...new Set(imports)].sort(), dependentLoadFlags };
}
