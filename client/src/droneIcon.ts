const DRONE_SVG = `
<svg width="34" height="34" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <g stroke="#0f172a" stroke-width="1">
    <line x1="16" y1="16" x2="7" y2="7" stroke="#1e293b" stroke-width="2" />
    <line x1="16" y1="16" x2="25" y2="7" stroke="#1e293b" stroke-width="2" />
    <line x1="16" y1="16" x2="7" y2="25" stroke="#1e293b" stroke-width="2" />
    <line x1="16" y1="16" x2="25" y2="25" stroke="#1e293b" stroke-width="2" />
    <circle cx="7" cy="7" r="4" fill="#334155" />
    <circle cx="25" cy="7" r="4" fill="#334155" />
    <circle cx="7" cy="25" r="4" fill="#334155" />
    <circle cx="25" cy="25" r="4" fill="#334155" />
    <rect x="11" y="11" width="10" height="10" rx="3" fill="#38bdf8" />
    <polygon points="16,2 12,10 20,10" fill="#f87171" />
  </g>
</svg>`;

// maplibregl.Marker manages its own `transform` (translate) on the element
// passed to it, so rotation must live on a nested child instead of the root
// — otherwise setting `transform: rotate(...)` on the root would clobber the
// marker's positioning transform.
export function createDroneElement(): { root: HTMLDivElement; inner: HTMLDivElement } {
  const root = document.createElement("div");
  root.className = "drone-icon";
  const inner = document.createElement("div");
  inner.className = "drone-icon-inner";
  inner.innerHTML = DRONE_SVG;
  inner.style.willChange = "transform";
  root.appendChild(inner);
  return { root, inner };
}

/**
 * Yaws the icon to face `headingDeg` (screen-relative, i.e. already minus the
 * map's own bearing) and, in front of that, banks it around its own
 * longitudinal axis by `bankDeg` — the classic "leaning into the wind" look.
 * Order matters: rotateY (roll, in the icon's local frame) is applied first,
 * then rotateZ (yaw) turns the whole banked shape to face the heading.
 */
export function setDroneRotation(inner: HTMLDivElement, headingDeg: number, bankDeg = 0): void {
  inner.style.transform = `rotateZ(${headingDeg}deg) rotateY(${bankDeg}deg)`;
}

/** Same root/inner split as createDroneElement, for any other emoji-based marker that needs to rotate. */
export function createEmojiElement(emoji: string, className: string): { root: HTMLDivElement; inner: HTMLDivElement } {
  const root = document.createElement("div");
  root.className = className;
  const inner = document.createElement("div");
  inner.className = `${className}-inner`;
  inner.textContent = emoji;
  root.appendChild(inner);
  return { root, inner };
}

export function setElementRotation(inner: HTMLDivElement, headingDeg: number): void {
  inner.style.transform = `rotate(${headingDeg}deg)`;
}
