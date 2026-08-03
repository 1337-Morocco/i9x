# i9x frontend

The browser desktop: React 19 + TypeScript on Vite.

Run it from the repository root — this is an npm workspace, so there is no
separate install here:

```bash
npm ci          # at the root, installs both workspaces
npm run dev     # :5173, proxies /api and /ws to the backend on :3001
```

## Layout

| Path | What lives there |
|---|---|
| `src/desktop/` | window manager — `Window`, `Desktop`, dock, launchpad, theme, wallpaper |
| `src/apps/` | one component per service (Files, Databases, Domains, …) |
| `src/api/` | one typed client per backend route group |
| `src/App.css` | every style in the app, in one sheet |
| `public/icons/` | Papirus SVGs, served as `/icons/<name>.svg` |

Adding an app means: a component in `src/apps/`, an entry in `APP_META` in
`src/desktop/Desktop.tsx`, and an id in `src/desktop/types.ts`. `APP_META` also
decides whether it opens maximized and whether it draws its own chrome.

## Notes

- **No webfonts.** i9x runs on servers with no outbound internet, so a CDN font
  would simply fail to load. Styling uses system font stacks.
- **`App.css` is a single ~3000-line sheet** with no design tokens. Splitting it
  is worthwhile, but every class is global today — check usage across
  `src/apps/` before renaming anything.
- Chromeless windows (Files, Terminal) render their own title bar and window
  controls; everything else gets the shared chrome from `Window.tsx`.

See [`../docs/architecture.md`](../docs/architecture.md) for how the frontend
relates to the backend, and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) before
opening a pull request.
