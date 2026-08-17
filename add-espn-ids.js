/**
 * add-espn-ids.js
 * -----------------------------------------------------------------------
 * Lê players.js (const defaultPlayers = [...]), busca o espnId de cada
 * jogador na API pública de busca da ESPN (site.web.api.espn.com), casando
 * por NOME + POSIÇÃO + TIME para evitar pegar o jogador errado em casos de
 * nomes repetidos (ex: mais de um "Josh Allen" na base histórica da ESPN).
 *
 * Uso:
 *   node add-espn-ids.js caminho/para/players.js
 *
 * Saída:
 *   players.espn.js  (mesmo array, com o campo "espnId" adicionado)
 *   espn-id-report.txt (relatório: jogadores não encontrados / ambíguos)
 *
 * Requisitos: Node 18+ (usa fetch nativo). Sem dependências externas.
 * -----------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const inputPath = args[0] || "players.js";
const outPath = path.join(path.dirname(inputPath), "players.espn.js");
const reportPath = path.join(path.dirname(inputPath), "espn-id-report.txt");
const DEBUG = process.argv.includes("--debug");
const limitArgIdx = process.argv.indexOf("--limit");
const LIMIT =
  limitArgIdx !== -1 ? parseInt(process.argv[limitArgIdx + 1], 10) : null;

// ---- 1. Carrega o array de jogadores a partir do players.js original ----
function loadPlayers(file) {
  const src = fs.readFileSync(file, "utf8");
  // Extrai o conteúdo do array "const defaultPlayers = [ ... ];"
  const match = src.match(/const\s+defaultPlayers\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error(
      "Não encontrei 'const defaultPlayers = [...]' no arquivo. Ajuste o regex se o nome da variável for outro."
    );
  }
  // eslint-disable-next-line no-eval
  const players = eval(match[1]);
  return players;
}

// ---- 2. Mapa de posição -> abreviações que podem aparecer no subtitle ----
const POS_ALIASES = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K", "PK"],
  DST: ["D/ST", "DEF", "DST"],
};

// Mapa manual de sigla de time -> nome usado pela ESPN no subtitle de busca
const TEAM_NAME = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals", CLE: "Cleveland Browns", DAL: "Dallas Cowboys",
  DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars",
  JAC: "Jacksonville Jaguars", KC: "Kansas City Chiefs", LV: "Las Vegas Raiders",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints",
  NYG: "New York Giants", NYJ: "New York Jets", PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers", SF: "San Francisco 49ers", SEA: "Seattle Seahawks",
  TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
  WSH: "Washington Commanders",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 3. Busca na API pública de busca da ESPN ----
async function searchEspn(query, debug) {
  const url = `https://site.web.api.espn.com/apis/search/v2?region=us&lang=en&query=${encodeURIComponent(
    query
  )}&limit=10`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; espn-id-lookup/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const data = await res.json();
  if (debug) console.log(JSON.stringify(data, null, 2));

  // A API de busca da ESPN não é oficialmente documentada e já variou de
  // formato no passado. Tentamos alguns formatos conhecidos aqui.
  const results = [];
  for (const group of data.results || []) {
    for (const item of group.contents || []) {
      results.push(normalizeResultItem(item));
    }
  }
  // Formato alternativo visto em algumas respostas: data.items / data.contents direto
  if (results.length === 0 && Array.isArray(data.items)) {
    for (const item of data.items) results.push(normalizeResultItem(item));
  }
  return results.filter(Boolean);
}

// Normaliza um item de resultado para { link, subtitle, displayName }
function normalizeResultItem(item) {
  if (!item) return null;
  const link =
    (item.link && (item.link.web || item.link)) ||
    item.href ||
    item.url ||
    "";
  return {
    link: typeof link === "string" ? link : "",
    subtitle: item.subtitle || item.description || "",
    displayName: item.displayName || item.title || item.name || "",
  };
}

// Extrai o id numérico de um link tipo .../nfl/player/_/id/4241423/ja-marr-chase
function extractId(link) {
  const m = /\/id\/(\d+)\b/.exec(link || "");
  return m ? m[1] : null;
}

// ---- 4. Escolhe o melhor candidato dentre os resultados da busca ----
function pickBestMatch(player, results) {
  const wantedPosAliases = POS_ALIASES[player.pos] || [player.pos];
  const wantedTeamName = TEAM_NAME[player.team];

  // Só considera resultados que parecem ser jogadores de NFL
  const candidates = results.filter((r) => {
    const link = r.link || "";
    return /espn\.com\/nfl\/player\//.test(link) && /\/id\/\d+\b/.test(link);
  });

  if (candidates.length === 0) return { id: null, reason: "sem-candidatos" };

  // Casa por posição + time no "subtitle" (ex: "NFL - WR - Detroit Lions")
  const exact = candidates.filter((c) => {
    const sub = (c.subtitle || "").toUpperCase();
    const posOk = wantedPosAliases.some((p) => sub.includes(p.toUpperCase()));
    const teamOk = wantedTeamName
      ? sub.includes(wantedTeamName.toUpperCase())
      : true;
    return posOk && teamOk;
  });

  if (exact.length === 1) {
    return { id: extractId(exact[0].link), reason: "match-exato" };
  }
  if (exact.length > 1) {
    return {
      id: extractId(exact[0].link),
      reason: `ambiguo-${exact.length}-candidatos-mesmo-time-pos`,
    };
  }

  // Nenhum bateu time+posição exatos -> ao menos posição bate
  const posOnly = candidates.filter((c) => {
    const sub = (c.subtitle || "").toUpperCase();
    return wantedPosAliases.some((p) => sub.includes(p.toUpperCase()));
  });
  if (posOnly.length >= 1) {
    return {
      id: extractId(posOnly[0].link),
      reason:
        posOnly.length === 1
          ? "match-so-posicao(time-nao-confirmado)"
          : `ambiguo-${posOnly.length}-so-posicao`,
    };
  }

  // Último recurso: primeiro resultado que parece jogador de NFL
  return {
    id: extractId(candidates[0].link),
    reason: "fallback-primeiro-resultado(revisar)",
  };
}

// Nome de busca para DST: usa o nome completo do time (ex: "Houston Texans")
function queryFor(player) {
  if (player.pos === "DST") {
    return player.name.replace(/\s+DST$/i, "");
  }
  return player.name;
}

async function main() {
  let players = loadPlayers(inputPath);
  console.log(`Carregados ${players.length} jogadores de ${inputPath}`);
  if (LIMIT) {
    players = players.slice(0, LIMIT);
    console.log(`(--limit ativo: processando apenas os primeiros ${LIMIT})`);
  }

  const report = [];
  let ok = 0,
    warn = 0,
    fail = 0;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const q = queryFor(p);
    try {
      const results = await searchEspn(q, DEBUG && i === 0);
      const { id, reason } = pickBestMatch(p, results);
      p.espnId = id; // pode ficar null se não achou

      if (id && reason === "match-exato") {
        ok++;
      } else if (id) {
        warn++;
        report.push(
          `[REVISAR] ${p.name} (${p.pos}/${p.team}) -> espnId=${id} | motivo: ${reason}`
        );
      } else {
        fail++;
        report.push(
          `[NAO ENCONTRADO] ${p.name} (${p.pos}/${p.team}) | motivo: ${reason}`
        );
      }
    } catch (err) {
      fail++;
      p.espnId = null;
      report.push(`[ERRO] ${p.name} (${p.pos}/${p.team}) -> ${err.message}`);
    }

    if ((i + 1) % 20 === 0 || i === players.length - 1) {
      console.log(`Processados ${i + 1}/${players.length}...`);
    }

    // Pequena pausa para não sobrecarregar a API pública da ESPN
    await sleep(150);
  }

  // ---- 5. Grava o novo players.js ----
  const header = `// players.js - Complete ${players.length} NFL Fantasy Player Database (com espnId)\n`;
  const body =
    "const defaultPlayers = [\n" +
    players
      .map(
        (p) =>
          "    " +
          JSON.stringify(p)
            .replace(/,"/g, ', "') // espaço depois da vírgula
            .replace(/":/g, '": ') // espaço depois dos dois-pontos
      )
      .join(",\n") +
    "\n];\n";
  fs.writeFileSync(outPath, header + body, "utf8");

  fs.writeFileSync(
    reportPath,
    `Relatório de vínculo com espnId\n` +
      `OK (match exato): ${ok}\nRevisar (ambíguo/parcial): ${warn}\nNão encontrado/erro: ${fail}\n\n` +
      report.join("\n") +
      "\n",
    "utf8"
  );

  console.log(`\nConcluído: ${ok} exatos, ${warn} para revisar, ${fail} não encontrados.`);
  console.log(`Arquivo gerado: ${outPath}`);
  console.log(`Relatório: ${reportPath}`);
}

main().catch((e) => {
  console.error("Falha geral:", e);
  process.exit(1);
});
