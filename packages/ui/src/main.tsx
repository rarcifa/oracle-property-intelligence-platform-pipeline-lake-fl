/**
 * Browser entry point.
 *
 * `StrictMode` is deliberately not used here. Its development-only double
 * mount would boot two DuckDB-WASM workers and start two range-read sessions
 * against the IPFS gateway on every reload, which makes the one feature this
 * app is built to demonstrate harder to observe rather than easier.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DataSourceProvider } from "./data/DataSourceProvider.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error('index.html is missing <div id="root">');
}

createRoot(container).render(
  <DataSourceProvider>
    <App />
  </DataSourceProvider>,
);
