/**
 * Application shell and route switch.
 *
 * Routing is a hash router (`useHashRoute`) rather than a router dependency:
 * the app is eight views deep, and a hash route also means the built SPA can be
 * served from any static host - including an IPFS gateway - without server-side
 * rewrites, which is the deployment story the mode pill describes.
 */

import { COUNTY } from "@oracle-lake/shared";
import { Header } from "./components/Header.js";
import { useDataSource } from "./data/DataSourceProvider.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { AskView } from "./views/AskView.js";
import { BusinessView } from "./views/BusinessView.js";
import { ContractorView } from "./views/ContractorView.js";
import { OverviewView } from "./views/OverviewView.js";
import { PropertyView } from "./views/PropertyView.js";
import { SearchView } from "./views/SearchView.js";
import { SqlConsoleView } from "./views/SqlConsoleView.js";
import { TenantView } from "./views/TenantView.js";

function renderRoute(segments: readonly string[]): JSX.Element {
  const head = segments[0] ?? "overview";
  switch (head) {
    case "search":
      return <SearchView />;
    case "property": {
      const parcelId = segments[1];
      if (!parcelId) return <SearchView />;
      return <PropertyView parcelId={parcelId} />;
    }
    case "tenant":
      return <TenantView />;
    case "business":
      return <BusinessView />;
    case "contractor":
      return <ContractorView />;
    case "ask":
      return <AskView />;
    case "sql":
      return <SqlConsoleView />;
    case "overview":
    default:
      return <OverviewView />;
  }
}

export function App(): JSX.Element {
  const route = useHashRoute();
  const { mode, source, meta } = useDataSource();

  return (
    <>
      <Header activePath={`/${route.segments[0] ?? "overview"}`} />
      <main className="app-main">{renderRoute(route.segments)}</main>
      <footer className="app-footer">
        <div className="inner stack-sm">
          <span>
            {COUNTY.name} County, {COUNTY.stateCode} property intelligence · every figure on this
            site is a query against the published run, computed{" "}
            {mode === "browser" ? "in your browser" : "on the server"}.
          </span>
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {source.dataSource}
          </span>
          {meta?.coverage ? (
            <span>
              Coverage snapshot {meta.coverage.schemaVersion} exported {meta.coverage.exportedAt}.
            </span>
          ) : null}
        </div>
      </footer>
    </>
  );
}
