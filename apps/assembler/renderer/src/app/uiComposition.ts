/**
 * The desktop renderer's UI composition (assembler/MODULES.md §3): the
 * modules' panels and other UI parts, installed after `composition.ts` and
 * only here — the headless CLI and the tests run without a DOM.
 */

import { installModuleUis } from '../platform/widgets/moduleUi.js';
import { shellUi } from '../interface/shell-ui/module.ui.js';
import { parametersUi } from '../modules/parameters/module.ui.js';
import { printUi } from '../modules/print/module.ui.js';
import { printersUi } from '../modules/printers/module.ui.js';

installModuleUis([parametersUi, printUi, printersUi, shellUi]);
