/** shadcn themes switch on a `.dark` class; follow the OS preference live. */
export function syncColorScheme() {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", query.matches);
  apply();
  query.addEventListener("change", apply);
}
