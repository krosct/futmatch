// E2E de navegador: fluxo real da aplicação no Chrome instalado.
// Uso: BASE_URL=http://127.0.0.1:4797 node e2e.mjs   (o servidor precisa estar rodando)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4797";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), "futmatch-e2e-"));
const resultados = [];
const check = (nome, ok, detalhe = "") => {
  resultados.push({ nome, ok, detalhe });
  console.log(`${ok ? "PASS" : "FAIL"} ${nome}${detalhe ? " — " + detalhe : ""}`);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const erros = [];
page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
page.on("pageerror", (e) => erros.push(String(e)));
const cdp = await page.createCDPSession();
await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });

const api = (p, code) => page.evaluate(async (u) => (await fetch(u)).json(), `${BASE}${p}`);
const clicar = (selector) => page.$eval(selector, (el) => el.click());
const clicarTexto = async (texto, seletor = "button") => {
  const handle = await page.evaluateHandle((t, s) => [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && b.offsetParent), texto, seletor);
  const el = handle.asElement();
  if (!el) throw new Error(`botão não encontrado: ${texto}`);
  await el.click();
};
const aba = (nome) => clicar(`[data-h-click="switchTab"][data-a='["${nome}"]']`);

try {
  // 1. Carregamento limpo
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[placeholder="Nome da pelada"]', { timeout: 15000 });
  check("landing carrega sem erros de console", erros.length === 0, erros.join(" | ").slice(0, 200));

  // 2. Criar pelada pela interface
  await page.type('input[placeholder="Nome da pelada"]', "Racha E2E");
  await page.type('input[placeholder="Senha mestra"]', "senha123");
  await clicarTexto("Criar Pelada");
  await page.waitForFunction(() => location.search.includes("pelada="), { timeout: 10000 });
  const code = new URL(page.url()).searchParams.get("pelada");
  check("criar pelada pela interface", /^[A-Z0-9]{5}$/.test(code || ""), code);
  const papel = await page.evaluate(() => state.role);
  check("criador vira administrador", papel === "admin", papel);

  // 3. Jogadores com Enter (data-h-keydown)
  for (const nome of ["Ana", "Bruno", "Carla", "Diego"]) {
    await page.click('input[placeholder="Nome do jogador..."]');
    await page.type('input[placeholder="Nome do jogador..."]', nome);
    await page.keyboard.press("Enter");
    await esperar(250);
  }
  let info = await api(`/api/peladas/${code}`);
  check("adicionar 4 jogadores com Enter", info.players.length === 4, `${info.players.length} no servidor`);

  // 4. Configuração: 2 jogadores por time, via autosave
  await aba("settings");
  await page.evaluate(() => { const i = document.getElementById("cfg-players-per-team"); i.value = "2"; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await esperar(2000);
  const cfg = await api(`/api/config?pelada_code=${code}`);
  check("autosave das configurações (fonte única)", cfg.players_per_team === 2, `players_per_team=${cfg.players_per_team}`);

  // 5. Sortear times e gerar confrontos
  await aba("matchmaker");
  await clicar('[data-h-click="sortearTimes"]');
  await esperar(1500);
  info = await api(`/api/peladas/${code}`);
  check("sortear times", info.teams.length === 2, `${info.teams.length} time(s)`);

  await aba("fixtures");
  await clicar('[data-h-click="gerarTabelaConfrontos"]');
  await esperar(1500);
  const partidaId = await page.evaluate(() => state.fixtures[0] && state.fixtures[0].id);
  check("gerar confrontos", !!partidaId, partidaId || "sem partida");

  // 6. Gol com + Gol (placar ajustado antes, como o app exige)
  await clicar(`[data-h-click="adjustScore"][data-a='["${partidaId}","home",1]']`);
  await esperar(300);
  await clicar(`[data-h-click="abrirAtribuicaoGols"][data-a='["${partidaId}"]']`);
  await esperar(600);
  await page.evaluate(() => document.querySelector('[data-h-click="adicionarGolJogadorDeBotao"]').click());
  await esperar(400);
  const eventos = await page.evaluate((id) => state.fixtures.find((f) => f.id === id).events.length, partidaId);
  check("botão + Gol registra evento", eventos === 1, `${eventos} evento(s)`);

  // 7. Arrastar e soltar jogador para outro time (drag nativo interceptado pelo puppeteer)
  await page.evaluate(() => { document.querySelectorAll("[data-h-click=\"closeModal\"]").forEach(b => b.click()); });
  await aba("matchmaker");
  await esperar(500);
  const origem = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-drag-kind="player"]')].find((e) => e.textContent.includes("Diego"));
    const r = el.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 };
  });
  const destino = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-h-drop="onCardDrop"]')].find((e) => (e.getAttribute("data-a") || "").includes("team_1"));
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.setDragInterception(true);
  await page.mouse.dragAndDrop(origem, destino);
  await page.setDragInterception(false);
  await esperar(1200);
  info = await api(`/api/peladas/${code}`);
  const verde = info.teams.find((t) => t.id === "team_1");
  const noVerde = verde && verde.players.some((p) => p.name === "Diego");
  check("arrastar e soltar jogador entre times", !!noVerde, noVerde ? "Diego no time Verde" : "sem mudança (drag nativo pode não ser simulável no headless)");

  // 8. Partida finalizada e relatório PDF
  await clicar(`[data-h-click="salvarPartidaFinalizada"][data-a='["${partidaId}"]']`).catch(() => {});
  await esperar(1500);
  await aba("dashboard");
  await esperar(500);
  await clicar('[data-h-click="exportarRelatorioPDF"]');
  let pdf = null;
  for (let i = 0; i < 60 && !pdf; i++) {
    await esperar(500);
    const achados = fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith(".pdf") && !f.endsWith(".crdownload"));
    if (achados.length) pdf = path.join(DOWNLOADS, achados[0]);
  }
  check("gerar relatório PDF", !!pdf && fs.statSync(pdf).size > 10000, pdf ? `${fs.statSync(pdf).size} bytes` : "nenhum arquivo");
  if (pdf) console.log(`PDF gerado em: ${pdf}`);

  // 9. Sair da pelada encerra a sessão no servidor
  page.on("response", (r) => { if (r.url().includes("/logout")) console.log(`  (resposta logout: ${r.status()})`); });
  await aba("matchmaker");
  await clicar('[data-h-click="sairPelada"]');
  await esperar(500);
  await clicarTexto("Sair da Pelada");
  await esperar(1000);
  const retorno = await page.evaluate(async (c) => (await fetch(`/api/peladas/${c}`)).json(), code);
  check("sair da pelada encerra a sessão de admin", retorno.is_admin === false, `is_admin=${retorno.is_admin}`);

  // 10. Layout em celular
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.goto(`${BASE}/?pelada=${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#role-badge", { timeout: 15000 });
  await esperar(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("layout em 390px sem rolagem horizontal", !overflow);

  check("nenhum erro de console durante o fluxo", erros.length === 0, erros.join(" | ").slice(0, 1200));
} catch (err) {
  check("fluxo E2E executou sem exceção", false, String(err && err.message || err));
} finally {
  await browser.close();
  const ok = resultados.filter((r) => r.ok).length;
  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\nRESULTADO: ${ok} passaram, ${falhas.length} falharam`);
  process.exit(falhas.length ? 1 : 0);
}
