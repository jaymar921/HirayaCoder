# Agentic Build Prompt: Simple Point of Sale (POS) App in Python (Tkinter, stdlib only)

Use this prompt to instruct a coding agent (e.g., Claude Code) to build the project end-to-end.

---

## Role & Objective

You are a senior Python developer acting as an autonomous coding agent. Build a **simple, self-contained Point of Sale (POS) desktop application** in **Python** using **Tkinter** for the UI. Work incrementally, verify your own output, and don't stop until the project runs successfully and all tests pass.

## Tech Stack & Constraints

- Language: Python 3.10+
- UI: **Tkinter only** (ships with the standard Python installation — `tkinter`, `tkinter.ttk`, `tkinter.messagebox`, `tkinter.simpledialog`)
- **No third-party/external libraries whatsoever** — standard library only (this includes UI, persistence, and testing: use `unittest` from stdlib, not `pytest`)
- Persistence: local file using `json` or `csv` (both stdlib) so data survives restarts — no external database
- Testing: `unittest` (stdlib) with `tempfile`/`unittest.mock` as needed
- No network calls, no pip installs, no `requirements.txt` beyond noting "none — stdlib only" in the README

## Core Features (must all be implemented)

1. **Add product** — create a new product with: ID (auto-generated), name, price, quantity/stock, category (optional).
2. **Delete product** — remove a product by ID, with confirmation dialog in the UI.
3. **Modify product** — edit name, price, category, and/or stock of an existing product.
4. **Clear product(s)** — clear/reset the entire product list (with a confirmation dialog), distinct from deleting a single product.
5. **Check stock** — view current stock level for a product or list all products with stock levels; visually flag low/out-of-stock items.
6. **Update stock** — increment/decrement stock (e.g., after a sale or restock), with validation to prevent negative stock.

Each feature must be reachable from the Tkinter UI (buttons/menu/table actions) AND exposed through a testable service layer independent of the UI.

## Architecture & Folder Structure

Enforce a clean, layered structure — do not put business logic inside Tkinter widget classes. Example:

```
pos-app/
├── README.md
├── main.py                          # entry point, launches UI
├── pos_app/
│   ├── __init__.py
│   ├── model/
│   │   ├── __init__.py
│   │   └── product.py               # Product dataclass
│   ├── repository/
│   │   ├── __init__.py
│   │   ├── product_repository.py    # abstract base class / interface
│   │   └── file_product_repository.py  # JSON-file-backed impl
│   ├── service/
│   │   ├── __init__.py
│   │   └── product_service.py       # business logic + validation
│   ├── ui/
│   │   ├── __init__.py
│   │   ├── main_window.py           # MainWindow(Tk) with product table (ttk.Treeview)
│   │   └── dialogs.py               # Add/Edit product dialogs (Toplevel)
│   └── util/
│       ├── __init__.py
│       └── validators.py
├── data/
│   └── products.json                # default/sample data file
└── tests/
    ├── __init__.py
    ├── test_product_service.py
    └── test_file_product_repository.py
```

## Detailed Requirements

### Model
- `Product` (use `@dataclass`): `id` (str/int), `name` (non-blank), `price` (non-negative float), `stock` (non-negative int), `category` (optional str). Implement `__eq__` via dataclass defaults; add a `to_dict`/`from_dict` pair for serialization.

### Repository layer
- `ProductRepository`: abstract base class (`abc.ABC`) defining `add`, `delete`, `update`, `find_by_id`, `find_all`, `clear_all`, `save`/`load`.
- `FileProductRepository`: reads/writes to a JSON file on disk using `json` (stdlib); loads existing data on startup, persists after every mutation. Use `pathlib.Path` for file handling.

### Service layer
- `ProductService` wraps the repository and adds validation:
  - Reject duplicate product names (or allow — document the decision in README).
  - Reject negative price/stock; raise a custom exception (e.g., `ValidationError`) on invalid input.
  - `update_stock(product_id, delta)` must prevent stock from going negative and raise a clear exception otherwise.
  - `check_stock(product_id)` returns current stock; also provide `find_low_stock(threshold)`.

### UI (Tkinter)
- `MainWindow`: a `ttk.Treeview` listing all products (ID, name, price, stock, category).
- Toolbar/menu (buttons or `tk.Menu`) with actions: Add, Edit/Modify, Delete, Clear All, Update Stock, Refresh/Check Stock.
- Add/Edit dialogs: `tkinter.Toplevel` modal forms with input validation and inline error labels (no raw exceptions/tracebacks shown to the user).
- Confirmation dialogs (`tkinter.messagebox.askyesno`) before Delete and Clear All.
- Visually highlight rows with low or zero stock (e.g., `Treeview` tag with a red foreground/background).
- Sensible window sizing, resizable, minimum reasonable dimensions (`root.minsize(...)`).

### Error handling
- No unhandled exceptions should crash the UI. Catch exceptions at the UI boundary and show a friendly `messagebox.showerror`.

## Testing Requirements

- Unit tests (using `unittest`) for `ProductService` covering: add/delete/modify/clear, stock check, stock update (including the negative-stock rejection path), and duplicate/invalid input handling.
- Unit tests for `FileProductRepository` covering persistence round-trip (save then load returns equivalent data) using `tempfile.TemporaryDirectory` — never touch the real `data/products.json` in tests.
- Aim for meaningful coverage of business logic (repository + service), not just happy paths — include edge cases (empty list, invalid IDs, boundary values).
- Tests must be runnable via `python -m unittest discover -s tests` (or `python -m unittest discover`).

## Build/Run Verification (must perform before finishing)

1. Run `python -m py_compile` (or import each module) across the project — confirm no syntax/import errors.
2. Run `python -m unittest discover -s tests -v` — confirm all tests pass; fix any failures.
3. Launch `python main.py` (headless environments: verify it at least imports and constructs the main window/service without raising — note if a display isn't available for a full GUI smoke test).
4. Confirm no third-party imports exist anywhere in the codebase (grep for `import` statements outside the standard library).
5. Report the final test results and run status in your summary.

## README.md Requirements

The repository README must include:
- Project name and one-paragraph description.
- Feature list.
- Folder structure overview.
- Prerequisites (Python version — note Tkinter is stdlib but may need a system package like `python3-tk` on some Linux distros).
- Explicit note: **no external dependencies / no `pip install` required**.
- How to run (`python main.py`).
- How to run tests (`python -m unittest discover -s tests`).
- Notes on data persistence (where the data file lives, JSON format/schema).
- Any known limitations or assumptions made.

## Deliverables Checklist (agent must confirm each before declaring done)

- [ ] Folder structure matches the layered design above
- [ ] All 6 features implemented and wired to the UI
- [ ] Only standard library imports used anywhere in the project
- [ ] Service layer fully unit-tested
- [ ] Repository layer tested with persistence round-trip
- [ ] `python -m unittest discover` passes with zero failures
- [ ] `python main.py` launches the Tkinter UI successfully
- [ ] README.md complete and accurate
- [ ] No unhandled exceptions surface to the user in the UI

## Working Style

- Build incrementally: model → repository → service (+tests) → UI → integration.
- After each layer, run relevant tests before moving on.
- If a design decision isn't specified above (e.g., duplicate-name policy, ID generation strategy), make a reasonable choice and document it in the README rather than pausing to ask.
- End with a summary of what was built, the test/run verification output, and how to run the app.
