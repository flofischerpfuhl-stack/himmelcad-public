/**
 * The desktop renderer's UI composition (assembler/MODULES.md §3): the
 * modules' panels and other UI parts, installed after `composition.ts` and
 * only here — the headless CLI and the tests run without a DOM.
 */
import { installModuleUis } from '../foundation/commands/module.js';
import { shellUi } from '../interface/shell-ui/module.ui.js';
import { parametersUi } from '../modules/parameters/module.ui.js';

installModuleUis([parametersUi, shellUi]);
