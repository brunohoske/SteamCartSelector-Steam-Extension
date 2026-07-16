# SteamCartSelector

A lightweight browser extension that lets you **pick which items to buy from your Steam cart** — instead of being forced to purchase everything at once.

Add checkboxes to every item in your Steam cart, uncheck the ones you don't want right now, and buy only what's selected. The rest are safely set aside and can be brought back with a single click.

## Why?

Steam's cart is all-or-nothing: when you hit checkout, it charges for **everything** in the cart. If you have 10 games queued up but only want to buy 1 today, your only option is to manually delete the other 9 (and lose them). SteamCartSelector fixes that.

## Features

- ✅ **Per-item checkboxes** — select exactly what goes into this purchase
- 💰 **Live total** — the estimated total updates in real time to reflect only the checked items
- 🎁 **Bundle-aware** — bundles and package deals are treated as a single unit and always kept together
- 🛒 **Buy only what's selected** — on checkout, unchecked items are removed and saved to a separate list
- ↺ **One-click restore** — bring the removed items back to your cart instantly via Steam's own API (no tabs, no re-searching)
- 💾 **Persistent** — your set-aside list survives browser restarts, so you can restore later

## How it works

Because a browser extension can't tell Steam's servers to "charge only item X" (the cart state lives server-side), SteamCartSelector works with the cart the way Steam allows:

1. You **uncheck** the items you don't want to buy now.
2. On checkout, those items are **removed from the cart** and their IDs are stored locally.
3. You complete the purchase with only the checked items.
4. Back on the cart page, click **Restore cart** — the removed items are re-added in a single call to Steam's internal `IAccountCartService/AddItemsToCart` endpoint (authenticated with your own logged-in session token).

The restore list only ever contains items **this extension removed** — your wishlist and everything else are never touched.

## Installation

### Chrome / Edge / Brave

1. Download and unzip the extension.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the extension folder.
5. Open your cart: <https://store.steampowered.com/cart>

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select the `manifest.json` file.

## Project structure

| File            | Purpose                                                        |
|-----------------|---------------------------------------------------------------|
| `manifest.json` | Extension configuration (Manifest V3, runs in the MAIN world) |
| `content.js`    | Injects checkboxes, live total, checkout hook, restore button |
| `steamcart.js`  | Talks to Steam's internal cart API (protobuf encoder + fetch) |
| `content.css`   | Styling for checkboxes, toolbar, and modified total           |
| `popup.html`    | The panel shown when clicking the extension icon              |
| `icons/`        | 16 / 48 / 128 px icons                                         |

## Technical notes

- **No developer API key required.** The extension reads the `access_token` from your own logged-in Steam session (`#application_config` → `webapi_token`) — the same token Steam's own store pages use.
- **Protobuf, not JSON.** Steam's new cart API expects a protobuf-encoded body sent as `input_protobuf_encoded`. The encoder is hand-built in `steamcart.js` (no dependencies).
- **App ID → Package ID.** The cart DOM only exposes app IDs, but the add-to-cart API needs package IDs. These are resolved on the fly via the public `appdetails` endpoint.

## Disclaimer

This is an unofficial extension and is not affiliated with, endorsed by, or connected to Valve or Steam. It relies on Steam's internal, undocumented cart API, which may change at any time and break the restore feature (the rest keeps working). Use at your own discretion.

## Contributing

Contributions are welcome! Feel free to open an issue or a pull request. Since Steam's cart layout and internal API can change, help keeping the DOM selectors and endpoints up to date is especially appreciated.

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

In short: you're free to use, study, share, and modify this software, but any distributed derivative work must also remain open source under the same license.

Copyright (C) 2026 Bruno Hoske
