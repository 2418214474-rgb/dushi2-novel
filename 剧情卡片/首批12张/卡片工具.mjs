import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../../../..');
const readJSON = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(dir, name), value, 'utf8');
const writeJSON = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const library = readJSON('卡片库.json');
const config = readJSON('试抽配置.json');
const cards = new Map(library.cards.map(c => [c.id, c]));
const eligible = config.eligibility.filter(e => e.eligible).map(e => e.id);
const stateFile = '抽取记录.json';
const loadState = () => fs.existsSync(path.join(dir, stateFile)) ? readJSON(stateFile) : {
  schemaVersion: 1, rounds: [], selected: [], adopted: [],
  note: 'rounds仅记录抽中；selected记录用户选主卡；adopted记录用户明确采纳的梗概。三者独立，抽中不永久排除。'
};
const parsed = new Map();
const fingerprints = {};
for (const book of Object.values(library.books)) {
  const buffer = fs.readFileSync(path.join(root, book.path));
  fingerprints[book.path] = hash(buffer);
  let chapter = 0, event = 0;
  buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    const heading = line.match(/^## 第(\d+)章/);
    if (heading) { chapter = Number(heading[1]); event = 0; }
    else if (chapter && line.trim() && !line.startsWith('#') && !line.startsWith('**情绪曲线')) {
      event++;
      parsed.set(`${book.name}-${chapter}-${event}`, { line: index + 1, text: line, path: book.path });
    }
  });
}
for (const relative of config.contextFiles) fingerprints[relative] = hash(fs.readFileSync(path.join(root, relative)));
const importedPath = '写作工作台/data/materials.json';
fingerprints[importedPath] = hash(fs.readFileSync(path.join(root, importedPath)));
const imported = new Map(JSON.parse(fs.readFileSync(path.join(root, importedPath), 'utf8')).map(m => [m.id, m]));
const sources = card => card.sources.flatMap(ref => ref.events.map(event => {
  const book = library.books[card.id[0]];
  const id = `${book.name}-${ref.chapter}-${event}`;
  const source = parsed.get(id);
  if (!source) throw new Error(`找不到来源：${id}`);
  return { id, chapter: ref.chapter, event, focus: ref.focus, ...source, textSha256: hash(source.text) };
}));

function verify() {
  const expected = ['A', 'B', 'C'].flatMap(g => [1, 2, 3, 4].map(n => `${g}00${n}`));
  if (library.cards.length !== 12 || expected.some(id => !cards.has(id))) throw new Error('固定编号不完整或重复');
  const seen = new Set();
  for (const c of library.cards) {
    for (const field of ['title', 'originalNarrative', 'coreConflict', 'responseAndTurn', 'result', 'costOrOpenProblem', 'reusableStructure']) {
      if (!c[field]?.trim()) throw new Error(`${c.id}缺少${field}`);
    }
    if (c.originalNarrative.length < 250 || c.originalNarrative.length > 500) throw new Error(`${c.id}经过篇幅需复核`);
    if (!c.useConditions.length || !c.sources.length) throw new Error(`${c.id}缺少使用条件或来源`);
    for (const s of sources(c)) {
      if (seen.has(s.id)) throw new Error(`来源事件重复计入：${s.id}`);
      seen.add(s.id);
      if (imported.get(s.id)?.text !== s.text) throw new Error(`来源与导入内容不一致：${s.id}`);
    }
  }
  if (config.eligibility.length !== 12 || new Set(config.eligibility.map(e => e.id)).size !== 12 || config.eligibility.some(e => !cards.has(e.id))) throw new Error('适配审查未覆盖全部卡片');
  const indexPath = path.join(dir, '编号目录.json');
  if (fs.existsSync(indexPath)) {
    const saved = readJSON('编号目录.json');
    for (const [relative, digest] of Object.entries(saved.sourceFingerprints)) {
      if (fingerprints[relative] !== digest) throw new Error(`来源或设定发生变化，请先复核：${relative}`);
    }
  }
  return { cards: 12, sourceEvents: seen.size, narrativeLength: library.cards.map(c => `${c.id}:${c.originalNarrative.length}`), eligible };
}

function cardMarkdown(c) {
  const book = library.books[c.id[0]];
  const refs = c.sources.map(ref => {
    const first = sources(c).find(s => s.chapter === ref.chapter && s.event === ref.events[0]);
    return `- [第${ref.chapter}章，事件${ref.events.join('、')}](<${slash(path.join(root, book.path))}:${first.line}>)：${ref.focus}`;
  });
  return [`## ${c.id}｜${c.title}`, '', `来源书：《${book.name}》`, '', '### 原书经过', '', c.originalNarrative, '',
    `核心冲突：${c.coreConflict}`, '', `应对与转折：${c.responseAndTurn}`, '', `阶段结果：${c.result}`, '', `代价或未解决问题：${c.costOrOpenProblem}`, '',
    '### 可复用结构与使用条件', '', c.reusableStructure, '', ...c.useConditions.map(v => `- ${v}`), '',
    '### 来源定位', '', ...refs, '', ''].join('\n');
}

