'use strict';

/**
 * Drive a built Java project's service layer and find out whether its features work.
 *
 * The Java counterpart to `appProbe`, and it exists for the same reason: a Maven build
 * that exits 0 says the code compiles, not that deleting a product deletes it. The POS
 * brief is explicit that every feature must be "exposed through a testable service layer
 * independent of the UI", which is exactly what makes this possible — the behaviour is
 * reachable without a screen.
 *
 * ## Why reflection, and why that is fair
 *
 * The brief names the classes and the methods: `com.pos.app.service.ProductService`,
 * with `add`, `delete`, `update`, `findAll`, `clearAll`, `checkStock`, `updateStock`,
 * `findLowStock`. A probe that compiled against them would fail to compile whenever a
 * model named something differently, and would then report a *build* failure for what is
 * really a naming difference. Reflection lets the probe look for what the brief asked
 * for, try it, and report per feature — the same "find the control and press it"
 * approach the browser probe takes to a delete button with no label.
 *
 * The model's own tests are graded separately, as the `test` gate. They are its account
 * of itself; this is not.
 *
 * @module tools/lib/javaProbe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** The six features the POS brief requires, in the order it lists them. */
const JAVA_FEATURES = ['serviceFound', 'addProduct', 'checkStock', 'updateStock', 'rejectsNegativeStock', 'modifyProduct', 'deleteProduct', 'clearProducts'];

/** One compile and one run; neither should be slow, and a hang is a failure. */
const TIMEOUT_MS = 180000;

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
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/**
 * The driver, written in Java because it has to run inside the model's own classes.
 *
 * It prints one `FEATURE name ok|fail detail` line per check and never throws out of
 * `main`: a probe that dies on the third feature would report the last five as failures
 * they might not be.
 */
