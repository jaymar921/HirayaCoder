'use strict';

/**
 * Drive a Python project's service layer and find out whether its features work.
 *
 * The Python counterpart to `javaProbe`, reporting the **same eight feature names**, so
 * one product built twice in two languages can be read off one table. A passing
 * `unittest` run says the model's own tests agree with the model's own code; this says
 * whether deleting a product deletes it.
 *
 * ## Why parameter names, not types
 *
 * The Java probe fills arguments by type, because that is all reflection there offers.
 * Python hands over the parameter *names* through `inspect.signature`, and the brief
 * names them too — `update_stock(product_id, delta)`, `check_stock(product_id)`,
 * `find_low_stock(threshold)`. Matching on the name is both more accurate and more
 * readable: a `delta` is a delta whatever its annotation says.
 *
 * Where a name says nothing, the annotation is tried, and failing that a string. The
 * whole point is the same as the browser probe's: find the control the brief asked for,
 * press it, and report what happened — never fail a model for naming something
 * reasonably but differently.
 *
 * @module tools/lib/pythonProbe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** The eight checks, named identically to `javaProbe.JAVA_FEATURES`. */
const PYTHON_FEATURES = [
  'serviceFound',
  'addProduct',
  'checkStock',
  'updateStock',
  'rejectsNegativeStock',
  'modifyProduct',
  'deleteProduct',
  'clearProducts',
];

/** A probe that hangs is a probe that failed. */
const TIMEOUT_MS = 180000;

/**
 * The driver, written in Python because it has to run inside the model's own package.
 *
 * It prints one `FEATURE name ok|fail detail` line per check and never raises out of
 * `main`: a probe that dies on the third feature would report the last five as failures
 * they might not be.
 */
