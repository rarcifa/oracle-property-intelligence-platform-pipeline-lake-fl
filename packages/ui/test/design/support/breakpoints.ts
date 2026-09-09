/**
 * The breakpoint matrix every design spec loops over.
 *
 * Each entry carries the layout the stylesheet is meant to produce at that
 * width, so the specs read their expectations from here instead of scattering
 * pixel literals through the assertions. The two widths that matter most are
 * the ones either side of the stylesheet's own media queries: 1080px, where the
 * search rail stops being a column, and 720px, where the shell tightens.
 */

export interface Breakpoint {
  /** Test-name suffix; also the label used in failure messages. */
  name: string;
  viewport: { width: number; height: number };
  shell: {
    /** `.app-main` padding at this width. */
    mainPadding: string;
    /** `.header-inner` horizontal padding at this width. */
    headerPadding: string;
    /** Whether the seven tabs are expected to need their own scroller. */
    tabsScroll: boolean;
  };
  search: {
    /** `single` below the 1080px query, `rail` above it. */
    layout: "single" | "rail";
    /** The "Hide filters" control only exists in the collapsed layout. */
    railToggleVisible: boolean;
    /** Columns in the rail's paired number fields. */
    pairColumns: number;
    /** `.map-shell` height at this width. */
    mapHeight: number;
  };
  tiles: {
    /** Track count of `.tile-grid`, as a tolerated range. */
    columns: { min: number; max: number };
    /** `.tile-value` font size at this width. */
    valueSize: string;
  };
  /** Track count of `.grid-2` (the two-up chart/panel rows). */
  gridTwoColumns: { min: number; max: number };
  /** Minimum hit target for a primary control, in CSS pixels. */
  minControlSize: number;
}

export const BREAKPOINTS: readonly Breakpoint[] = [
  {
    name: "Mobile",
    viewport: { width: 390, height: 844 },
    shell: { mainPadding: "14px", headerPadding: "14px", tabsScroll: true },
    search: { layout: "single", railToggleVisible: true, pairColumns: 1, mapHeight: 280 },
    tiles: { columns: { min: 1, max: 1 }, valueSize: "19px" },
    gridTwoColumns: { min: 1, max: 1 },
    minControlSize: 24,
  },
  {
    name: "Tablet",
    viewport: { width: 820, height: 1180 },
    shell: { mainPadding: "20px", headerPadding: "20px", tabsScroll: false },
    search: { layout: "single", railToggleVisible: true, pairColumns: 2, mapHeight: 360 },
    tiles: { columns: { min: 3, max: 4 }, valueSize: "22px" },
    gridTwoColumns: { min: 2, max: 2 },
    minControlSize: 24,
  },
  {
    name: "Laptop",
    viewport: { width: 1280, height: 800 },
    shell: { mainPadding: "20px", headerPadding: "20px", tabsScroll: false },
    search: { layout: "rail", railToggleVisible: false, pairColumns: 2, mapHeight: 360 },
    tiles: { columns: { min: 5, max: 6 }, valueSize: "22px" },
    gridTwoColumns: { min: 2, max: 2 },
    minControlSize: 24,
  },
  {
    name: "Desktop",
    viewport: { width: 1440, height: 900 },
    shell: { mainPadding: "20px", headerPadding: "20px", tabsScroll: false },
    search: { layout: "rail", railToggleVisible: false, pairColumns: 2, mapHeight: 360 },
    tiles: { columns: { min: 6, max: 7 }, valueSize: "22px" },
    gridTwoColumns: { min: 2, max: 2 },
    minControlSize: 24,
  },
];
