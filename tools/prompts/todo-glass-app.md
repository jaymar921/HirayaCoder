You are an autonomous coding agent. Build a complete, working **TODO application** from scratch. Follow every instruction below in order. Do not stop until the app builds successfully and all features are verified working.

### 1. Tech Stack
- React (functional components + hooks only)
- Vite as the build tool
- Tailwind CSS for styling
- No backend — use in-memory React state (optionally persist to `localStorage`)
- No external UI/component libraries — build the glass UI with Tailwind utility classes only

### 2. Project Setup
1. Scaffold a new project with `npm create vite@latest todo-glass-app -- --template react`
2. Install and configure Tailwind CSS (latest stable version) for Vite
3. Install `lucide-react` for icons (lightweight, no extra deps needed)
4. Confirm `npm run dev` starts without errors before moving on

### 3. Folder Structure
Enforce this exact structure — do not flatten it or dump everything into `App.jsx`:

```
todo-glass-app/
├── public/
├── src/
│   ├── assets/
│   ├── components/
│   │   ├── TodoInput.jsx        # Add-todo form
│   │   ├── TodoItem.jsx         # Single todo row (edit/delete/toggle)
│   │   ├── TodoList.jsx         # Renders list of TodoItem
│   │   ├── TodoStats.jsx        # Counter (e.g. "3 of 5 remaining")
│   │   └── ClearButton.jsx      # Clear all / clear completed
│   ├── hooks/
│   │   └── useTodos.js          # All todo state logic (add/edit/delete/clear), localStorage sync
│   ├── App.jsx                  # Composes layout + components
│   ├── main.jsx
│   └── index.css                # Tailwind directives + custom glass utility classes
├── index.html
├── tailwind.config.js
├── postcss.config.js
├── vite.config.js
├── package.json
└── README.md
```

Keep logic out of components where possible — all todo CRUD operations live in the `useTodos` custom hook, components stay presentational.

### 4. Features (all required)
- **Add Todo**: text input + submit (Enter key and button both work); ignore empty/whitespace-only input
- **Delete Todo**: remove a single todo, with a subtle confirm-free instant delete + fade-out transition
- **Modify Todo**: inline edit — double-click or click an edit icon to turn the todo text into an editable field, save on Enter/blur, cancel on Escape; also support toggling complete/incomplete via a checkbox
- **Clear Todo(s)**: a "Clear Completed" button and a "Clear All" button (with a small confirmation state, e.g. click-to-confirm, to avoid accidental wipes)
- Show a live count of remaining/completed todos
- Empty state message when there are no todos

### 5. Design Requirements — "Glassy Blue"
- Overall theme: deep blue gradient background (e.g. `from-blue-950 via-blue-900 to-slate-900`)
- Card/panel elements use a glassmorphism style:
  - `bg-white/10` or `bg-blue-500/10`
  - `backdrop-blur-lg` or `backdrop-blur-xl`
  - `border border-white/20`
  - `shadow-xl shadow-blue-900/40`
  - `rounded-2xl`
- Accent color: blue/cyan (e.g. `blue-400`, `sky-400`) for buttons, focus rings, checkboxes, and completed-state highlights
- Subtle hover/active transitions (`transition-all duration-200`) on buttons and list items
- Add 1–2 soft floating blurred blue circles (`absolute`, `blur-3xl`, `opacity-30`) behind the glass card for depth
- Fully responsive: works cleanly from mobile width (375px) up to desktop
- Use a clean sans-serif font stack; completed todos get `line-through text-white/50`

### 6. README.md (required, at repo root)
Must include:
- Project title + one-line description
- Screenshot placeholder (`![screenshot](./screenshot.png)`)
- Tech stack list
- Features list
- Folder structure overview (can reuse the tree from section 3)
- Setup instructions:
  ```
  npm install
  npm run dev
  npm run build
  ```
- A short "Design" section explaining the glassmorphism/blue theme choice

### 7. Build Verification (mandatory — do not skip)
After implementation:
1. Run `npm run build` and confirm it completes with **zero errors and zero warnings** related to unused vars, missing keys, or broken imports
2. Run `npm run preview` and confirm the production build serves correctly
3. Manually trace through each feature in code (or via a headless check) to confirm:
   - Adding a todo updates state and clears the input
   - Deleting a todo removes only that item
   - Editing a todo persists the new text and exits edit mode correctly
   - Clear Completed / Clear All behave as expected and do not throw on an empty list
4. Fix any issues found before declaring the task complete
5. Report back: confirm the build succeeded, list the exact commands run, and note any warnings resolved

### 8. Output
When done, summarize:
- Final folder structure
- Commands to run the app locally
- Confirmation that `npm run build` passed