const DRIVER = `import importlib
import inspect
import io
import os
import sys
import tempfile
import traceback

REPORT = []


def report(name, ok, detail=""):
    REPORT.append("FEATURE " + name + " " + ("ok" if ok else "fail") + " " + str(detail).replace("\\n", " ")[:200])


def load_service_class():
    """The class the brief names, or any *Service class the package exposes."""
    candidates = [
        ("pos_app.service.product_service", "ProductService"),
        ("pos_app.service", "ProductService"),
    ]
    for module_name, class_name in candidates:
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        found = getattr(module, class_name, None)
        if inspect.isclass(found):
            return found, module_name + "." + class_name
        for attr, value in vars(module).items():
            if inspect.isclass(value) and attr.endswith("Service"):
                return value, module_name + "." + attr
    # Last resort: walk the package for anything named *Service.
    for root, _dirs, files in os.walk("pos_app"):
        for filename in files:
            if not filename.endswith(".py") or filename.startswith("__"):
                continue
            dotted = os.path.join(root, filename)[:-3].replace(os.sep, ".")
            try:
                module = importlib.import_module(dotted)
            except Exception:
                continue
            for attr, value in vars(module).items():
                if inspect.isclass(value) and attr.endswith("Service"):
                    return value, dotted + "." + attr
    return None, ""


def load_repository_class():
    for module_name, class_name in [
        ("pos_app.repository.file_product_repository", "FileProductRepository"),
        ("pos_app.repository", "FileProductRepository"),
    ]:
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        found = getattr(module, class_name, None)
        if inspect.isclass(found):
            return found
    return None


def build_repository(data_dir):
    """A repository pointed at a throwaway file, never the project's own data."""
    repository = load_repository_class()
    if repository is None:
        return None
    target = os.path.join(data_dir, "products.json")
    for args in ((target,), (os.path.join(data_dir, "products"),), ()):
        try:
            return repository(*args)
        except Exception:
            continue
    return None


def value_for(parameter, product_id, delta):
    """Fill one argument, preferring what its name says it is."""
    name = parameter.name.lower()
    if name in ("self", "cls"):
        return None
    if "id" == name or name.endswith("_id") or name in ("identifier", "pid"):
        return product_id
    if name in ("delta", "amount", "change", "by", "quantity_change"):
        return delta
    if "name" in name or "title" in name:
        return "Probe Widget"
    if "price" in name or "cost" in name:
        return 9.99
    if "stock" in name or "quantity" in name or "qty" in name or "count" in name:
        return 3
    if "category" in name or "type" in name or "group" in name:
        return "probe"
    if "threshold" in name or "limit" in name:
        return 5
    annotation = parameter.annotation
    if annotation is int:
        return 1
    if annotation is float:
        return 1.0
    if annotation is bool:
        return False
    return "Probe Widget"


def call(method, product_id=None, delta=None):
    signature = inspect.signature(method)
    args = []
    kwargs = {}
    for parameter in signature.parameters.values():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        chosen = value_for(parameter, product_id, delta)
        if chosen is None:
            continue
        if parameter.kind == parameter.KEYWORD_ONLY:
            kwargs[parameter.name] = chosen
        else:
            args.append(chosen)
    return method(*args, **kwargs)


def method_of(instance, *names):
    for name in names:
        found = getattr(instance, name, None)
        if callable(found):
            return found
    return None


def size_of(collection):
    try:
        return len(collection)
    except Exception:
        return -1


def id_of(product, instance):
    for attribute in ("id", "product_id", "identifier"):
        value = getattr(product, attribute, None)
        if value is not None:
            return value
    if isinstance(product, dict):
        for key in ("id", "product_id"):
            if key in product:
                return product[key]
    find_all = method_of(instance, "find_all", "list_all", "get_all", "all")
    if find_all is not None:
        try:
            items = find_all()
            if items:
                return id_of(items[0], instance)
        except Exception:
            pass
    return None


def main():
    service_class, where = load_service_class()
    if service_class is None:
        report("serviceFound", False, "no ProductService class could be imported")
        return

    data_dir = tempfile.mkdtemp(prefix="hiraya-pypos-")
    instance = None
    for factory in (
        lambda: service_class(build_repository(data_dir)),
        lambda: service_class(),
        lambda: service_class(os.path.join(data_dir, "products.json")),
    ):
        try:
            candidate = factory()
            if candidate is not None:
                instance = candidate
                break
        except Exception:
            continue
    if instance is None:
        report("serviceFound", False, "found " + where + " but could not construct it")
        return
    report("serviceFound", True, "constructed " + where)

    add = method_of(instance, "add", "add_product", "create", "create_product")
    find_all = method_of(instance, "find_all", "list_all", "get_all", "all", "list_products")
    check_stock = method_of(instance, "check_stock", "get_stock", "stock_of", "stock")
    update_stock = method_of(instance, "update_stock", "adjust_stock", "change_stock")
    update = method_of(instance, "update", "update_product", "modify", "modify_product", "edit")
    delete = method_of(instance, "delete", "delete_product", "remove", "remove_product")
    clear_all = method_of(instance, "clear_all", "clear", "clear_products", "reset", "delete_all")

    added = None
    if add is None:
        report("addProduct", False, "no add method on the service")
    else:
        try:
            before = size_of(find_all()) if find_all else -1
            added = call(add)
            after = size_of(find_all()) if find_all else -1
            grew = after > before or (after == -1 and added is not None)
            report("addProduct", grew, "the list grew to " + str(after) if grew else "the list did not grow")
        except Exception as error:
            report("addProduct", False, "raised " + type(error).__name__ + ": " + str(error))

    product_id = id_of(added, instance) if added is not None else None
    if product_id is None and find_all is not None:
        try:
            items = find_all()
            product_id = id_of(items[0], instance) if items else None
        except Exception:
            product_id = None

    if check_stock is None:
        report("checkStock", False, "no check_stock method on the service")
    elif product_id is None:
        report("checkStock", False, "nothing to check the stock of")
    else:
        try:
            stock = call(check_stock, product_id)
            report("checkStock", stock is not None, "returned " + str(stock))
        except Exception as error:
            report("checkStock", False, "raised " + type(error).__name__ + ": " + str(error))

    if update_stock is None:
        report("updateStock", False, "no update_stock method on the service")
        report("rejectsNegativeStock", False, "no update_stock method on the service")
    elif product_id is None:
        report("updateStock", False, "nothing to restock")
        report("rejectsNegativeStock", False, "nothing to restock")
    else:
        try:
            call(update_stock, product_id, 5)
            now = call(check_stock, product_id) if check_stock else None
            report("updateStock", True, "stock is now " + str(now))
        except Exception as error:
            report("updateStock", False, "raised " + type(error).__name__ + ": " + str(error))
        try:
            call(update_stock, product_id, -1000000)
            report("rejectsNegativeStock", False, "took the stock negative without complaint")
        except Exception as error:
            report("rejectsNegativeStock", True, "refused with " + type(error).__name__ + ": " + str(error))

    if update is None:
        report("modifyProduct", False, "no update method on the service")
    elif product_id is None:
        report("modifyProduct", False, "nothing to update")
    else:
        try:
            call(update, product_id)
            report("modifyProduct", True, "accepted an update")
        except Exception as error:
            report("modifyProduct", False, "raised " + type(error).__name__ + ": " + str(error))

    if delete is None:
        report("deleteProduct", False, "no delete method on the service")
    elif product_id is None:
        report("deleteProduct", False, "nothing to delete")
    else:
        try:
            before = size_of(find_all()) if find_all else -1
            call(delete, product_id)
            after = size_of(find_all()) if find_all else -1
            gone = after < before or before == -1
            report("deleteProduct", gone, "the list shrank to " + str(after) if gone else "the list still holds " + str(after))
        except Exception as error:
            report("deleteProduct", False, "raised " + type(error).__name__ + ": " + str(error))

    if clear_all is None:
        report("clearProducts", False, "no clear_all method on the service")
    else:
        try:
            if add is not None:
                call(add)
            clear_all()
            left = size_of(find_all()) if find_all else 0
            report("clearProducts", left == 0, "the list is empty" if left == 0 else "the list still holds " + str(left))
        except Exception as error:
            report("clearProducts", False, "raised " + type(error).__name__ + ": " + str(error))


if __name__ == "__main__":
    # Tk must never open a window here, and a service that reaches for one at import
    # time is a finding rather than a crash.
    os.environ.setdefault("MPLBACKEND", "Agg")
    sys.path.insert(0, os.getcwd())
    try:
        main()
    except Exception:
        report("serviceFound", False, "the probe raised: " + traceback.format_exc(limit=1).replace("\\n", " "))
    sys.stdout.write("\\n".join(REPORT) + "\\n")
`;

