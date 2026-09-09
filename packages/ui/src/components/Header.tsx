/**
 * Application header: county identity, the published run, the data-mode pill
 * and the tab navigation.
 *
 * The run id and root CID are rendered in monospace and copy on click, because
 * they are the two values a reviewer needs in order to verify the dataset
 * independently of this app.
 */

import { useEffect, useRef } from "react";
import { COUNTY } from "@oracle-lake/shared";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useCopy } from "../hooks/useCopy.js";
import { navigate } from "../hooks/useHashRoute.js";
import { shortCid } from "../lib/format.js";
import { ModePill } from "./ModePill.js";
import { Skeleton } from "./Primitives.js";

interface Tab {
  path: string;
  label: string;
}

const TABS: readonly Tab[] = [
  { path: "/overview", label: "Overview" },
  { path: "/search", label: "Search" },
  { path: "/tenant", label: "Tenant" },
  { path: "/business", label: "Business" },
  { path: "/contractor", label: "Contractor" },
  { path: "/ask", label: "Ask" },
  { path: "/sql", label: "SQL console" },
];

export function Header({ activePath }: { activePath: string }): JSX.Element {
  const { meta } = useDataSource();
  const { copied, copy } = useCopy();
  const run = meta?.run ?? null;
  const activeTab = useRef<HTMLButtonElement | null>(null);

  // The tab strip scrolls horizontally when the seven views do not fit, which
  // on a phone means a deep link can land with its own tab parked off the end
  // of the strip. Bring it into the strip, without moving the page itself.
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activePath]);

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand">
          <div className="brand-title">
            <h1>Oracle Property Intelligence</h1>
            <span className="micro">
              {COUNTY.name} County, {COUNTY.stateCode} · FIPS {COUNTY.fips}
            </span>
          </div>
          <div className="brand-sub">
            {run ? (
              <>
                <button
                  type="button"
                  className="run-chip"
                  onClick={() => copy(run.runId)}
                  aria-label={`Copy run id ${run.runId}`}
                  title={run.runId}
                >
                  <span className="micro">run</span>
                  {run.runId}
                  <span className="dim">{copied === run.runId ? "copied" : "⧉"}</span>
                </button>
                <button
                  type="button"
                  className="run-chip"
                  onClick={() => copy(run.rootCid)}
                  aria-label={`Copy root CID ${run.rootCid}`}
                  title={run.rootCid}
                >
                  <span className="micro">root cid</span>
                  {shortCid(run.rootCid)}
                  <span className="dim">{copied === run.rootCid ? "copied" : "⧉"}</span>
                </button>
              </>
            ) : (
              <Skeleton width={280} height={20} radius={999} />
            )}
          </div>
        </div>

        <div className="header-right">
          <ModePill />
        </div>
      </div>

      <nav className="tabs" aria-label="Views">
        {TABS.map((tab) => {
          const active = activePath === tab.path || activePath.startsWith(`${tab.path}/`);
          return (
            <button
              key={tab.path}
              ref={active ? activeTab : undefined}
              type="button"
              className="tab"
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(tab.path)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
