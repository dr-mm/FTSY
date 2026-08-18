#!/usr/bin/env node
/**
 * scripts/update-rankings.mjs
 * ----------------------------------------------------------------------------
 * Atualiza `players.js` (rank, prevRank, ranks{}, tier, team, bye) a partir de
 * um CSV local exportado do Flock Fantasy (https://flockfantasy.com/rankings).
 *
 * Uso:
 *   node update-rankings.mjs <caminho-do-csv> [--out <arquivo-de-saida>]
 *
 * Exemplo:
 *   node update-rankings.mjs REDRAFT-rankings.csv
 *
 * Formato esperado do CSV (cabeçalho exato, validado contra o arquivo real):
 *   Name,Team,Position,Tier,Expert Rank
 *
 * O Flock só publica UM rank consolidado por jogador (coluna "Expert Rank"),
 * sem separar por PPR/Half/Standard nem por TD de passe 4pt/6pt. Por isso
 * este script aplica o mesmo rank consolidado nas 6 chaves de ranks{}
 * (PPR_4/PPR_6/HALF_4/HALF_6/STD_4/STD_6) — é uma aproximação, documentada
 * aqui e avisada no log, não uma diferenciação real por formato.
 *
 * O que o script faz:
 *  1. Lê o CSV, ordena por "Expert Rank" (numérico, pode ter casas decimais)
 *     e atribui um rank inteiro sequencial (1, 2, 3, ...).
 *  2. Casa cada linha do CSV com um jogador existente em players.js por nome
 *     normalizado (removendo acento/pontuação/sufixo Jr-Sr-II-III) + time
 *     como desempate quando o nome bate em mais de um jogador.
 *  3. Pra cada jogador casado: joga o rank/ranks{} atuais pra prevRank/
 *     prevRanks{} (assim as setinhas ▲/▼ do app continuam funcionando) e
 *     escreve o novo rank, tier, time e bye (via tabela de byes do app.js).
 *  4. Jogador do players.js que NÃO aparece no CSV (ex: K/DST, que o Flock
 *     não rankeia, ou alguém que saiu do board) fica intocado.
 *  5. Jogador do CSV que NÃO existe em players.js é adicionado como novo,
 *     com um id novo (sequencial após o maior id de jogador "de skill",
 *     mantendo o bloco de K/DST em ids >= 1000 do jeito que já está).
 *  6. Se a taxa de match ficar abaixo de MIN_MATCH_RATE, o script aborta e
 *     NÃO toca em players.js — mostra os primeiros nomes sem match pra
 *     você conferir se é time trocado, nome grafado diferente, etc.
 * ----------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYERS_JS_PATH = path.join(__dirname, 'players.js');

const MIN_MATCH_RATE = 0.5; // abaixo disso, algo mudou (nome de coluna, csv errado etc) — não commita

// Tabela de byes 2026, copiada do app.js (usada só quando um jogador troca
// de time ou é adicionado novo — pra quem já existe em players.js, o bye
// atual é preservado a menos que o time mude).
const NFL_BYES = { ARI: 11, ATL: 14, BAL: 14, BUF: 12, CAR: 11, CHI: 7, CIN: 12, CLE: 10, DAL: 7, DEN: 14, DET: 5, GB: 10, HOU: 14, IND: 14, JAX: 12, KC: 6, LV: 10, LAC: 5, LAR: 6, MIA: 6, MIN: 6, NE: 14, NO: 12, NYG: 11, NYJ: 12, PHI: 5, PIT: 9, SF: 9, SEA: 10, TB: 11, TEN: 5, WAS: 14 };

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const out = outIdx !== -1 ? args[outIdx + 1] : PLAYERS_JS_PATH;
  if (positional.length === 0) {
    console.error('Uso: node update-rankings.mjs <caminho-do-csv> [--out <arquivo-de-saida>]');
    process.exit(1);
  }
  return { csvPath: path.resolve(positional[0]), outPath: path.resolve(out) };
}

// ---------------------------------------------------------------------------
// CSV parsing (sem dependências externas — parser simples com suporte a
// campos entre aspas, suficiente pro CSV do Flock).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip, \n handles the line break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];

  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.length === header.length && r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// Normalização de nomes (pra casar Flock x players.js) — remove pontuação,
// sufixos (Jr/Sr/II/III/IV) e acentos, lowercase.
// ---------------------------------------------------------------------------
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/gi, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// 1) Carrega o players.js atual
// ---------------------------------------------------------------------------
async function loadCurrentPlayers(playersJsPath) {
  const src = readFileSync(playersJsPath, 'utf8');
  const mod = await import(`data:text/javascript,${encodeURIComponent(src + '\nexport { defaultPlayers, rankingsUpdatedAt };')}`);
  return mod.defaultPlayers;
}

// ---------------------------------------------------------------------------
// 2) Carrega e normaliza o CSV do Flock
// ---------------------------------------------------------------------------
function loadFlockCsv(csvPath) {
  const csvText = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error('CSV parseado deu 0 linhas — arquivo vazio ou formato inesperado.');

  const requiredCols = ['Name', 'Team', 'Position', 'Tier', 'Expert Rank'];
  const gotCols = Object.keys(rows[0]);
  const missing = requiredCols.filter(c => !gotCols.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `CSV não tem as colunas esperadas. Faltando: ${missing.join(', ')}.\n` +
      `Colunas encontradas: ${gotCols.join(', ')}`
    );
  }

  // Parseia e ordena por Expert Rank numérico pra virar rank inteiro sequencial.
  const parsed = rows
    .map(r => ({
      name: r.Name.trim(),
      team: r.Team.trim().toUpperCase(),
      pos: r.Position.trim().toUpperCase(),
      tier: r.Tier.trim(),
      expertRank: parseFloat(r['Expert Rank']),
    }))
    .filter(r => r.name && !Number.isNaN(r.expertRank));

  parsed.sort((a, b) => a.expertRank - b.expertRank);

  // Dedup por nome normalizado + time: se o CSV tiver linha duplicada (ex:
  // erro de export com o mesmo jogador aparecendo 2x com times/ranks
  // diferentes), fica com a primeira ocorrência (melhor rank, já que a
  // lista está ordenada) e avisa no log.
  const seen = new Set();
  const deduped = [];
  const dupWarnings = [];
  for (const r of parsed) {
    const key = `${normalizeName(r.name)}|${r.team}`;
    if (seen.has(key)) {
      dupWarnings.push(`${r.name} (${r.team || 'sem time'})`);
      continue;
    }
    seen.add(key);
    deduped.push(r);
  }
  if (dupWarnings.length > 0) {
    console.warn(`⚠️  ${dupWarnings.length} linha(s) duplicada(s) no CSV ignorada(s) (mantida a de melhor rank): ${dupWarnings.join(', ')}`);
  }

  deduped.forEach((r, idx) => { r.rank = idx + 1; });
  return deduped;
}

// ---------------------------------------------------------------------------
// 3) Índices de busca: nome normalizado -> lista de candidatos do CSV
//    (pra desempatar por time quando o nome bate em mais de um jogador)
// ---------------------------------------------------------------------------
function buildCsvIndex(csvRows) {
  const byName = new Map();
  for (const r of csvRows) {
    const key = normalizeName(r.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  return byName;
}

function findCsvMatch(player, byName) {
  const key = normalizeName(player.name);
  const candidates = byName.get(key);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Nome ambíguo (raro) — desempata por time.
  const sameTeam = candidates.find(c => c.team === String(player.team || '').toUpperCase());
  return sameTeam || candidates[0];
}

// ---------------------------------------------------------------------------
// 4) Aplica o novo rank do Flock num jogador existente, preservando prevRank
//    e prevRanks{} pras setinhas de tendência do app continuarem funcionando.
// ---------------------------------------------------------------------------
function applyFlockRankToPlayer(player, csvRow) {
  const oldRanks = player.ranks ? { ...player.ranks } : null;
  const newRanksValue = {
    PPR_4: csvRow.rank, PPR_6: csvRow.rank,
    HALF_4: csvRow.rank, HALF_6: csvRow.rank,
    STD_4: csvRow.rank, STD_6: csvRow.rank,
  };

  const updated = {
    ...player,
    prevRank: player.rank,
    rank: csvRow.rank,
    tier: csvRow.tier || player.tier,
    ranks: newRanksValue,
  };
  if (oldRanks) updated.prevRanks = oldRanks;

  // Time pode ter mudado (trade) — se mudou, atualiza time e bye junto.
  const csvTeam = csvRow.team;
  if (csvTeam && csvTeam !== player.team) {
    updated.team = csvTeam;
    if (NFL_BYES[csvTeam] !== undefined) updated.bye = NFL_BYES[csvTeam];
  }

  return updated;
}

// ---------------------------------------------------------------------------
// 5) Monta um jogador novo (existe no CSV, não existia em players.js)
// ---------------------------------------------------------------------------
function buildNewPlayer(csvRow, nextId) {
  const rankValue = {
    PPR_4: csvRow.rank, PPR_6: csvRow.rank,
    HALF_4: csvRow.rank, HALF_6: csvRow.rank,
    STD_4: csvRow.rank, STD_6: csvRow.rank,
  };
  return {
    id: nextId,
    rank: csvRow.rank,
    prevRank: csvRow.rank,
    name: csvRow.name,
    team: csvRow.team || '',
    bye: NFL_BYES[csvRow.team] ?? '-',
    pos: csvRow.pos,
    posClass: 'pos-' + csvRow.pos.toLowerCase(),
    tier: csvRow.tier,
    espnId: null,
    ranks: rankValue,
  };
}

// ---------------------------------------------------------------------------
// 6) Serializa defaultPlayers de volta no mesmo formato usado em players.js
// ---------------------------------------------------------------------------
function serializePlayersJs(players, stamp) {
  const header =
    '// players.js - Complete NFL Fantasy Player Database (with espnId + prevRank + per-format ranks)\n' +
    '// rankingsUpdatedAt: ISO timestamp of the last rankings sync (scripts/update-rankings.mjs, fonte: Flock Fantasy CSV).\n' +
    '// ranks{}: per-scoring-format rank (PPR_4/PPR_6/HALF_4/HALF_6/STD_4/STD_6) — o Flock só publica um rank\n' +
    '// consolidado (sem diferenciar formato/TD de passe), então as 6 chaves recebem o mesmo valor.\n' +
    `const rankingsUpdatedAt = ${JSON.stringify(stamp)};\n` +
    'const defaultPlayers = [\n';

  const body = players
    .map(p => '    { ' + Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + ' }')
    .join(',\n');

  return header + body + '\n];\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const { csvPath, outPath } = parseArgs(process.argv);

  if (!existsSync(csvPath)) {
    console.error(`❌ CSV não encontrado: ${csvPath}`);
    process.exit(1);
  }

  console.log(`📥 Lendo CSV do Flock: ${csvPath}`);
  const csvRows = loadFlockCsv(csvPath);
  console.log(`   ${csvRows.length} jogadores no CSV (após dedup), rank 1 a ${csvRows.length}`);

  console.log(`📥 Lendo players.js atual: ${PLAYERS_JS_PATH}`);
  const currentPlayers = await loadCurrentPlayers(PLAYERS_JS_PATH);
  console.log(`   ${currentPlayers.length} jogadores em players.js`);

  const byName = buildCsvIndex(csvRows);
  const usedCsvKeys = new Set();

  let matched = 0;
  const unmatchedPlayers = [];
  const updatedPlayers = currentPlayers.map(p => {
    const csvRow = findCsvMatch(p, byName);
    if (!csvRow) { unmatchedPlayers.push(p.name); return p; }
    matched++;
    usedCsvKeys.add(`${normalizeName(csvRow.name)}|${csvRow.team}`);
    return applyFlockRankToPlayer(p, csvRow);
  });

  const matchRate = matched / currentPlayers.length;
  console.log(`🔗 ${matched}/${currentPlayers.length} jogadores casados (${(matchRate * 100).toFixed(1)}%)`);
  if (unmatchedPlayers.length > 0) {
    console.log(`   Sem match no CSV (mantidos como estão — ex: K/DST que o Flock não rankeia): ${unmatchedPlayers.length}`);
    console.log(`   Primeiros: ${unmatchedPlayers.slice(0, 15).join(', ')}${unmatchedPlayers.length > 15 ? ', ...' : ''}`);
  }

  if (matchRate < MIN_MATCH_RATE) {
    console.error(`❌ Taxa de match ${(matchRate * 100).toFixed(1)}% abaixo do limite de segurança de ${MIN_MATCH_RATE * 100}%.`);
    console.error('   players.js NÃO foi modificado — confira o cabeçalho do CSV e os nomes acima.');
    process.exit(1);
  }

  // Jogadores novos: estão no CSV mas não bateram com ninguém em players.js.
  let nextId = Math.max(0, ...currentPlayers.filter(p => p.id < 1000).map(p => p.id)) + 1;
  const newPlayers = [];
  for (const r of csvRows) {
    const key = `${normalizeName(r.name)}|${r.team}`;
    if (usedCsvKeys.has(key)) continue;
    newPlayers.push(buildNewPlayer(r, nextId));
    nextId++;
  }
  if (newPlayers.length > 0) {
    console.log(`➕ ${newPlayers.length} jogador(es) novo(s) do CSV adicionados (sem espnId — o app usa o avatar padrão):`);
    console.log(`   ${newPlayers.map(p => p.name).slice(0, 15).join(', ')}${newPlayers.length > 15 ? ', ...' : ''}`);
  }

  const finalPlayers = [...updatedPlayers, ...newPlayers];

  const stamp = new Date().toISOString();
  const output = serializePlayersJs(finalPlayers, stamp);
  writeFileSync(outPath, output);
  console.log(`✅ ${outPath === PLAYERS_JS_PATH ? 'players.js atualizado' : `Salvo em ${outPath}`} (rankingsUpdatedAt = ${stamp})`);
}

main().catch(err => {
  console.error('❌ Atualização falhou — nada foi escrito.');
  console.error(err);
  process.exit(1);
});
