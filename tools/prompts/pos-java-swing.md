# Agentic Build Prompt: Simple Point of Sale (POS) App in Java (Swing)

Use this prompt to instruct a coding agent (e.g., Claude Code) to build the project end-to-end.

---

## Role & Objective

You are a senior Java developer acting as an autonomous coding agent. Build a **simple, self-contained Point of Sale (POS) desktop application** in **Java** using **Java Swing** for the UI. Work incrementally, verify your own output, and don't stop until the project builds successfully and all tests pass.

## Tech Stack & Constraints

- Language: Java 17+
- UI: Java Swing (no external UI frameworks)
- Build tool: Maven (preferred) — include `pom.xml`
- Persistence: simple in-memory repository backed by a local file (CSV or JSON) so data survives restarts — no external database required
- Testing: JUnit 5 (+ Mockito if useful for isolating persistence)
- No network calls, no external services

## Core Features (must all be implemented)

1. **Add product** — create a new product with: ID (auto-generated), name, price, quantity/stock, category (optional).
2. **Delete product** — remove a product by ID, with confirmation dialog in the UI.
3. **Modify product** — edit name, price, category, and/or stock of an existing product.
4. **Clear product(s)** — clear/reset the entire product list (with a confirmation dialog), distinct from deleting a single product.
5. **Check stock** — view current stock level for a product or list all products with stock levels; visually flag low/out-of-stock items.
6. **Update stock** — increment/decrement stock (e.g., after a sale or restock), with validation to prevent negative stock.

Each feature must be reachable from the Swing UI (buttons/menu/table actions) AND exposed through a testable service layer independent of the UI.

## Architecture & Folder Structure

Enforce a clean, layered structure — do not put business logic inside Swing classes. Example:

```
pos-app/
├── README.md
├── pom.xml
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/pos/app/
│   │   │       ├── Main.java                # entry point, launches UI
│   │   │       ├── model/
│   │   │       │   └── Product.java
│   │   │       ├── repository/
│   │   │       │   ├── ProductRepository.java        # interface
│   │   │       │   └── FileProductRepository.java     # file-backed impl
│   │   │       ├── service/
│   │   │       │   └── ProductService.java            # business logic
│   │   │       ├── ui/
│   │   │       │   ├── MainFrame.java
│   │   │       │   ├── ProductTableModel.java
│   │   │       │   └── dialogs/
│   │   │       │       ├── AddProductDialog.java
│   │   │       │       └── EditProductDialog.java
│   │   │       └── util/
│   │   │           └── Validator.java
│   │   └── resources/
│   │       └── data/                        # default/sample data file
│   └── test/
│       └── java/
│           └── com/pos/app/
│               ├── service/
│               │   └── ProductServiceTest.java
│               └── repository/
│                   └── FileProductRepositoryTest.java
└── target/                                    # build output (gitignored)
```

## Detailed Requirements

### Model
- `Product`: id (String/UUID or int), name (non-blank), price (non-negative), stock (non-negative int), category (nullable string). Include `equals`/`hashCode`/`toString`.

### Repository layer
- `ProductRepository` interface: `add`, `delete`, `update`, `findById`, `findAll`, `clearAll`, `save/load` (persistence).
- `FileProductRepository`: reads/writes to a CSV or JSON file on disk; loads existing data on startup, persists after every mutation.

### Service layer
- `ProductService` wraps the repository and adds validation:
  - Reject duplicate product names (or allow — document the decision in README).
  - Reject negative price/stock.
  - `updateStock(id, delta)` must prevent stock from going negative and throw a clear exception otherwise.
  - `checkStock(id)` returns current stock; also provide `findLowStock(threshold)`.

### UI (Swing)
- `MainFrame`: a `JTable` listing all products (ID, name, price, stock, category) bound to a `ProductTableModel`.
- Toolbar or menu with actions: Add, Edit/Modify, Delete, Clear All, Update Stock, Refresh/Check Stock.
- `AddProductDialog` / `EditProductDialog`: modal forms with input validation and inline error messages (no raw exceptions shown to the user).
- Confirmation dialogs (`JOptionPane`) before Delete and Clear All.
- Visually highlight rows with low or zero stock (e.g., red text/background).
- Sensible window sizing, resizable, minimum reasonable dimensions.

### Error handling
- No unhandled exceptions should crash the UI. Catch exceptions at the UI boundary and show a friendly `JOptionPane` error message.

## Testing Requirements

- Unit tests for `ProductService` covering: add/delete/modify/clear, stock check, stock update (including the negative-stock rejection path), and duplicate/invalid input handling.
- Unit tests for `FileProductRepository` covering persistence round-trip (save then load returns equivalent data) using a temp file/directory (e.g., JUnit `@TempDir`).
- Aim for meaningful coverage of business logic (repository + service), not just happy paths — include edge cases (empty list, invalid IDs, boundary values).
- Tests must be runnable via `mvn test`.

## Build Verification (must perform before finishing)

1. Run `mvn clean compile` — confirm no compilation errors.
2. Run `mvn test` — confirm all tests pass; fix any failures.
3. Run `mvn package` — confirm a runnable JAR is produced (configure `maven-shade-plugin` or `maven-jar-plugin` with a manifest `Main-Class`).
4. Sanity-check that `java -jar target/<artifact>.jar` launches the Swing UI without error.
5. Report the final test results and build status in your summary.

## README.md Requirements

The repository README must include:
- Project name and one-paragraph description.
- Feature list.
- Folder structure overview.
- Prerequisites (JDK version, Maven).
- How to build (`mvn clean package`).
- How to run (`java -jar ...` or `mvn exec:java`).
- How to run tests (`mvn test`).
- Notes on data persistence (where the data file lives, format).
- Any known limitations or assumptions made.

## Deliverables Checklist (agent must confirm each before declaring done)

- [ ] Folder structure matches the layered design above
- [ ] All 6 features implemented and wired to the UI
- [ ] Service layer fully unit-tested
- [ ] Repository layer tested with persistence round-trip
- [ ] `mvn clean package` succeeds
- [ ] `mvn test` passes with zero failures
- [ ] JAR launches the Swing UI successfully
- [ ] README.md complete and accurate
- [ ] No unhandled exceptions surface to the user in the UI

## Working Style

- Build incrementally: model → repository → service (+tests) → UI → integration.
- After each layer, compile and run relevant tests before moving on.
- If a design decision isn't specified above (e.g., duplicate-name policy, ID generation strategy), make a reasonable choice and document it in the README rather than pausing to ask.
- End with a summary of what was built, the build/test verification output, and how to run the app.
