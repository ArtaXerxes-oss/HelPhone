// Security Surface Reduction Report for third-party code.
//
// The bundler (rolldown) already traces the call graph and tree-shakes unused
// exports; this plugin records what that pruning removed from node_modules and
// emits dist/security-surface-report.json: bytes and exported functions that
// never reach the shipped bundle, per package.
//
// Note: reports rolldown's own tree-shaking rather than running a second
// AST pruner — a hand-rolled pruner can drop side-effectful code and break the
// app. Add `treeshake.moduleSideEffects` tuning if the report shows fat packages.

export function packageName(id) {
  const rest = id.split("node_modules/").pop();
  const parts = rest.split("/");
  return rest.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Pure aggregation, exported for tests. `modules` = [{ id, originalBytes, renderedBytes, exports, renderedExports }] */
export function buildReport(modules) {
  const packages = new Map();
  const totals = {
    modules: 0,
    originalBytes: 0,
    renderedBytes: 0,
    removedBytes: 0,
    removedExports: 0,
  };
  for (const m of modules) {
    if (!m.id.includes("node_modules/")) continue;
    const name = packageName(m.id);
    const pkg = packages.get(name) ?? {
      package: name,
      originalBytes: 0,
      removedBytes: 0,
      removedExports: [],
    };
    const kept = new Set(m.renderedExports);
    const removedExports = m.exports.filter((e) => !kept.has(e));
    const removedBytes = Math.max(0, m.originalBytes - m.renderedBytes);
    pkg.originalBytes += m.originalBytes;
    pkg.removedBytes += removedBytes;
    pkg.removedExports.push(
      ...removedExports.map((e) => `${m.id.split("node_modules/").pop()}#${e}`),
    );
    packages.set(name, pkg);
    totals.modules++;
    totals.originalBytes += m.originalBytes;
    totals.renderedBytes += m.renderedBytes;
    totals.removedBytes += removedBytes;
    totals.removedExports += removedExports.length;
  }
  return {
    totals,
    packages: [...packages.values()].sort(
      (a, b) => b.removedBytes - a.removedBytes,
    ),
  };
}

export default function deadcodePruner({
  fileName = "security-surface-report.json",
} = {}) {
  return {
    name: "deadcode-pruner",
    apply: "build",
    generateBundle(_options, bundle) {
      const rendered = new Map();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, m] of Object.entries(chunk.modules))
          rendered.set(id, m);
      }
      const modules = [];
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info?.code) continue;
        const r = rendered.get(id); // absent = module fully tree-shaken
        modules.push({
          id,
          originalBytes: info.code.length,
          renderedBytes: r?.renderedLength ?? 0,
          exports: info.exports ?? [],
          renderedExports: r?.renderedExports ?? [],
        });
      }
      const report = buildReport(modules);
      this.emitFile({
        type: "asset",
        fileName,
        source: JSON.stringify(report, null, 2),
      });
      const { totals } = report;
      this.info?.(
        `security surface: removed ${totals.removedBytes} of ${totals.originalBytes} bytes and ${totals.removedExports} exports across ${report.packages.length} packages`,
      );
    },
  };
}