/**
 * @param {string[]} argv
 * @param {string} cwd
 */
function run(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** Whichever spelling of Python this machine has. */
function pythonBinary(cwd) {
  for (const candidate of ['python', 'python3', 'py']) {
    if (run([candidate, '--version'], cwd).ok) return candidate;
  }
  return '';
}

/**
 * Drive the service layer of a Python project.
 *
 * @param {string} appPath  The project directory, the one holding `main.py`.
 * @returns {Promise<{ran: boolean, reason: string, features: Record<string, {ok: boolean, detail: string}>,
 *   passed: number, total: number}>}
 */
async function probePythonService(appPath) {
  const blank = { ran: false, reason: '', features: {}, passed: 0, total: PYTHON_FEATURES.length };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path the caller computed.
  if (!fs.existsSync(path.join(appPath, 'pos_app'))) {
    return { ...blank, reason: 'no pos_app package to import' };
  }

  const python = pythonBinary(appPath);
  if (!python) return { ...blank, reason: 'python is not installed on this machine' };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a temp dir this process made.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-pyprobe-'));
  const driverPath = path.join(scratch, 'hiraya_probe.py');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp file.
    fs.writeFileSync(driverPath, DRIVER, 'utf8');
    const outcome = run([python, driverPath], appPath);
    const lines = `${outcome.stdout}\n${outcome.stderr}`.split(/\r?\n/);

    /** @type {Record<string, {ok: boolean, detail: string}>} */
    const features = {};
    for (const line of lines) {
      const match = /^FEATURE (\S+) (ok|fail) ?(.*)$/.exec(line.trim());
      if (match) features[match[1]] = { ok: match[2] === 'ok', detail: match[3] };
    }

    if (Object.keys(features).length === 0) {
      return {
        ...blank,
        reason: 'the probe produced no report: ' + (outcome.stderr || outcome.stdout || 'no output').slice(-400),
      };
    }

    for (const name of PYTHON_FEATURES) {
      if (!features[name]) features[name] = { ok: false, detail: 'not reached — an earlier check failed hard' };
    }

    return {
      ran: true,
      reason: '',
      features,
      passed: PYTHON_FEATURES.filter((name) => features[name].ok).length,
      total: PYTHON_FEATURES.length,
    };
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir.
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { probePythonService, PYTHON_FEATURES, DRIVER };
