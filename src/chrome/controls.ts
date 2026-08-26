/**
 * VIRO Press — native form-chrome eradication (JS half).
 *
 * The desk must show zero operating-system widgets. Ranges and checkboxes are
 * entirely a CSS job (`appearance: none` in styles/desk.css). Two things CSS
 * cannot do are handled here:
 *
 *  1. **The <select> popup.** CSS can repaint a closed <select> but not the
 *     list the OS pops open. So we suppress that list at the input layer and
 *     draw our own `.cbx-pop` listbox instead.
 *
 *     Critically the real <select> is left in the document, in place, enabled
 *     and focusable, still painting its own selected-option text. Nothing is
 *     hidden, cloned or mirrored — so `#blend`, `#stat-zoom`, `#opt-fit` and
 *     friends keep their ids, `.value`, `disabled` state and `change` wiring
 *     exactly as desk.ts wrote them, and the visible label can never drift
 *     from the value even when desk.ts assigns it programmatically. The popup
 *     reads `select.options` at open time, so runtime-populated lists (the
 *     blend modes, the live zoom row) are always current.
 *
 *  2. **Live gradient tracks for the R/G/B sliders.** Photoshop paints the R
 *     slider from rgb(0,G,B) to rgb(255,G,B) at the current G and B. We push
 *     that pair onto the element as `--track-a` / `--track-b`; the CSS paints
 *     the gradient behind the groove.
 *
 * Self-initialising: nothing in desk.ts has to know this file exists.
 */

const POP_CLASS = "cbx-pop";
const OPT_CLASS = "cbx-opt";

interface Popup {
  select: HTMLSelectElement;
  root: HTMLDivElement;
  rows: HTMLDivElement[];
  active: number;
}

let popup: Popup | null = null;

/* ── Combo box ───────────────────────────────────────────────────────────── */

function selectableRows(select: HTMLSelectElement): HTMLOptionElement[] {
  return Array.from(select.options);
}

function closePopup(restoreFocus = false): void {
  if (!popup) return;
  const { select, root } = popup;
  popup = null;
  root.remove();
  select.classList.remove("is-open");
  select.removeAttribute("aria-expanded");
  if (restoreFocus) select.focus();
}

function setActive(next: number): void {
  if (!popup) return;
  const max = popup.rows.length - 1;
  if (max < 0) return;
  const i = Math.max(0, Math.min(max, next));
  popup.rows[popup.active]?.classList.remove("is-active");
  popup.active = i;
  const row = popup.rows[i];
  if (!row) return;
  row.classList.add("is-active");
  row.scrollIntoView({ block: "nearest" });
}

/** Write the choice back through the real element so existing wiring fires. */
function commit(index: number): void {
  if (!popup) return;
  const { select } = popup;
  const options = selectableRows(select);
  const option = options[index];
  closePopup(true);
  if (!option || option.disabled) return;
  if (select.selectedIndex === index) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Rebuild the list from the element's *current* options and place it. */
function refresh(select: HTMLSelectElement, root: HTMLDivElement): HTMLDivElement[] {
  root.textContent = "";
  const rows: HTMLDivElement[] = [];
  const options = selectableRows(select);

  options.forEach((option, i) => {
    const row = document.createElement("div");
    row.className = OPT_CLASS;
    row.setAttribute("role", "option");
    row.dataset.index = String(i);
    row.textContent = option.textContent ?? option.value;
    row.title = option.textContent ?? option.value;
    if (i === select.selectedIndex) {
      row.classList.add("is-on");
      row.setAttribute("aria-selected", "true");
    }
    if (option.disabled) row.classList.add("is-disabled");
    root.appendChild(row);
    rows.push(row);
  });

  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = `${OPT_CLASS} is-disabled`;
    empty.textContent = "—";
    root.appendChild(empty);
  }

  const box = select.getBoundingClientRect();
  root.style.minWidth = `${Math.round(box.width)}px`;
  root.style.left = "0px";
  root.style.top = "0px";

  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const left = Math.max(4, Math.min(box.left, window.innerWidth - width - 4));
  let top = box.bottom + 1;
  if (top + height > window.innerHeight - 4) {
    top = box.top - height - 1;
    if (top < 4) top = Math.max(4, window.innerHeight - height - 4);
  }
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  return rows;
}

