/**
 * Preloaded before every test, fuzz and bench entry (`node --import`, see
 * `package.json`): the product's module composition, so the feature kinds,
 * commands and API methods the modules register exist in every test
 * process exactly as in the app (assembler/MODULES.md §3).
 */
import '../renderer/src/app/composition.js';
import '../renderer/src/app/kernelModules.js';
