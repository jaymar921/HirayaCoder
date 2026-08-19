# Agentic Build Prompt — Contact Management System (CMS)

Copy everything below the line into your AI coding agent (Claude Code, Cursor, etc.) as the task prompt.

---

## ROLE

You are an autonomous senior full-stack engineer. Build, test, and verify a complete, production-quality **Contact Management System (CMS)** web app. Work end-to-end without stopping for approval between steps — plan, scaffold, implement, test, and verify the build, then report a summary of what was done.

## PROJECT OVERVIEW

Build a simple but modern **Contact Management System** (name it clearly — a customer/contact manager, not a content management system) using:

- **React** (functional components + hooks)
- **Vite** as the build tool
- **Tailwind CSS** for styling
- **Vitest + React Testing Library** for unit/component tests
- Client-side state (in-memory or localStorage-backed) — no backend required unless you note it as a stretch goal

## DESIGN REQUIREMENTS

- Modern, clean, minimal aesthetic — generous whitespace, rounded corners (`rounded-xl`/`rounded-2xl`), soft shadows, subtle hover/transition states.
- **Primary color: blue** (e.g. Tailwind `blue-600` as primary, `blue-50`/`blue-100` for backgrounds/accents, `slate` grays for text/neutrals). Define these as reusable Tailwind theme tokens rather than hardcoding hex values throughout.
- Responsive layout (mobile-first, works on desktop and mobile).
- Clear visual hierarchy: header/nav, contact list/table, add/edit form (modal or side panel), empty state, and confirmation dialogs for destructive actions.
- Use accessible markup (labels, `aria-*` attributes, keyboard-navigable modals, sufficient color contrast).

## CORE FEATURES (must implement)

1. **Add Contact** — form with validated fields (e.g. name required, valid email format, optional phone/company). Show inline validation errors.
2. **Delete Contact** — remove a single contact, with a confirmation prompt before deletion.
3. **Modify (Edit) Contact** — edit an existing contact's details via the same form, pre-filled with current data.
4. **Clear Contacts** — a "Clear All" action that removes every contact, gated behind a confirmation dialog (must not be a single accidental click).
5. **List/View Contacts** — display all contacts in a searchable/filterable list or table (search by name/email at minimum).

Persist contacts to `localStorage` so data survives a page refresh (state hydration on load, write-through on every change).

## PROJECT STRUCTURE

Scaffold a clear, conventional folder structure, for example:

```
cms-app/
├── public/
├── src/
│   ├── assets/
│   ├── components/
│   │   ├── contacts/
│   │   │   ├── ContactList.jsx
│   │   │   ├── ContactCard.jsx
│   │   │   ├── ContactForm.jsx
│   │   │   └── ConfirmDialog.jsx
│   │   └── ui/              # generic buttons, inputs, modal shell, etc.
│   ├── hooks/
│   │   └── useContacts.js   # add/edit/delete/clear + localStorage sync
│   ├── context/              # optional: ContactsContext if not using a lib
│   ├── utils/
│   │   └── validation.js
│   ├── types/                 # if using TS, or JSDoc typedefs if JS
│   ├── App.jsx
│   ├── main.jsx
│   └── index.css
├── tests/
│   ├── ContactForm.test.jsx
│   ├── ContactList.test.jsx
│   └── useContacts.test.js
├── .eslintrc / eslint.config.js
├── tailwind.config.js
├── postcss.config.js
├── vite.config.js
├── package.json
└── README.md
```

Keep components small and single-responsibility; separate presentational components from the data/state logic (custom hook or context).

## TESTING REQUIREMENTS

- Set up **Vitest** + **React Testing Library** + `jsdom`.
- Write tests covering:
  - Adding a contact (valid + invalid input)
  - Editing a contact updates the correct record
  - Deleting a contact removes it and prompts confirmation
  - Clear All empties the list and prompts confirmation
  - Search/filter behavior (if implemented)
- Include at least one test per core feature. Aim for meaningful coverage of the `useContacts` hook and form validation logic, not just snapshot tests.
- Add an npm script `test` (and `test:watch` if useful).

## BUILD VERIFICATION

After implementation:
1. Run `npm install` and confirm no errors.
2. Run the full test suite (`npm run test`) and confirm all tests pass.
3. Run `npm run build` (Vite production build) and confirm it completes with no errors or warnings that indicate broken code.
4. Optionally run `npm run preview` to sanity-check the production build serves correctly.
5. Fix any lint/build/test failures before considering the task complete — do not report success with failing checks.

## README REQUIREMENTS

Create a repository `README.md` including:
- Project name and one-paragraph description
- Feature list
- Tech stack
- Screenshots or a short description of the UI (screenshots optional if none can be generated)
- Setup instructions: `npm install`, `npm run dev`, `npm run build`, `npm run test`
- Project structure overview (brief tree + description of key folders)
- Notes on design decisions (e.g. why localStorage, why this folder structure)
- Known limitations / possible next steps (e.g. backend integration, auth, pagination)

## DELIVERABLE / REPORT-BACK FORMAT

When finished, summarize:
- What was built and where key files live
- Test results (pass/fail counts)
- Build verification result
- Any assumptions made or trade-offs taken
- Suggested next steps if this were to grow beyond a demo (e.g. backend API, auth, real DB)

## CONSTRAINTS

- Do not add a backend/server or external database unless explicitly asked — keep this a self-contained frontend app with localStorage persistence.
- Do not introduce heavy state-management libraries (Redux, Zustand, etc.) unless the contact logic genuinely outgrows `useState`/`useReducer` + a custom hook — prefer simplicity.
- Keep dependencies minimal and justified.