const DRIVER = `
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;

public class HirayaPosProbe {
  static StringBuilder out = new StringBuilder();

  static void report(String name, boolean ok, String detail) {
    out.append("FEATURE ").append(name).append(' ').append(ok ? "ok" : "fail").append(' ').append(detail).append('\\n');
  }

  /** A value of the right shape for a parameter we know nothing about. */
  static Object sample(Class<?> type, int seed) {
    if (type == String.class) return "Probe Widget " + seed;
    if (type == int.class || type == Integer.class) return seed;
    if (type == long.class || type == Long.class) return (long) seed;
    if (type == double.class || type == Double.class) return 9.99 * seed;
    if (type == float.class || type == Float.class) return 9.99f;
    if (type == boolean.class || type == Boolean.class) return Boolean.TRUE;
    if (type == java.math.BigDecimal.class) return new java.math.BigDecimal("9.99");
    return null;
  }

  static Method find(Class<?> type, String... names) {
    for (String name : names) {
      for (Method method : type.getMethods()) {
        if (method.getName().equalsIgnoreCase(name)) return method;
      }
    }
    return null;
  }

  static Object[] argsFor(Method method, Object first) {
    Class<?>[] types = method.getParameterTypes();
    Object[] args = new Object[types.length];
    for (int i = 0; i < types.length; i++) {
      args[i] = (i == 0 && first != null && types[0].isInstance(first)) ? first : sample(types[i], i + 1);
    }
    return args;
  }

  static int sizeOf(Object collection) {
    if (collection instanceof Collection) return ((Collection<?>) collection).size();
    if (collection != null && collection.getClass().isArray()) return Array.getLength(collection);
    return -1;
  }

  public static void main(String[] argv) throws Exception {
    Class<?> service = null;
    Object instance = null;
    try {
      service = Class.forName("com.pos.app.service.ProductService");
    } catch (Throwable t) {
      report("serviceFound", false, "com.pos.app.service.ProductService is not on the classpath");
      System.out.print(out);
      return;
    }

    Path data = Files.createTempDirectory("hiraya-pos-probe");
    for (Constructor<?> constructor : service.getConstructors()) {
      try {
        Class<?>[] types = constructor.getParameterTypes();
        Object[] args = new Object[types.length];
        for (int i = 0; i < types.length; i++) {
          if (types[i] == String.class) args[i] = data.resolve("products.dat").toString();
          else if (types[i] == java.io.File.class) args[i] = data.resolve("products.dat").toFile();
          else if (types[i] == Path.class) args[i] = data.resolve("products.dat");
          else args[i] = buildRepository(types[i], data);
        }
        instance = constructor.newInstance(args);
        if (instance != null) break;
      } catch (Throwable ignored) {
        // Try the next constructor.
      }
    }

    if (instance == null) {
      report("serviceFound", false, "found ProductService but could not construct it");
      System.out.print(out);
      return;
    }
    report("serviceFound", true, "constructed " + service.getName());

    Method add = find(service, "addProduct", "add", "create", "save");
    Method findAll = find(service, "findAll", "getAll", "list", "getProducts");
    Method checkStock = find(service, "checkStock", "getStock", "stockOf");
    Method updateStock = find(service, "updateStock", "adjustStock", "changeStock");
    Method update = find(service, "updateProduct", "update", "modify", "edit");
    Method delete = find(service, "deleteProduct", "delete", "remove", "removeById");
    Method clearAll = find(service, "clearAll", "clear", "removeAll", "deleteAll");

    Object added = null;
    int before = findAll == null ? -1 : sizeOf(findAll.invoke(instance));
    if (add == null) {
      report("addProduct", false, "no add method on the service");
    } else {
      try {
        added = add.invoke(instance, argsFor(add, null));
        int after = findAll == null ? -1 : sizeOf(findAll.invoke(instance));
        boolean grew = after > before || (after == -1 && added != null);
        report("addProduct", grew, grew ? "the list grew to " + after : "the list did not grow");
      } catch (Throwable t) {
        report("addProduct", false, "threw " + root(t));
      }
    }

    Object id = idOf(added, instance, findAll);

    if (checkStock == null) report("checkStock", false, "no checkStock method on the service");
    else if (id == null) report("checkStock", false, "nothing to check the stock of");
    else {
      try {
        Object stock = checkStock.invoke(instance, coerce(checkStock, id));
        report("checkStock", stock != null, stock == null ? "returned null" : "returned " + stock);
      } catch (Throwable t) {
        report("checkStock", false, "threw " + root(t));
      }
    }

    if (updateStock == null) {
      report("updateStock", false, "no updateStock method on the service");
      report("rejectsNegativeStock", false, "no updateStock method on the service");
    } else if (id == null) {
      report("updateStock", false, "nothing to update the stock of");
      report("rejectsNegativeStock", false, "nothing to update the stock of");
    } else {
      try {
        updateStock.invoke(instance, stockArgs(updateStock, id, 5));
        Object stock = checkStock == null ? null : checkStock.invoke(instance, coerce(checkStock, id));
        report("updateStock", true, stock == null ? "accepted +5" : "stock is now " + stock);
      } catch (Throwable t) {
        report("updateStock", false, "threw " + root(t));
      }
      // The brief is explicit: stock must not be allowed to go negative.
      try {
        updateStock.invoke(instance, stockArgs(updateStock, id, -100000));
        report("rejectsNegativeStock", false, "took the stock negative without complaint");
      } catch (Throwable t) {
        report("rejectsNegativeStock", true, "refused with " + root(t));
      }
    }

    if (update == null) report("modifyProduct", false, "no update method on the service");
    else {
      try {
        update.invoke(instance, argsFor(update, added));
        report("modifyProduct", true, "accepted an update");
      } catch (Throwable t) {
        report("modifyProduct", false, "threw " + root(t));
      }
    }

    if (delete == null) report("deleteProduct", false, "no delete method on the service");
    else if (id == null) report("deleteProduct", false, "nothing to delete");
    else {
      try {
        int was = findAll == null ? -1 : sizeOf(findAll.invoke(instance));
        delete.invoke(instance, coerce(delete, id));
        int now = findAll == null ? -1 : sizeOf(findAll.invoke(instance));
        report("deleteProduct", now < was || was == -1, now < was ? "the list shrank to " + now : "the list did not shrink");
      } catch (Throwable t) {
        report("deleteProduct", false, "threw " + root(t));
      }
    }

    if (clearAll == null) report("clearProducts", false, "no clearAll method on the service");
    else {
      try {
        if (add != null) add.invoke(instance, argsFor(add, null));
        clearAll.invoke(instance);
        int now = findAll == null ? -1 : sizeOf(findAll.invoke(instance));
        report("clearProducts", now == 0, now == 0 ? "the list is empty" : "the list still holds " + now);
      } catch (Throwable t) {
        report("clearProducts", false, "threw " + root(t));
      }
    }

    System.out.print(out);
  }

  static Object buildRepository(Class<?> type, Path data) {
    for (String name : new String[] { "com.pos.app.repository.FileProductRepository", "com.pos.app.repository.InMemoryProductRepository" }) {
      try {
        Class<?> impl = Class.forName(name);
        if (!type.isAssignableFrom(impl)) continue;
        for (Constructor<?> constructor : impl.getConstructors()) {
          try {
            Class<?>[] types = constructor.getParameterTypes();
            Object[] args = new Object[types.length];
            for (int i = 0; i < types.length; i++) {
              if (types[i] == String.class) args[i] = data.resolve("products.dat").toString();
              else if (types[i] == java.io.File.class) args[i] = data.resolve("products.dat").toFile();
              else if (types[i] == Path.class) args[i] = data.resolve("products.dat");
              else args[i] = null;
            }
            return constructor.newInstance(args);
          } catch (Throwable ignored) {
            // Next constructor.
          }
        }
      } catch (Throwable ignored) {
        // Next implementation.
      }
    }
    return null;
  }

  /** The id of the product just added, however the service chose to hand it back. */
  static Object idOf(Object added, Object instance, Method findAll) {
    Object subject = added;
    if (subject == null && findAll != null) {
      try {
        Object all = findAll.invoke(instance);
        if (all instanceof Collection && !((Collection<?>) all).isEmpty()) subject = ((Collection<?>) all).iterator().next();
      } catch (Throwable ignored) {
        return null;
      }
    }
    if (subject == null) return null;
    if (subject instanceof String || subject instanceof Number) return subject;
    Method getter = find(subject.getClass(), "getId", "id");
    if (getter == null) return null;
    try {
      return getter.invoke(subject);
    } catch (Throwable ignored) {
      return null;
    }
  }

  static Object[] coerce(Method method, Object id) {
    Class<?>[] types = method.getParameterTypes();
    Object[] args = new Object[types.length];
    for (int i = 0; i < types.length; i++) args[i] = i == 0 ? convert(types[0], id) : sample(types[i], i + 1);
    return args;
  }

  static Object[] stockArgs(Method method, Object id, int delta) {
    Class<?>[] types = method.getParameterTypes();
    Object[] args = new Object[types.length];
    for (int i = 0; i < types.length; i++) {
      if (i == 0) args[i] = convert(types[0], id);
      else if (types[i] == int.class || types[i] == Integer.class) args[i] = delta;
      else args[i] = sample(types[i], i + 1);
    }
    return args;
  }

  static Object convert(Class<?> type, Object value) {
    if (value == null) return null;
    if (type.isInstance(value)) return value;
    if (type == String.class) return String.valueOf(value);
    if ((type == int.class || type == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((type == long.class || type == Long.class) && value instanceof Number) return ((Number) value).longValue();
    return value;
  }

  static String root(Throwable t) {
    Throwable cause = t;
    while (cause.getCause() != null) cause = cause.getCause();
    String message = cause.getMessage();
    return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message.replace('\\n', ' '));
  }
}
`;