function openPopup(select: HTMLSelectElement): void {
  if (popup?.select === select) {
    closePopup(true);
    return;
  }
  closePopup();
  if (select.disabled) return;

  const root = document.createElement("div");
  root.className = POP_CLASS;
  root.setAttribute("role", "listbox");
  document.body.appendChild(root);

  const rows = refresh(select, root);
  popup = { select, root, rows, active: -1 };
  select.classList.add("is-open");
  select.setAttribute("aria-expanded", "true");
  setActive(select.selectedIndex >= 0 ? select.selectedIndex : 0);

  root.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLDivElement>(`.${OPT_CLASS}`);
    if (row?.dataset.index) setActive(Number(row.dataset.index));
  });
  // mouseup, not click: this also catches the press-drag-release gesture a
  // native combo supports, where mousedown landed on the <select> itself.
  root.addEventListener("mouseup", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLDivElement>(`.${OPT_CLASS}`);
    if (row?.dataset.index) commit(Number(row.dataset.index));
  });
}

function isOpenKey(e: KeyboardEvent): boolean {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar" || e.key === "F4") return true;
  return e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
}

function bindCombos(): void {
  // Capture phase: the native list opens on mousedown, so it has to be killed
  // before the default action rather than after it.
  document.addEventListener(
    "mousedown",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (popup && popup.root.contains(target)) {
        e.preventDefault(); // keep focus on the select while choosing
        return;
      }
      const select = target.closest?.("select");
      if (select instanceof HTMLSelectElement) {
        e.preventDefault();
        if (select.disabled) return;
        select.focus();
        openPopup(select);
        return;
      }
      if (popup) closePopup();
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (popup) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            e.stopPropagation();
            closePopup(true);
            return;
          case "ArrowDown":
            e.preventDefault();
            setActive(popup.active + 1);
            return;
          case "ArrowUp":
            e.preventDefault();
            setActive(popup.active - 1);
            return;
          case "Home":
            e.preventDefault();
            setActive(0);
            return;
          case "End":
            e.preventDefault();
            setActive(popup.rows.length - 1);
            return;
          case "Enter":
          case " ":
          case "Spacebar":
          case "Tab":
            e.preventDefault();
            commit(popup.active);
            return;
          default:
            return;
        }
      }
      const target = e.target;
      if (!(target instanceof HTMLSelectElement) || target.disabled) return;
      if (isOpenKey(e)) {
        e.preventDefault();
        openPopup(target);
      }
    },
    true,
  );

  // A popup is positioned in viewport coordinates; anything that moves its
  // anchor invalidates it. Photoshop dismisses too, so dismiss.
  window.addEventListener("resize", () => closePopup());
  window.addEventListener("scroll", () => closePopup(), true);
  window.addEventListener("blur", () => closePopup());
  document.addEventListener(
    "focusin",
    (e) => {
      if (!popup) return;
      const t = e.target as Node | null;
      if (t && (popup.select === t || popup.root.contains(t))) return;
      closePopup();
    },
    true,
  );
}

/* ── Live R/G/B gradient tracks ──────────────────────────────────────────── */

const RGB_IDS = ["rgb-r", "rgb-g", "rgb-b"] as const;
let lastTrack = "";

function paintRgbTracks(): void {
  const nodes = RGB_IDS.map((id) => document.getElementById(id));
  const [r, g, b] = nodes.map((n) =>
    n instanceof HTMLInputElement ? Math.round(Number(n.value) || 0) : 0,
  ) as [number, number, number];

  const key = `${r},${g},${b}`;
  if (key === lastTrack) return;
  lastTrack = key;

  const ends: [string, string][] = [
    [`rgb(0,${g},${b})`, `rgb(255,${g},${b})`],
    [`rgb(${r},0,${b})`, `rgb(${r},255,${b})`],
    [`rgb(${r},${g},0)`, `rgb(${r},${g},255)`],
  ];

  nodes.forEach((node, i) => {
    if (!(node instanceof HTMLInputElement)) return;
    const pair = ends[i];
    if (!pair) return;
    node.style.setProperty("--track-a", pair[0]);
    node.style.setProperty("--track-b", pair[1]);
  });
}

/** desk.ts writes `.value` on these sliders directly during render, which
 *  fires no event, so a frame poll is the only honest way to stay in step.
 *  Three number reads per frame; it also covers the live drag for free. */
function bindTracks(): void {
  const tick = (): void => {
    paintRgbTracks();
    requestAnimationFrame(tick);
  };
  for (const id of RGB_IDS) {
    document.getElementById(id)?.addEventListener("input", paintRgbTracks);
  }
  paintRgbTracks();
  requestAnimationFrame(tick);
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

let started = false;

export function mountControls(): void {
  if (started) return;
  started = true;
  bindCombos();
  bindTracks();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountControls(), { once: true });
  } else {
    mountControls();
  }
}
