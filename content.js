/*
 * SteamCartSelector — a browser extension to selectively buy items from the Steam cart.
 * Copyright (C) 2026 Bruno Hoske
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* ============================================================
 * SteamCartSelector — content.js  (roda no MAIN world)
 * ------------------------------------------------------------
 * Fluxo:
 *  1. Checkbox em cada item do carrinho.
 *  2. Usuário desmarca o que não quer comprar agora.
 *  3. Ao clicar em pagamento: os desmarcados são capturados
 *     (packageid/bundleid), salvos em localStorage e removidos
 *     do carrinho; a compra segue só com os marcados.
 *  4. De volta ao carrinho, o botão "Restaurar carrinho"
 *     re-adiciona os removidos numa única chamada à API
 *     (IAccountCartService/AddItemsToCart) — sem abrir abas.
 *
 * Persistência: localStorage (permanente). Como rodamos no MAIN
 * world, não temos chrome.storage aqui — localStorage resolve.
 * ============================================================ */

(function () {
  "use strict";

  const CU_VERSION = "1.0.0";
  // ligue window.CU_DEBUG = true no console para logs de detecção
  if (window.CU_DEBUG) console.log("[SteamCartSelector] carregado:", CU_VERSION);

  const MARK_ATTR = "data-scs";
  const STORAGE_KEY = "scs_removed";   // itens removidos (permanente)
  const EXCLUDE_KEY = "scs_unchecked";  // desmarcados na sessão

  /* ---------------- storage (localStorage) ---------------- */

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  let unchecked = new Set(load(EXCLUDE_KEY, []));

  /* ---------------- localizar itens ---------------- */

  // O marcador infalível de "isto é um item do carrinho" é o botão
  // "Remover": só os itens reais do carrinho têm; recomendações não.
  // Então localizamos os itens PELO botão Remover e subimos até a linha
  // que contém o link do produto. Isso não depende de classe ofuscada.
  const REMOVE_RE = /^(remover|remove|excluir|delete)$/i;

  // Retorna [{ row, removeBtn }] para cada item real do carrinho.
  function findCartEntries() {
    let entries = [];
    const seenRows = new Set();

    // Coleta todos os botões "Remover" (folhas) primeiro.
    const removeBtns = [];
    document.querySelectorAll("button, a, span, div, [role='button']").forEach((el) => {
      if (el.children.length !== 0) return;                 // só folhas
      if (REMOVE_RE.test((el.textContent || "").trim())) removeBtns.push(el);
    });

    // Para cada botão Remover, sobe até a LINHA COMPLETA do item: o maior
    // ancestral que ainda contém APENAS este botão Remover. Assim a linha
    // engloba o cabeçalho (com o link /bundle/) e não só a área dos /app/.
    for (const btn of removeBtns) {
      let row = btn.parentElement;
      let p = btn.parentElement;
      for (let i = 0; i < 12 && p; i++, p = p.parentElement) {
        // conta quantos botões Remover existem dentro de p
        const nRemove = [...p.querySelectorAll("button, a, span, div, [role='button']")]
          .filter((e) => e.children.length === 0 && REMOVE_RE.test((e.textContent || "").trim()))
          .length;
        if (nRemove > 1) break;            // passou do limite: p já engloba outro item
        if (p.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]')) {
          row = p;                          // p ainda é só deste item e tem link -> candidato
        }
      }
      if (row && !seenRows.has(row)) {
        seenRows.add(row);
        entries.push({ row, removeBtn: btn });
      }
    }

    // Descarta linhas ANINHADAS (uma contida na outra pelo DOM).
    entries = entries.filter(
      (a) => !entries.some((b) => b.row !== a.row && b.row.contains(a.row))
    );

    // Anexa a cada entry o conjunto de appids e o bundleid que ela contém.
    const enriched = entries.map((e) => {
      const apps = new Set(
        [...e.row.querySelectorAll('a[href*="/app/"]')]
          .map((a) => a.href.match(/\/app\/(\d+)/)?.[1])
          .filter(Boolean)
      );
      const bundleid = e.row
        .querySelector('a[href*="/bundle/"]')
        ?.href.match(/\/bundle\/(\d+)/)?.[1] || null;
      return { ...e, apps, bundleid };
    });

    // Descarta SUB-LINHAS DE BUNDLE. Um bundle tem dois botões "Remover":
    // o do pacote (a linha externa, que vê o /bundle/ e lista os apps) e o
    // do item interno "Inclui 1 item: X" (uma sub-área que NÃO vê o /bundle/
    // e por isso é confundida com um jogo avulso). Essa sub-linha tem os
    // MESMOS apps de um bundle presente. Regra: se uma linha não é bundle e
    // todos os seus apps já estão em algum bundle, ela é interna — descartar.
    const bundles = enriched.filter((e) => e.bundleid);
    const filtered = enriched.filter((e) => {
      if (e.bundleid) return true; // a própria linha do pacote fica
      if (e.apps.size === 0) return true;
      const dentroDeBundle = bundles.some(
        (b) => b !== e && [...e.apps].every((id) => b.apps.has(id))
      );
      return !dentroDeBundle;
    });

    // De-duplica por KEY como rede final.
    const byKey = new Map();
    for (const e of filtered) {
      const k = parseItem(e.row).key;
      if (!byKey.has(k)) byKey.set(k, e);
    }
    const result = [...byKey.values()];

    if (window.CU_DEBUG) {
      console.log("[SteamCartSelector] entries:", entries.length,
        "bundles:", bundles.length, "final:", result.length);
    }
    return result;
  }

  function findCartItems() {
    return findCartEntries().map((e) => e.row);
  }

  /* ---------------- extrair identificadores do item ----------------
   * Precisamos de packageid ou bundleid para poder readicionar.
   * Estratégias, da mais confiável para a menos:
   *   1. atributos data-* no elemento (data-packageid, etc.)
   *   2. links /sub/<id> (sub = package) ou /bundle/<id>
   *   3. link /app/<id> como último recurso (guardamos como appid;
   *      a Steam às vezes aceita, mas o ideal é sub/bundle)
   * -------------------------------------------------------------- */
  function parseItem(item) {
    let packageid = null, bundleid = null, appid = null, url = null, name = "";

    // 1) data attributes (varre o item e filhos)
    const withData = item.matches?.("[data-packageid],[data-bundleid]")
      ? item
      : item.querySelector("[data-packageid],[data-bundleid]");
    if (withData) {
      packageid = withData.getAttribute("data-packageid") || null;
      bundleid = withData.getAttribute("data-bundleid") || null;
    }

    // 2) links.
    // IMPORTANTE: uma linha de bundle/pacote pode conter links /app/ dos
    // jogos que a compõem. Nesse caso o item É o pacote inteiro — devemos
    // usar o bundleid/packageid e IGNORAR os /app/ internos, para manter o
    // pacote junto (nunca comprar/restaurar só um jogo de dentro dele).
    const subLink = item.querySelector('a[href*="/sub/"]');
    const bundleLink = item.querySelector('a[href*="/bundle/"]');
    const appLink = item.querySelector('a[href*="/app/"]');

    if (!packageid && subLink) {
      packageid = subLink.href.match(/\/sub\/(\d+)/)?.[1] || null;
    }
    if (!bundleid && bundleLink) {
      bundleid = bundleLink.href.match(/\/bundle\/(\d+)/)?.[1] || null;
    }

    const isBundleRow = !!(bundleid || packageid);
    if (appLink && !isBundleRow) {
      // só tratamos como jogo avulso se a linha NÃO é um pacote
      appid = appLink.href.match(/\/app\/(\d+)/)?.[1] || null;
      url = appLink.href;
    }

    url = url || bundleLink?.href || subLink?.href || appLink?.href || null;
    // nome: para bundle, o próprio link do bundle costuma ter o título
    name = (
      (isBundleRow ? bundleLink?.textContent : appLink?.textContent) ||
      item.textContent || ""
    ).trim().slice(0, 80).replace(/\s+/g, " ");

    const key = packageid ? `p-${packageid}`
              : bundleid ? `b-${bundleid}`
              : appid ? `a-${appid}`
              : name;

    return { packageid, bundleid, appid, url, name, key };
  }

  /* ---------------- checkboxes ---------------- */

  function decorate(item) {
    if (item.getAttribute(MARK_ATTR)) return;

    const info = parseItem(item);

    // Rede de segurança: se já existe um item decorado com esta key (ex.:
    // pacote reencontrado após um re-render do React em outro elemento),
    // não cria um 2º checkbox.
    const already = [...document.querySelectorAll("[data-scs-key]")]
      .some((el) => el !== item && el.getAttribute("data-scs-key") === info.key);
    item.setAttribute(MARK_ATTR, "1");
    if (already) return;

    item.setAttribute("data-scs-key", info.key);
    item.classList.add("scs-item");

    const wrap = document.createElement("label");
    wrap.className = "scs-checkbox";
    wrap.title = "Marcado = comprar agora. Desmarcado = removido ao pagar.";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !unchecked.has(info.key);

    box.addEventListener("change", () => {
      if (box.checked) {
        unchecked.delete(info.key);
        item.classList.remove("scs-excluded");
      } else {
        unchecked.add(info.key);
        item.classList.add("scs-excluded");
      }
      save(EXCLUDE_KEY, [...unchecked]);
      updateToolbar();
    });

    wrap.appendChild(box);
    item.insertBefore(wrap, item.firstChild);
    if (unchecked.has(info.key)) item.classList.add("scs-excluded");
  }

  /* ---------------- remover desmarcados (no pagamento) ---------------- */

  let processing = false;

  async function removeUncheckedAndProceed(proceedFn) {
    if (processing) return;
    processing = true;

    const toRemove = [];
    for (const { row, removeBtn } of findCartEntries()) {
      const info = parseItem(row);
      if (unchecked.has(info.key)) toRemove.push({ info, item: row, removeBtn });
    }

    if (!toRemove.length) { processing = false; proceedFn?.(); return; }

    // salva os removidos (merge por key, sem duplicar)
    const prev = load(STORAGE_KEY, []);
    const byKey = new Map(prev.map((r) => [r.key, r]));
    for (const { info } of toRemove) {
      // só guardamos o que dá pra readicionar: packageid ou bundleid
      byKey.set(info.key, {
        key: info.key,
        packageid: info.packageid,
        bundleid: info.bundleid,
        appid: info.appid,
        name: info.name,
        url: info.url,
      });
    }
    save(STORAGE_KEY, [...byKey.values()]);

    // clica no botão "Remover" real de cada item (já localizado)
    for (const { removeBtn, info } of toRemove) {
      if (removeBtn) {
        removeBtn.click();
        await new Promise((r) => setTimeout(r, 450));
      } else {
        console.warn("[SteamCartSelector] remover não encontrado:", info.name);
      }
    }

    unchecked.clear();
    save(EXCLUDE_KEY, []);
    processing = false;

    await new Promise((r) => setTimeout(r, 500));
    proceedFn?.();
  }

  /* ---------------- restaurar (API real, sem abas) ---------------- */

  async function restoreCart(ev) {
    // Só restaura por um clique HUMANO real no botão. Cliques sintéticos
    // ou disparos programáticos (re-render, foco automático da Steam ao
    // voltar do pagamento) têm isTrusted=false e são ignorados. Isso impede
    // o restaurar de rodar sozinho ao voltar da tela de pagamento.
    if (!ev || ev.isTrusted !== true) {
      if (window.CU_DEBUG) console.log("[SteamCartSelector] restore ignorado (não foi clique humano)", ev);
      return;
    }

    const removed = load(STORAGE_KEY, []);
    if (!removed.length) { alert("SteamCartSelector: nada para restaurar."); return; }

    if (window.CU_DEBUG) {
      console.log("[SteamCartSelector] restaurar: removidos =", removed,
        "| steamcart?", !!window.SteamCartSelector);
    }

    // Monta a lista para a API. packageid/bundleid vão direto; quando só
    // temos appid, convertemos para packageid via appdetails.
    const apiItems = [];
    const fallback = [];
    for (const r of removed) {
      if (r.packageid) {
        apiItems.push({ packageid: r.packageid });
      } else if (r.bundleid) {
        apiItems.push({ bundleid: r.bundleid });
      } else if (r.appid && window.SteamCartSelector) {
        const pkg = await window.SteamCartSelector.appidToPackageid(r.appid);
        if (window.CU_DEBUG) console.log("[SteamCartSelector] appid", r.appid, "-> packageid", pkg);
        if (pkg) apiItems.push({ packageid: pkg });
        else fallback.push(r); // sem pacote encontrado -> abre a página
      } else {
        fallback.push(r);
      }
    }
    if (window.CU_DEBUG) console.log("[SteamCartSelector] apiItems =", apiItems, "| fallback =", fallback);

    let okApi = false;
    if (apiItems.length && window.SteamCartSelector) {
      try {
        const res = await window.SteamCartSelector.addItems(apiItems);
        okApi = res.ok;
        if (!res.ok) {
          console.warn("[SteamCartSelector] AddItemsToCart falhou:", res);
          alert(
            "SteamCartSelector: a Steam recusou o restaurar (EResult " +
            res.eresult + "). Seu token pode ter expirado — recarregue a página logada."
          );
        }
      } catch (e) {
        console.error("[SteamCartSelector]", e);
        alert("SteamCartSelector: erro ao restaurar — " + e.message);
      }
    }

    // itens sem packageid/bundleid: abre a página pro usuário adicionar
    fallback.forEach((r, i) => {
      if (r.url) setTimeout(() => window.open(r.url, "_blank"), i * 250);
    });

    if (okApi || fallback.length) {
      save(STORAGE_KEY, []);
      // recarrega o carrinho pra mostrar os itens de volta
      setTimeout(() => location.reload(), 800);
    }
  }

  /* ---------------- barra de ferramentas ---------------- */

  function updateToolbar() {
    updateEstimatedTotal(); // mantém o total sincronizado com as seleções

    let bar = document.getElementById("scs-toolbar");
    const removed = load(STORAGE_KEY, []);

    if (!bar) {
      bar = document.createElement("div");
      bar.id = "scs-toolbar";
      const anchor = findCartItems()[0];
      const parent = anchor?.parentElement || document.body;
      parent.insertBefore(bar, parent.firstChild);
    }

    const infoText = unchecked.size > 0
      ? `${unchecked.size} desmarcado(s) — serão removidos ao pagar.`
      : "Desmarque o que não quer comprar agora.";

    // Assinatura do estado atual. Só reconstruímos a toolbar quando algo
    // muda de verdade — NUNCA a cada scan. Reconstruir via innerHTML a cada
    // passada destruía o botão Restaurar no meio do clique (por isso não
    // clicava). Com a guarda, o botão persiste e o clique funciona.
    const sig = `${infoText}||${removed.length}`;
    if (bar.dataset.cuSig === sig) return;
    bar.dataset.cuSig = sig;

    // (re)constrói o conteúdo apenas quando a assinatura mudou
    bar.textContent = "";

    const brand = document.createElement("span");
    brand.className = "cu-brand";
    brand.textContent = "SteamCartSelector";
    bar.appendChild(brand);

    const info = document.createElement("span");
    info.className = "cu-info";
    info.textContent = infoText;
    bar.appendChild(info);

    if (removed.length > 0) {
      const btn = document.createElement("button");
      btn.id = "cu-restore";
      btn.className = "cu-btn cu-restore";
      btn.textContent = `↺ Restaurar carrinho (${removed.length})`;
      btn.addEventListener("click", restoreCart);
      bar.appendChild(btn);
    }
  }

  /* ---------------- interceptar pagamento ---------------- */

  function isCheckoutButton(el) {
    if (!el) return false;
    const t = (el.textContent || "").trim().toLowerCase();
    const href = (el.getAttribute?.("href") || "").toLowerCase();
    return (
      /continuar para o pagamento|continue to payment|comprar para mim|purchase for myself|comprar agora|checkout/.test(t) ||
      href.includes("/checkout")
    );
  }

  function installCheckoutInterceptor() {
    document.addEventListener("click", (e) => {
      if (processing || unchecked.size === 0) return;
      let el = e.target;
      for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        if (
          (el.tagName === "BUTTON" || el.tagName === "A" ||
            el.getAttribute?.("role") === "button") &&
          isCheckoutButton(el)
        ) {
          e.preventDefault();
          e.stopPropagation();
          const target = el;
          removeUncheckedAndProceed(() => target.click());
          return;
        }
      }
    }, true);
  }

  /* ---------------- total estimado (só marcados) ---------------- */

  // "R$1.299,90" -> 1299.90 ; "Grátis"/"Free" -> 0 ; sem preço -> null
  function parseBRL(text) {
    if (!text) return null;
    if (/gr[aá]tis|free/i.test(text)) return 0;
    const m = text.match(/R\$\s?([\d.]*\d),(\d{2})/);
    if (!m) return null;
    return parseFloat(m[1].replace(/\./g, "") + "." + m[2]);
  }

  function formatBRL(v) {
    return "R$" + v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  // Preço de uma linha = ÚLTIMO valor "R$" encontrado (o com desconto,
  // quando há preço cheio riscado + preço promocional).
  function priceOfRow(row) {
    const precos = [...row.querySelectorAll("*")]
      .filter((el) => el.children.length === 0 && /R\$\s?[\d.,]+/.test(el.textContent))
      .map((el) => parseBRL(el.textContent))
      .filter((v) => v != null);
    if (precos.length) return precos[precos.length - 1];
    // se não achou R$ mas o texto diz grátis
    if (/gr[aá]tis|free/i.test(row.textContent)) return 0;
    return null;
  }

  const TOTAL_SELECTOR = "._2WLaY5TxjBGVyuWe_6KS3N";

  function updateEstimatedTotal() {
    // A Steam tem MAIS DE UM elemento com essa classe de total (um oculto/
    // resumo e o visível). querySelector pegava só o primeiro — por isso o
    // total que o usuário vê não mudava. Atualizamos TODOS.
    const totals = document.querySelectorAll(TOTAL_SELECTOR);
    if (!totals.length) return;

    // se nada desmarcado, restaura cada total ao original guardado
    if (unchecked.size === 0) {
      totals.forEach((el) => {
        if (el.dataset.cuOriginal != null) {
          el.textContent = el.dataset.cuOriginal;
          el.classList.remove("scs-total-mod");
        }
      });
      return;
    }

    // soma os preços das linhas MARCADAS (uma vez só)
    let soma = 0;
    let algumSemPreco = false;
    for (const row of findCartItems()) {
      const info = parseItem(row);
      if (unchecked.has(info.key)) continue; // desmarcado não conta
      const p = priceOfRow(row);
      if (p == null) algumSemPreco = true;
      else soma += p;
    }
    const novoTexto = formatBRL(soma) + (algumSemPreco ? " *" : "");

    totals.forEach((el) => {
      // guarda o original de cada elemento na 1ª vez, ANTES de sobrescrever
      if (el.dataset.cuOriginal == null) {
        el.dataset.cuOriginal = el.textContent.trim();
      }
      el.textContent = novoTexto;
      el.classList.add("scs-total-mod");
      el.title = "SteamCartSelector: total apenas dos itens marcados" +
        (algumSemPreco ? " (* algum item sem preço legível)" : "");
    });
  }

  /* ---------------- loop principal ---------------- */

  function scan() {
    const items = findCartItems();
    const validSet = new Set(items);

    // Remove checkboxes ÓRFÃOS: de scans anteriores ou de elementos que
    // não são mais itens válidos (ex.: sub-linhas de bundle que antes
    // recebiam checkbox). Garante 1 checkbox por item real.
    document.querySelectorAll("[data-scs-key]").forEach((el) => {
      if (!validSet.has(el)) {
        el.querySelectorAll?.(":scope > .scs-checkbox").forEach((c) => c.remove());
        el.removeAttribute("data-scs-key");
        el.removeAttribute(MARK_ATTR);
        el.classList.remove("scs-item", "scs-excluded");
      }
    });

    items.forEach(decorate);
    updateToolbar();
  }

  let pending = false;
  function scheduleScan() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; scan(); });
  }

  function start() {
    installCheckoutInterceptor();
    scan();
    new MutationObserver(scheduleScan).observe(document.body, {
      childList: true, subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