/**
 * Compile and run the driver against a built project.
 *
 * @param {string} appPath  The Maven project directory.
 * @returns {Promise<object>}
 */
async function probeJavaService(appPath) {
  const blank = {
    ran: false,
    reason: '',
    features: {},
    passed: 0,
    total: JAVA_FEATURES.length,
    consoleErrors: [],
    pageErrors: [],
  };

  const classes = path.join(appPath, 'target', 'classes');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path built from the caller's own workspace.
  if (!fs.existsSync(classes)) return { ...blank, reason: 'no target/classes — nothing was compiled to probe' };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a temp dir this process made.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-javaprobe-'));
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir.
    fs.writeFileSync(path.join(work, 'HirayaPosProbe.java'), DRIVER);

    const compiled = run(['javac', '-cp', classes, '-d', work, path.join(work, 'HirayaPosProbe.java')], work);
    if (!compiled.ok) {
      return { ...blank, reason: 'the probe itself did not compile: ' + (compiled.stderr || '').slice(0, 400) };
    }

    const separator = process.platform === 'win32' ? ';' : ':';
    const executed = run(['java', '-cp', classes + separator + work, 'HirayaPosProbe'], work);

    /** @type {Record<string, {ok: boolean, detail: string}>} */
    const features = {};
    for (const line of executed.stdout.split(/\r?\n/)) {
      const match = /^FEATURE (\S+) (ok|fail) ?(.*)$/.exec(line);
      if (match) features[match[1]] = { ok: match[2] === 'ok', detail: match[3] };
    }
    for (const name of JAVA_FEATURES) {
      if (!features[name]) features[name] = { ok: false, detail: 'not reached — the probe stopped before this' };
    }

    return {
      ran: Object.keys(features).length > 0,
      reason: executed.ok ? '' : (executed.stderr || '').slice(0, 400),
      features,
      passed: JAVA_FEATURES.filter((name) => features[name] && features[name].ok).length,
      total: JAVA_FEATURES.length,
      consoleErrors: [],
      pageErrors: executed.ok ? [] : [(executed.stderr || '').slice(0, 400)],
    };
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir.
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { probeJavaService, JAVA_FEATURES, DRIVER };