function build() {
  verify();
  let booklet = ['# 首批12张完整故事卡', '', library.sourceNotice, '',
    '每张卡是一段小剧情的阶段性闭环。先读“原书经过”，再看可复用结构；新书改编另行选择、确认。编号永久固定，不因排序改变。', '',
    '## 编号目录', '', '| 编号 | 书籍 | 卡片 |', '| --- | --- | --- |',
    ...library.cards.map(c => `| ${c.id} | ${library.books[c.id[0]].name} | ${c.title} |`), '', ''].join('\n');
  const entries = {};
  for (const c of library.cards) {
    const line = booklet.split('\n').length;
    entries[c.id] = {
      title: c.title, book: library.books[c.id[0]].name,
      cardLibrary: '卡片库.json', lookup: `cards[id=${c.id}]`,
      readableFile: '卡片册.md', readableLine: line,
      sources: sources(c).map(({ text, ...reference }) => reference)
    };
    booklet += cardMarkdown(c);
  }
  write('卡片册.md', booklet);
  writeJSON('编号目录.json', { schemaVersion: 1, workspaceRoot: slash(root), sourceNotice: library.sourceNotice, sourceFingerprints: fingerprints, entries });
  console.log(JSON.stringify(verify(), null, 2));
}

// 可复现的随机排列；拒绝抽样避免取模偏差，历史记录不用于排除卡片。
function shuffle(pool, seed) {
  const result = [...pool];
  let counter = 0;
  function below(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do { x = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0); } while (x >= limit);
    return x % n;
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function draw(keep) {
  verify();
  const state = loadState();
  const previous = state.rounds.at(-1);
  if (keep && (!eligible.includes(keep) || !previous?.candidates.includes(keep))) throw new Error('只能保留上次候选中当前仍适用的一张');
  const seed = randomBytes(16).toString('hex');
  const held = keep ? [keep] : [];
  const candidates = held.concat(shuffle(eligible.filter(id => id !== keep), seed).slice(0, Math.max(0, 3 - held.length)));
  const round = {
    id: `D${String(state.rounds.length + 1).padStart(3, '0')}`,
    time: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()) + ' Asia/Shanghai',
    goal: config.goal, seed, algorithm: 'SHA256 counter + rejection sampling + Fisher-Yates',
    eligiblePool: eligible, kept: held, candidates, status: 'awaiting_user_selection',
    contextSnapshot: config.context, sourceFingerprints: fingerprints,
    eligibilitySnapshot: config.eligibility,
    selectedMain: null, preview: null, previewConfirmed: false,
    previewConfirmationUserQuote: null, generatedOutline: null, acceptedOutline: null,
    feedback: { easyToChoose: null, substantiveRevisions: null, continuityPassed: null }
  };
  state.rounds.push(round);
  writeJSON(stateFile, state);
  const report = [`# ${round.id}｜饭馆经营压力 · 候选抽取`, '',
    '当前停在候选阶段，尚未选定主卡或采纳新剧情。以下是改编建议，不是原书内容，也不是陆川已发生的前情。', '',
    `合格池：${eligible.join('、')}；随机种子：${seed}。${keep ? `保留${keep}，其余重新抽取。` : '本轮无放回随机抽三张。'}`, '',
    ...candidates.flatMap(id => {
      const e = config.eligibility.find(v => v.id === id);
      return [`## ${id}｜${cards.get(id).title}`, '', `故事方向：${e.direction}`, '', `适配理由：${e.reason}`, '', `需要修改：${e.changes}`, ''];
    }), '## 本轮未入池的卡', '', ...config.eligibility.filter(e => !e.eligible).map(e => `- ${e.id}：${e.reason}`), '',
    '回复“主卡：编号”后，先给一段简要剧情；用户确认方向后，再展开详细剧情梗概。也可以说“保留某编号，重抽其余”或“展开某编号”。选卡、确认方向与采纳梗概分别记录。', ''].join('\n');
  write(`${round.id}_候选.md`, report);
  console.log(JSON.stringify({ round: round.id, candidates, seed, selected: state.selected, adopted: state.adopted }, null, 2));
}

const [command = 'verify', ...args] = process.argv.slice(2);
if (command === 'build') build();
else if (command === 'verify') console.log(JSON.stringify(verify(), null, 2));
else if (command === 'show') {
  for (const id of args) {
    if (!cards.has(id)) throw new Error(`未知编号：${id}`);
    console.log(cardMarkdown(cards.get(id)));
  }
} else if (command === 'draw') draw(args[0]);
else throw new Error('命令：build | verify | show A001 [B002] | draw [保留编号]');
