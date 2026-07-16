/*
 * SteamCartSelector — a browser extension to selectively buy items from the Steam cart.
 * Copyright (C) 2026 Bruno Hoske
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */

/* ============================================================
 * SteamCartSelector — steamcart.js
 * Camada de acesso à API interna do carrinho novo da Steam.
 *
 * A Steam usa protobuf (não JSON) no corpo dos requests, enviado
 * como campo `input_protobuf_encoded` (base64) dentro de um
 * multipart/form-data. Como a mensagem é simples, montamos os
 * bytes protobuf à mão — sem depender de nenhuma biblioteca.
 *
 * Estrutura observada de AddItemsToCart (CAddItemsToCartRequest):
 *   field 1 (string)  = user_country            ex: "BR"
 *   field 2 (message) = item, repetido por item:
 *        field 1 (varint) = packageid   (para pacotes)
 *        field 1 alt      = bundleid    -> na verdade field 2 do item
 *   field 3 (message) = navdata (opcional, cosmético)
 *
 * Observação: no protobuf capturado, o item vinha em field 2 com
 * um sub-field 1 = packageid. Bundles usam bundleid. Tratamos os
 * dois casos.
 * ============================================================ */

(function () {
  "use strict";

  /* ---------------- codificação protobuf mínima ---------------- */

  function varint(n) {
    const out = [];
    n = n >>> 0; // trata como uint32 (ids cabem em 32 bits com folga)
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  }

  function tag(field, wire) {
    return varint((field << 3) | wire);
  }

  // campo string (wire 2)
  function fStr(field, str) {
    const bytes = new TextEncoder().encode(str);
    return [...tag(field, 2), ...varint(bytes.length), ...bytes];
  }

  // campo varint (wire 0)
  function fVarint(field, value) {
    return [...tag(field, 0), ...varint(value)];
  }

  // campo message embutido (wire 2)
  function fMsg(field, innerBytes) {
    return [...tag(field, 2), ...varint(innerBytes.length), ...innerBytes];
  }

  function toBase64(byteArr) {
    let bin = "";
    for (const b of byteArr) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  /* ---------------- montagem das mensagens ---------------- */

  // item: { packageid?, bundleid? } -> bytes da sub-mensagem
  function encodeItem(item) {
    const inner = [];
    if (item.packageid != null) inner.push(...fVarint(1, Number(item.packageid)));
    if (item.bundleid != null) inner.push(...fVarint(2, Number(item.bundleid)));
    return inner;
  }

  // CAddItemsToCartRequest
  function encodeAddItems(userCountry, items) {
    const msg = [];
    if (userCountry) msg.push(...fStr(1, userCountry));
    for (const it of items) {
      msg.push(...fMsg(2, encodeItem(it)));
    }
    return toBase64(msg);
  }

  /* ---------------- token + país da sessão ---------------- */

  function getUserConfig() {
    try {
      const el = document.querySelector("#application_config");
      const cfg = JSON.parse(el?.getAttribute("data-store_user_config") || "{}");
      return cfg;
    } catch {
      return {};
    }
  }

  function getAccessToken() {
    const cfg = getUserConfig();
    // nomes possíveis conforme versão da página
    return cfg.webapi_token || cfg.access_token || null;
  }

  function getUserCountry() {
    const cfg = getUserConfig();
    if (cfg.country_code) return cfg.country_code;
    // fallback: config global da loja
    try {
      const g = JSON.parse(
        document.querySelector("#application_config")?.getAttribute("data-config") || "{}"
      );
      if (g.COUNTRY) return g.COUNTRY;
    } catch {}
    return "US";
  }

  /* ---------------- chamada HTTP ---------------- */

  async function callService(iface, method, protobufB64) {
    const token = getAccessToken();
    if (!token) {
      throw new Error(
        "SteamCartSelector: não achei o access_token da sessão. Você está logado na Steam?"
      );
    }
    const url =
      `https://api.steampowered.com/${iface}/${method}/v1?access_token=` +
      encodeURIComponent(token);

    const form = new FormData();
    form.append("input_protobuf_encoded", protobufB64);

    // NÃO usar credentials:"include": o access_token já vai na URL, então
    // não precisamos enviar cookies. Com "include", o navegador exige que a
    // resposta traga Access-Control-Allow-Credentials: true — que a Steam
    // não manda — e bloqueia a leitura por CORS mesmo com HTTP 200 OK.
    const res = await fetch(url, {
      method: "POST",
      body: form,
    });

    const eresult = res.headers.get("x-eresult");
    // EResult 1 = OK. Qualquer outra coisa é erro.
    return {
      ok: res.ok && eresult === "1",
      eresult,
      status: res.status,
      errorMessage: res.headers.get("x-error_message") || "",
    };
  }

  /* ---------------- API pública ---------------- */

  /* ---------------- appid -> packageid ----------------
   * O carrinho só expõe appid nos links, mas AddItemsToCart precisa de
   * packageid. A API pública appdetails (sem login) devolve os pacotes:
   *   data[appid].package_groups[].subs[].packageid
   * Pegamos o primeiro sub do primeiro grupo (pacote padrão de compra).
   * -------------------------------------------------------------- */
  async function appidToPackageid(appid) {
    const cc = getUserCountry();
    // NÃO usar filters=package_groups: para vários jogos a Steam devolve
    // data:[] vazio com esse filtro (inconsistência da API). Sem filtro,
    // package_groups vem normalmente. Ex: appid 1895460 -> 682706.
    const url =
      `https://store.steampowered.com/api/appdetails?appids=${appid}` +
      `&cc=${encodeURIComponent(cc)}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      const json = await res.json();
      const data = json?.[appid]?.data;
      const sub = data?.package_groups?.[0]?.subs?.[0];
      return sub?.packageid ?? null;
    } catch (e) {
      console.warn("[SteamCartSelector] appdetails falhou para", appid, e);
      return null;
    }
  }

  window.SteamCartSelector = {
    // items: [{packageid} | {bundleid}]
    async addItems(items) {
      const country = getUserCountry();
      const b64 = encodeAddItems(country, items);
      return callService("IAccountCartService", "AddItemsToCart", b64);
    },
    appidToPackageid,
    getAccessToken,
    getUserCountry,
    // exposto para depuração
    _encodeAddItems: encodeAddItems,
  };

  if (window.CU_DEBUG) console.log("[SteamCartSelector] steamcart.js pronto");
})();
