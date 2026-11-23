// mend: one patch tool for every AI edit format (SPEC.md is the whole contract).
//
// Reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, JSON editor
// calls — finds the lines each edit names at the first of three matching tiers (exact, trailing
// whitespace ignored, all surrounding whitespace ignored), and writes every change or none.
// Node 22, standard library only. Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines of this
// file then hand over to runner.ts, which runs this CLI on each check in a fresh directory.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single stdout line it prints. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, dot or dot-dot segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * The tree as the edits leave it. `original` remembers each path's bytes before the patch (null:
 * absent), `now` holds the paths the edits have touched so far (null: deleted). Nothing reaches
 * the disk until every edit has run and none has failed.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit of a patch: apply it to the tree, recording any move it makes; throw Fail when it cannot. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

// ---------------------------------------------------------------- files as lines (section 3)

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, final: fin };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---------------------------------------------------------------- matching tiers (section 5)

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => trailWs(s.replace(/^[ \t]+/, ''));

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

function matchAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  if (pos < 0 || pos + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j += 1) if (!lineEq(lines[pos + j]!, o[j]!, tier)) return false;
  return true;
}

/** Every occurrence of O at or after `from`, at the first tier that has one; null when none has. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) if (matchAt(lines, i, o, tier)) positions.push(i);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old or new, and whether a `\` line follows it. */
interface Ent {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bs: boolean;
  emptyLine?: boolean;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * The lines that replace the match at `pos`: context lines are the file's own matched lines; at
 * tier 2 every other new line is re-indented from the old block's indent to the file's (section 5).
 */
function buildReplacement(fileLines: string[], pos: number, o: Ent[], n: Ent[], tier: number): string[] {
  const ctxAt: number[] = [];
  o.forEach((e, i) => {
    if (e.kind === 'ctx') ctxAt.push(i);
  });
  let seen = 0;
  let from = '';
  let to = '';
  if (tier === 2 && o.length > 0) {
    from = leadWs(o[0]!.text);
    to = leadWs(fileLines[pos] ?? '');
  }
  const out: string[] = [];
  for (const e of n) {
    if (e.kind === 'ctx') {
      out.push(fileLines[pos + ctxAt[seen]!]!);
      seen += 1;
    } else if (tier === 2 && e.text !== '' && !/^[ \t]*$/.test(e.text) && e.text.startsWith(from)) {
      out.push(to + e.text.slice(from.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

const oTexts = (entries: Ent[]): string[] => entries.filter((e) => e.kind !== 'new').map((e) => e.text);
const oEnts = (entries: Ent[]): Ent[] => entries.filter((e) => e.kind !== 'new');
const nEnts = (entries: Ent[]): Ent[] => entries.filter((e) => e.kind !== 'old');

// ---------------------------------------------------------------- format detection (section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  entries: Ent[];
}

interface USection {
  git: [string, string] | null;
  pair: [string | null, string | null] | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

const newUSection = (): USection => ({ git: null, pair: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [], inHeader: true });

/** The path a `--- ` or `+++ ` line names: after the prefix, up to a tab, trimmed; /dev/null is null. */
function pairPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function gitPaths(line: string, no: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const at = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
  const x = at >= 0 ? rest.slice(2, at) : '';
  const y = at >= 0 ? rest.slice(at + 3) : '';
  if (at < 0 || x === '' || y === '') throw new Exit2(`error: parse ${no}`);
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const pairAt = (j: number): boolean => (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      cur = newUSection();
      cur.git = gitPaths(line, i + 1);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      const pair: [string | null, string | null] = [pairPath(line), pairPath(lines[i + 1]!)];
      if (cur !== null && cur.inHeader && cur.pair === null) cur.pair = pair;
      else {
        cur = newUSection();
        cur.pair = pair;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.inHeader && cur.pair === null) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      const rest = m === null ? '' : line.slice(m[0].length);
      if (m === null || (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t')) throw new Exit2(`error: parse ${i + 1}`);
      const entries: Ent[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ') || pairAt(j)) break;
        if (bl === '') {
          entries.push({ kind: 'ctx', text: '', bs: false, emptyLine: true });
          j += 1;
          continue;
        }
        const ch = bl[0]!;
        if (ch === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), bs: false });
        else if (ch === '-') entries.push({ kind: 'old', text: bl.slice(1), bs: false });
        else if (ch === '+') entries.push({ kind: 'new', text: bl.slice(1), bs: false });
        else if (ch === '\\') {
          const prev = entries[entries.length - 1];
          if (prev !== undefined) prev.bs = true;
          j += 1;
          continue;
        } else break;
        j += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.emptyLine === true) entries.pop();
      cur.hunks.push({ a: Number(m[1]), entries });
      cur.inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to a file model; a hunk that finds nothing fails the whole section. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const oe = oEnts(hunk.entries);
    const ne = nEnts(hunk.entries);
    const o = oe.map((e) => e.text);
    if (o.length > 0) {
      const found = findTier(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const reachesEnd = pos + o.length === model.lines.length;
      const repl = buildReplacement(model.lines, pos, oe, ne, found.tier);
      model.lines.splice(pos, o.length, ...repl);
      if (reachesEnd) {
        const tail = [...ne].reverse().find((e) => e.kind === 'ctx' || e.kind === 'new');
        model.final = tail !== undefined ? !tail.bs : model.lines.length > 0;
      }
      d += ne.length - o.length;
    } else if (ne.length > 0) {
      const at = Math.min(hunk.a + d, model.lines.length);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...ne.map((e) => e.text));
      if (atEnd) {
        const tail = [...ne].reverse().find((e) => e.kind === 'new');
        if (tail !== undefined) model.final = !tail.bs;
      }
      d += ne.length;
    }
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  let oldP: string | null | undefined;
  let newP: string | null | undefined;
  if (sec.pair !== null) {
    oldP = sec.pair[0];
    newP = sec.pair[1];
  } else if (sec.renameFrom !== null && sec.renameTo !== null) {
    // The rename pair names the paths only when no ---/+++ pair does (section 6).
    oldP = sec.renameFrom;
    newP = sec.renameTo;
  } else if (sec.git !== null) {
    oldP = sec.git[0];
    newP = sec.git[1];
  }
  const isCreate = sec.create || oldP === null;
  const isDelete = sec.del || newP === null;
  return (tree, moves) => {
    if (isCreate && !isDelete) {
      const target = typeof newP === 'string' ? newP : '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const added: string[] = [];
      let lastPlus: Ent | null = null;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            added.push(e.text);
            lastPlus = e;
          }
        }
      }
      tree.now.set(target, added.length === 0 ? '' : added.join('\n') + (lastPlus !== null && lastPlus.bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = typeof oldP === 'string' ? oldP : '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = typeof oldP === 'string' ? oldP : '';
    const to = typeof newP === 'string' ? newP : '';
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, from);
    tree.now.set(to, writeModel(model));
    if (to !== from) {
      tree.now.set(from, null);
      moves.push([from, to]);
    }
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rp = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rp = j;
          break;
        }
      }
    }
    if (eq < 0 || rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= after; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rp);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      const found = findTier(model.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const oe: Ent[] = oldLines.map((t) => ({ kind: 'old', text: t, bs: false }));
      const ne: Ent[] = newLines.map((t) => ({ kind: 'new', text: t, bs: false }));
      const repl = buildReplacement(model.lines, pos, oe, ne, found.tier);
      model.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, writeModel(model));
    });
    prevPath = path;
    after = rp + 1;
    i = rp + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Ent[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  raw: Array<{ text: string; no: number }>;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j])) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = firstNB + 1; i < lastNB; i += 1) {
    const line = lines[i]!;
    const heads: Array<[string, VSection['kind']]> = [
      ['*** Add File: ', 'add'],
      ['*** Delete File: ', 'del'],
      ['*** Update File: ', 'upd'],
    ];
    const head = heads.find(([pre]) => line.startsWith(pre));
    if (head !== undefined) {
      cur = { kind: head[1], path: line.slice(head[0].length).trim(), line: i + 1, raw: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.raw.push({ text: line, no: i + 1 });
    }
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  const p = sec.path;
  if (sec.kind === 'add') {
    const content: Array<{ text: string; blankLine: boolean }> = [];
    for (const r of sec.raw) {
      if (r.text.startsWith('+')) content.push({ text: r.text.slice(1), blankLine: false });
      else if (r.text === '') content.push({ text: '', blankLine: true });
      else if (blank(r.text)) content.push({ text: '', blankLine: true });
      else throw new Exit2(`error: parse ${r.no}`);
    }
    while (content.length > 0 && content[content.length - 1]!.blankLine) content.pop();
    const fileLines = content.map((c) => c.text);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    for (const r of sec.raw) if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  // Update File: an optional Move to, then chunks.
  const raw = [...sec.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  const close = (): void => {
    if (chunk !== null) {
      chunks.push(chunk);
      chunk = null;
    }
  };
  for (let k = start; k < raw.length; k += 1) {
    const r = raw[k]!;
    if (r.text === '*** End of File') {
      if (chunk === null) chunk = { anchor: null, eof: true, entries: [] };
      chunk.eof = true;
      close();
    } else if (r.text.startsWith('@@')) {
      close();
      const anchor = r.text.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
    } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
      if (chunk === null) chunk = { anchor: null, eof: false, entries: [] };
      const kind = r.text === '' || r.text[0] === ' ' ? 'ctx' : r.text[0] === '-' ? 'old' : 'new';
      chunk.entries.push({ kind, text: r.text === '' ? '' : r.text.slice(1), bs: false });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  return (tree, moves) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    applyChunks(model, chunks, strict, p);
    const target = moveTo ?? p;
    tree.now.set(target, writeModel(model));
    if (moveTo !== null) {
      tree.now.set(p, null);
      moves.push([p, moveTo]);
    }
  };
}

/** Apply an Update File section's chunks in order, the cursor walking down the file (section 8). */
function applyChunks(model: FileModel, chunks: VChunk[], strict: boolean, path: string): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let at = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < model.lines.length; i += 1) {
          if (lineEq(model.lines[i]!, chunk.anchor, tier)) {
            at = i;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const oe = oEnts(chunk.entries);
    const ne = nEnts(chunk.entries);
    const o = oe.map((e) => e.text);
    if (o.length > 0) {
      let hit: { tier: number; positions: number[] } | null = findTier(model.lines, o, strict, cursor);
      if (hit !== null && chunk.eof) {
        const ends = hit.positions.filter((pos) => pos + o.length === model.lines.length);
        hit = ends.length > 0 ? { tier: hit.tier, positions: ends } : null;
      }
      if (hit === null) throw new Fail('no-match', path);
      const pos = hit.positions[0]!;
      const repl = buildReplacement(model.lines, pos, oe, ne, hit.tier);
      model.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    } else {
      const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
      model.lines.splice(at, 0, ...ne.map((e) => e.text));
      cursor = at + ne.length;
    }
  }
}

// ---------------------------------------------------------------- JSON edits (section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, writeModel(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- the run (sections 1, 2 and 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, n] of moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      usedOld.add(o);
      usedNew.add(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
